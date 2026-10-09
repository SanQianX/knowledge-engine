const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DomainError } = require('./contracts');

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 120_000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

function canBreakStaleLock(lockPath, staleMs) {
  let stat;
  try { stat = fs.statSync(lockPath); } catch { return false; }
  const owner = readLockOwner(lockPath);
  // A complete owner record lets us recover immediately after a process
  // crash. The age threshold is only needed for an incomplete/unreadable
  // file that another process may still be creating.
  if (owner && Number.isInteger(Number(owner.pid))) return !isProcessAlive(Number(owner.pid));
  return (Date.now() - stat.mtimeMs) >= staleMs;
}

async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_LOCK_MS;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 25;
  const started = Date.now();
  const nonce = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce };
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return async function release() {
        const current = readLockOwner(lockPath);
        if (!current || current.nonce !== nonce) return;
        try { fs.unlinkSync(lockPath); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (canBreakStaleLock(lockPath, staleMs)) {
        try { fs.unlinkSync(lockPath); continue; } catch (unlinkError) {
          // A competing process may recover the same stale lock first; retry through the normal wait path.
        }
      }
      if ((Date.now() - started) >= timeoutMs) {
        throw new DomainError('PROJECT_BUSY', 'Timed out waiting for a file lock.', {
          status: 409,
          retryable: true,
          details: { lockCategory: path.basename(lockPath) },
        });
      }
      await delay(retryMs);
    }
  }
}

async function withFileLock(lockPath, fn, options = {}) {
  const release = await acquireFileLock(lockPath, options);
  try { return await fn(); } finally { await release(); }
}

function syncDirectoryBestEffort(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some filesystems; the file replace is already durable.
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {
      // Closing a best-effort directory descriptor cannot invalidate the completed file replace.
    }
  }
}

function replaceWithRetry(tempPath, targetPath, options = {}) {
  const retries = Number.isInteger(options.renameRetries) ? options.renameRetries : 8;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code) || attempt === retries) break;
      Atomics.wait(waitBuffer, 0, 0, Math.min(250, 10 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function writeFileAtomic(filePath, content, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', options.mode || 0o600);
    fs.writeFileSync(fd, content, options.encoding || 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (typeof options.beforeRename === 'function') options.beforeRename(tempPath, filePath);
    replaceWithRetry(tempPath, filePath, options);
    syncDirectoryBestEffort(directory);
    return { path: filePath };
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {
      // Preserve the original write error.
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {
      // Preserve the original write error; stale temp files are never treated as live data.
    }
    throw error;
  }
}

function writeJsonAtomic(filePath, value, options = {}) {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function readJsonStrict(filePath, options = {}) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT' && options.allowMissing) return options.defaultValue;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof options.validate === 'function') options.validate(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('DATA_CORRUPT', 'A JSON data file is corrupt.', {
      status: 500,
      cause: error,
      details: { category: options.category || 'json' },
    });
  }
}

async function appendJsonlLocked(filePath, value, options = {}) {
  const lockPath = options.lockPath || `${filePath}.lock`;
  return withFileLock(lockPath, async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'a', options.mode || 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return value;
  }, options);
}

function cleanupStaleTemps(directory, options = {}) {
  if (!fs.existsSync(directory)) return [];
  const olderThanMs = Number.isFinite(options.olderThanMs) ? options.olderThanMs : 24 * 60 * 60 * 1000;
  const now = Date.now();
  const removed = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\..+\.\d+\.\d+\.[a-f0-9]+\.tmp$/i.test(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const stat = fs.statSync(absolute);
    if ((now - stat.mtimeMs) < olderThanMs) continue;
    fs.unlinkSync(absolute);
    removed.push(absolute);
  }
  return removed;
}

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  acquireFileLock,
  withFileLock,
  writeFileAtomic,
  writeJsonAtomic,
  readJsonStrict,
  appendJsonlLocked,
  cleanupStaleTemps,
};
