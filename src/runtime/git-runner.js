// Shared git runner used by server.js, context-pack-builder.js, and tests.
// Wraps spawn() with a hard timeout and returns { ok, code, stdout, stderr, error }.

const { spawn } = require('child_process');
const fs = require('fs');

function execGit(cwd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: 'missing path', error: 'missing path' });
    }
    const child = spawn('git', args, { cwd, windowsHide: true, timeout: timeoutMs });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', d => outChunks.push(Buffer.from(d)));
    child.stderr.on('data', d => errChunks.push(Buffer.from(d)));
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', e => {
      clearTimeout(killer);
      const stdoutBuffer = Buffer.concat(outChunks);
      const stderrBuffer = Buffer.concat(errChunks);
      resolve({ ok: false, code: -1, stdout: stdoutBuffer.toString('utf8'), stdoutBuffer, stderr: stderrBuffer.toString('utf8'), stderrBuffer, error: e.message });
    });
    child.on('close', code => {
      clearTimeout(killer);
      const stdoutBuffer = Buffer.concat(outChunks);
      const stderrBuffer = Buffer.concat(errChunks);
      resolve({ ok: code === 0 && !timedOut, code, stdout: stdoutBuffer.toString('utf8'), stdoutBuffer, stderr: stderrBuffer.toString('utf8'), stderrBuffer, error: timedOut ? 'timeout' : null });
    });
  });
}

let _cachedGitVersion = null;
async function getGitVersion() {
  if (_cachedGitVersion !== null) return _cachedGitVersion;
  try {
    const r = await execGit(process.cwd(), ['--version'], 5000);
    if (!r || !r.ok) {
      return _cachedGitVersion = { ok: false, major: 0, minor: 0, raw: '' };
    }
    const raw = String(r.stdout || '').trim();
    const m = raw.match(/(\d+)\.(\d+)/);
    if (!m) return _cachedGitVersion = { ok: false, major: 0, minor: 0, raw };
    return _cachedGitVersion = { ok: true, major: Number(m[1]), minor: Number(m[2]), raw };
  } catch (_) {
    return _cachedGitVersion = { ok: false, major: 0, minor: 0, raw: '' };
  }
}
function _resetGitVersionCache() {
  _cachedGitVersion = null;
}

function _setGitVersionForTests(value) {
  if (value === null || value === undefined) {
    _cachedGitVersion = null;
    return;
  }
  _cachedGitVersion = value;
}

module.exports = { execGit, getGitVersion, _resetGitVersionCache, _setGitVersionForTests };
