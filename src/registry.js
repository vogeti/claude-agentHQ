const fs = require('fs');
const path = require('path');

// Claude Code itself keeps ~/.claude/sessions/<pid>.json current; `status` is busy | waiting | idle.
const STATE_BY_STATUS = { busy: 'working', waiting: 'attention', idle: 'idle' };

function toState(status) {
  return STATE_BY_STATUS[status] || 'idle';
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Claude rewrites these files constantly, so a read can land mid-write; fall back to the last good parse.
function createRegistryReader(home, alive = isAlive) {
  const dir = path.join(home, 'sessions');
  const lastGood = new Map();

  return function read() {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    for (const f of lastGood.keys()) if (!files.includes(f)) lastGood.delete(f);

    const bySession = new Map();
    for (const f of files) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        lastGood.set(f, entry);
      } catch {
        entry = lastGood.get(f);
      }
      if (!entry || !entry.sessionId || !Number.isInteger(entry.pid) || !alive(entry.pid)) continue;
      const prev = bySession.get(entry.sessionId);
      if (!prev || (entry.statusUpdatedAt || 0) > (prev.statusUpdatedAt || 0)) bySession.set(entry.sessionId, entry);
    }
    return [...bySession.values()];
  };
}

module.exports = { toState, isAlive, createRegistryReader };
