const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const TIMELINE_MAX = 15;
const FILES_MAX = 8;
// Transcripts reach 20MB+; on first read only the tail matters for "what is it doing now".
const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function describeTool(name, input = {}) {
  const base = p => (p ? path.basename(String(p)) : 'a file');
  switch (name) {
    case 'Bash':
    case 'PowerShell': return input.description ? clip(input.description, 80) : `Run ${clip(input.command, 70)}`;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return `Edit ${base(input.file_path || input.notebook_path)}`;
    case 'Read': return `Read ${base(input.file_path)}`;
    case 'Grep':
    case 'Glob': return `Search for ${clip(input.pattern, 60)}`;
    case 'Agent':
    case 'Task': return `Sub-agent: ${clip(input.description, 60)}`;
    case 'WebFetch': return `Fetch ${clip(input.url, 80)}`;
    case 'WebSearch': return `Search the web for ${clip(input.query, 60)}`;
    case 'Skill': return `Use the ${input.skill} skill`;
    case 'AskUserQuestion': return `Ask you: ${clip(input.questions?.[0]?.question, 140)}`;
    case 'ExitPlanMode': return 'Present a plan for approval';
    default: return `Use ${name}`;
  }
}

// The exact thing being approved, shown verbatim in the "waiting on you" box.
function toolDetail(name, input = {}) {
  return input.command || input.file_path || input.notebook_path || input.url || input.pattern
    || input.questions?.[0]?.question || null;
}

function emptyState() {
  return {
    title: null, lastPrompt: null, branch: null, model: null,
    contextTokens: 0, outputTokens: 0, outputById: new Map(),
    todos: [], files: [], timeline: [], lastText: null,
    pending: new Map(), lastActivity: 0,
  };
}

function pushTimeline(s, t, msg) {
  s.timeline.push({ t, msg });
  if (s.timeline.length > TIMELINE_MAX) s.timeline.shift();
}

function applyAssistant(s, o, t) {
  const m = o.message || {};
  if (m.model && !m.model.startsWith('<')) s.model = m.model;
  const u = m.usage;
  if (u) {
    s.contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    // One API message is logged as several lines sharing an id; count its output once, using the latest value.
    if (m.id) {
      s.outputTokens += (u.output_tokens || 0) - (s.outputById.get(m.id) || 0);
      s.outputById.set(m.id, u.output_tokens || 0);
    }
  }
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c.type === 'text' && c.text?.trim()) s.lastText = c.text.trim();
    if (c.type !== 'tool_use') continue;
    const input = c.input || {};
    s.pending.set(c.id, { name: c.name, input });
    pushTimeline(s, t, describeTool(c.name, input));
    if (EDIT_TOOLS.has(c.name)) {
      const f = path.basename(String(input.file_path || input.notebook_path || ''));
      if (f) s.files = [f, ...s.files.filter(x => x !== f)].slice(0, FILES_MAX);
    }
    if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
      s.todos = input.todos.map(x => ({ text: x.content, status: x.status }));
    } else if (c.name === 'TaskCreate' && input.subject) {
      s.todos.push({ id: String(s.todos.length + 1), text: input.subject, status: 'pending' });
    } else if (c.name === 'TaskUpdate') {
      const task = s.todos.find(x => x.id === String(input.taskId));
      if (task && input.status) task.status = input.status;
    }
  }
}

function applyUser(s, o, t) {
  if (o.isMeta) return;
  const content = o.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  for (const b of blocks) {
    if (b.type === 'tool_result') { s.pending.delete(b.tool_use_id); continue; }
    if (b.type !== 'text' || !b.text?.trim()) continue;
    const text = b.text.trim();
    const cmd = text.match(/^<command-name>(.*?)<\/command-name>/);
    if (!cmd && text.startsWith('<')) continue; // harness markup, not something the user typed
    // A fresh prompt means anything still "pending" was interrupted.
    s.pending.clear();
    if (!cmd) s.lastPrompt = text;
    pushTimeline(s, t, cmd ? `You ran ${cmd[1]}` : `You: ${clip(text, 90)}`);
  }
}

function applyEntry(s, o) {
  if (o.isSidechain) return;
  const t = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (t > s.lastActivity) s.lastActivity = t;
  if (o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch;
  if (o.type === 'ai-title' && o.aiTitle) s.title = o.aiTitle;
  else if (o.type === 'last-prompt' && o.lastPrompt) s.lastPrompt = o.lastPrompt;
  else if (o.type === 'assistant') applyAssistant(s, o, t);
  else if (o.type === 'user') applyUser(s, o, t);
}

// Reads only bytes appended since the last call; resets if the file was truncated or replaced.
class TranscriptReader {
  constructor(file) {
    this.file = file;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.rest = '';
    this.skipPartial = false;
    this.decoder = new StringDecoder('utf8');
    this.state = emptyState();
  }

  update() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return this.state;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return this.state;
    if (this.offset === 0 && size > INITIAL_TAIL_BYTES) {
      this.offset = size - INITIAL_TAIL_BYTES;
      this.skipPartial = true;
    }
    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const lines = (this.rest + this.decoder.write(buf)).split('\n');
    this.rest = lines.pop();
    if (this.skipPartial) { lines.shift(); this.skipPartial = false; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      applyEntry(this.state, o);
    }
    return this.state;
  }
}

const slug = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function findTranscript(home, sessionId, cwd) {
  const projects = path.join(home, 'projects');
  const direct = path.join(projects, slug(cwd || ''), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { TranscriptReader, findTranscript, describeTool, toolDetail, clip, emptyState, applyEntry };
