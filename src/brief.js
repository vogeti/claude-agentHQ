const { describeTool, toolDetail, clip } = require('./transcript');

function lastPending(t) {
  const all = [...t.pending.values()];
  return all[all.length - 1] || null;
}

// First-person status line for the speech bubble; `quote` is the agent's own last message.
function buildBrief(state, waitingFor, t) {
  const topic = t.title || (t.lastPrompt && clip(t.lastPrompt, 80)) || 'your request';
  const p = lastPending(t);
  const pendingTool = p ? { summary: describeTool(p.name, p.input), detail: toolDetail(p.name, p.input) } : null;
  let headline;

  if (state === 'attention') {
    if (waitingFor === 'permission prompt') {
      headline = pendingTool ? `I need your permission for: ${pendingTool.summary}.` : 'I need your permission to continue.';
    } else if (p?.name === 'AskUserQuestion') {
      headline = `I have a question for you: ${clip(p.input.questions?.[0]?.question, 200)}`;
    } else if (p?.name === 'ExitPlanMode') {
      headline = 'I have a plan ready and need your approval.';
    } else if (waitingFor && waitingFor !== 'input needed') {
      headline = `Something in my terminal needs you (${waitingFor}).`;
    } else {
      headline = 'I need your input before I can continue.';
    }
    headline = `I'm on "${topic}". ${headline}`;
  } else if (state === 'working') {
    headline = pendingTool ? `I'm working on "${topic}". Current step: ${pendingTool.summary}.`
      : `I'm working on "${topic}" and thinking through the next step.`;
  } else {
    headline = t.lastText ? `I've finished "${topic}" and I'm waiting for your next instruction.`
      : "I'm open, but nothing has been asked yet.";
  }

  return { headline, quote: t.lastText ? clip(t.lastText, 500) : null, pendingTool };
}

module.exports = { buildBrief };
