'use strict';
const http = require('node:http');

// Backup copies can block the event loop long enough to invalidate a pooled
// keep-alive connection. Each health snapshot uses a new, bounded connection.
function localHealthSnapshot(url, timeoutMs = 15000) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('LOCAL_HEALTH_URL_REQUIRED');
  return new Promise((resolve, reject) => {
    const request = http.get(target, { agent: false, headers: { Connection: 'close' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1048576) request.destroy(new Error('HEALTH_RESPONSE_TOO_LARGE'));
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HEALTH_HTTP_${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('HEALTH_INVALID_JSON')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('HEALTH_TIMEOUT')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
module.exports = { localHealthSnapshot };
