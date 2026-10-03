const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ err, stdout: stdout || '' })));
}

// PIDs get reused, so confirm what is actually running there before killing it.
async function imageName(pid) {
  if (isWin) {
    const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = stdout.match(/^"([^"]+)","(\d+)"/m);
    return m && Number(m[2]) === pid ? m[1] : null;
  }
  const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm=']);
  return stdout.trim() || null;
}

async function killTree(pid) {
  if (isWin) {
    const { err } = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (err) throw new Error(`taskkill failed for PID ${pid}: ${err.message}`);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

function openFolder(dir) {
  // explorer.exe exits 1 even on success, so the result is deliberately ignored.
  const cmd = isWin ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return run(cmd, [dir]).then(() => undefined);
}

module.exports = { imageName, killTree, openFolder };
