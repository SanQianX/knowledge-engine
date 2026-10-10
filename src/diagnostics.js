'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The supervisor owns product logs. IPC keeps modules independent of its
// logger implementation; standalone modules keep the same record locally.
function createDiagnostics({ dataDir, component = 'knowledge-engine', secrets = () => [] } = {}) {
  const sanitize = value => {
    let text = String(value || '');
    let values = []; try { values = secrets() || []; } catch {}
    for (const secret of values) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@').replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [REDACTED]').replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(0, 8000);
  };
  const logger = { sanitize, close: async () => {} };
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = async (event, message, input = {}) => {
    const record = { schema: 'log/v2', id: `log-${crypto.randomUUID()}`, ts: new Date().toISOString(), component, level, event, message: sanitize(message) };
    for (const key of ['projectId', 'runId', 'operationId', 'commitSha', 'phase']) if (input[key]) record[key] = sanitize(input[key]);
    if (input.error) record.error = { name: input.error.name || 'Error', code: input.error.code || 'UNKNOWN', message: sanitize(input.error.message || input.error), stack: sanitize(input.error.stack) };
    if (input.context) record.context = JSON.parse(JSON.stringify(input.context, (key, value) => /key|token|password|secret|prompt|diff|body/i.test(key) ? '[REDACTED]' : typeof value === 'string' ? sanitize(value) : value));
    if (process.connected && process.send) {
      const delivered = await new Promise(resolve => {
        try { process.send({ type: 'kb:diagnostic', record }, error => resolve(!error)); } catch { resolve(false); }
      });
      if (delivered) return;
    }
    const projectId = /^project-[A-Za-z0-9._-]+$/.test(record.projectId || '') ? record.projectId : '';
    const directory = path.join(dataDir, 'logs', ...(projectId ? ['projects', projectId] : ['system']));
    try {
      fs.mkdirSync(directory, { recursive: true });
      const now = new Date(); const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      fs.appendFileSync(path.join(directory, `${date}.jsonl`), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { process.stderr.write(JSON.stringify(record) + '\n'); }
  };
  return logger;
}
module.exports = { createDiagnostics };
