'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { localHealthSnapshot } = require('./support/local-health-snapshot');

test('backup health snapshots use independent connections and reject invalid responses', async () => {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    sockets.add(request.socket);
    assert.equal(request.headers.connection, 'close');
    if (request.url === '/bad') return response.end('not JSON');
    if (request.url === '/offline') { response.statusCode = 503; return response.end('{}'); }
    response.end('{"counts":{"running":0}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await localHealthSnapshot(base + '/')).counts.running, 0);
    assert.equal((await localHealthSnapshot(base + '/')).counts.running, 0);
    assert.equal(sockets.size, 2);
    await assert.rejects(localHealthSnapshot(base + '/bad'), /INVALID_JSON/);
    await assert.rejects(localHealthSnapshot(base + '/offline'), /HTTP_503/);
    assert.throws(() => localHealthSnapshot('https://example.com'), /LOCAL_HEALTH_URL_REQUIRED/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('backup health snapshots enforce an absolute timeout', async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(localHealthSnapshot(`http://127.0.0.1:${server.address().port}`, 30), /HEALTH_TIMEOUT/); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
