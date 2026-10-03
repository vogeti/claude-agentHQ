const fs = require('fs');
const path = require('path');
const { toState, createRegistryReader, isAlive } = require('./registry');
const { TranscriptReader, findTranscript } = require('./transcript');
const { buildBrief } = require('./brief');
const processes = require('./processes');

const CLAUDE_IMAGE = /^(claude|node)(\.exe)?$/i;
const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

class SessionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The registry doesn't record the context size, so infer it from the configured model or observed usage.
function contextWindow(home, contextTokens) {
  if (contextTokens > STANDARD_WINDOW) return LARGE_WINDOW;
  try {
    const { model } = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    if (/\[1m\]/i.test(model || '')) return LARGE_WINDOW;
  } catch { /* no settings file is fine */ }
  return STANDARD_WINDOW;
}

function createSessionMonitor({ home, alive = isAlive, proc = processes }) {
  const readRegistry = createRegistryReader(home, alive);
  const readers = new Map();

  function transcriptFor(entry) {
    let r = readers.get(entry.sessionId);
    if (!r) {
      const file = findTranscript(home, entry.sessionId, entry.cwd);
      if (!file) return null;
      r = new TranscriptReader(file);
      readers.set(entry.sessionId, r);
    }
    return r.update();
  }

  function snapshot() {
    const entries = readRegistry();
    for (const id of readers.keys()) if (!entries.some(e => e.sessionId === id)) readers.delete(id);

    return entries.map(e => {
      const t = transcriptFor(e);
      const state = toState(e.status);
      const since = e.statusUpdatedAt || e.updatedAt || e.startedAt;
      const brief = t ? buildBrief(state, e.waitingFor, t) : { headline: "I've just started.", quote: null, pendingTool: null };
      return {
        id: e.sessionId,
        shortId: e.sessionId.slice(0, 8),
        pid: e.pid,
        name: e.name || e.sessionId.slice(0, 8),
        kind: e.kind || 'interactive',
        version: e.version,
        cwd: e.cwd,
        project: path.basename(e.cwd || '') || e.cwd,
        state,
        waitingFor: state === 'attention' ? e.waitingFor || 'input needed' : null,
        since,
        startedAt: e.startedAt,
        lastActivity: Math.max(since || 0, t?.lastActivity || 0),
        title: t?.title || null,
        lastPrompt: t?.lastPrompt || null,
        branch: t?.branch || null,
        model: t?.model || null,
        todos: t?.todos || [],
        files: t?.files || [],
        timeline: t?.timeline || [],
        brief,
        tokens: t ? { context: t.contextTokens, window: contextWindow(home, t.contextTokens), output: t.outputTokens } : null,
      };
    });
  }

  function find(sessionId) {
    const entry = readRegistry().find(e => e.sessionId === sessionId);
    if (!entry) throw new SessionError(404, 'Session is not running');
    return entry;
  }

  async function kill(sessionId) {
    const entry = find(sessionId);
    const image = await proc.imageName(entry.pid);
    if (!image || !CLAUDE_IMAGE.test(image)) {
      throw new SessionError(409, `PID ${entry.pid} is no longer a Claude process (found ${image || 'nothing'})`);
    }
    await proc.killTree(entry.pid);
    readers.delete(sessionId);
    return { killed: entry.pid };
  }

  async function openFolder(sessionId) {
    await proc.openFolder(find(sessionId).cwd);
  }

  return { snapshot, kill, openFolder };
}

module.exports = { createSessionMonitor, SessionError, contextWindow };
