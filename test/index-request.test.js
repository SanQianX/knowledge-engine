'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestIndex } = require('../src/index-request');
const { createDiagnostics } = require('../src/diagnostics');

const sanitize = createDiagnostics({ secrets: () => ['credential-marker-123'] }).sanitize;
const invoke = (fetchImpl, extra = {}) => requestIndex({ baseUrl: 'http://127.0.0.1:8787', route: '/api/sync', body: { project: 'project-a', sourceDir: 'knowledge' }, attempt: 2, sanitize, fetchImpl, ...extra });

test('index errors preserve classified, bounded, redacted upstream evidence', async () => {
  const cases = [
    { kind: 'HTTP_ERROR', status: 401, code: 'AUTH_INVALID', message: 'profile apiKey="credential-marker-123"', response: { ok: false, error: { code: 'AUTH_INVALID', message: 'profile apiKey="credential-marker-123"' } } },
    { kind: 'HTTP_ERROR', status: 429, code: 'RATE_LIMIT', message: 'try later', response: { error: { code: 'RATE_LIMIT', message: 'try later' } } },
    { kind: 'HTTP_ERROR', status: 503, code: 'HTTP_503', message: 'embedding unavailable', response: { error: 'embedding unavailable' } },
    { kind: 'UPSTREAM_ERROR', status: 200, code: 'VECTOR_FAILED', message: 'failed to embed', response: { ok: false, error: { code: 'VECTOR_FAILED', message: 'failed to embed' } } },
  ];
  for (const item of cases) await assert.rejects(invoke(async () => new Response(JSON.stringify(item.response), { status: item.status, headers: { 'x-request-id': 'req-index-2' } })), error => {
    assert.equal(error.code, 'INDEX_FAILED'); assert.equal(error.details.failureKind, item.kind);
    assert.equal(error.details.httpStatus, item.status); assert.equal(error.details.upstreamCode, item.code);
    assert.equal(error.details.upstreamMessage, sanitize(item.message)); assert.equal(error.details.requestId, 'req-index-2');
    assert.equal(error.details.attempt, 2); assert.ok(error.details.durationMs >= 0);
    assert.ok(!JSON.stringify(error.details).includes('credential-marker-123')); return true;
  });
});

test('network, timeout, malformed and oversized responses are distinct failures', async () => {
  await assert.rejects(invoke(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }), error => error.details.failureKind === 'NETWORK_ERROR' && error.details.upstreamCode === 'ECONNREFUSED');
  await assert.rejects(invoke(async () => { throw Object.assign(new Error('expired'), { name: 'TimeoutError' }); }), error => error.details.failureKind === 'TIMEOUT');
  for (const response of [new Response('<html>Bearer private-secret</html>', { status: 502 }), new Response('x'.repeat(65536)), new Response('{"results":[]}')]) {
    await assert.rejects(invoke(async () => response), error => error.details.failureKind === 'INVALID_RESPONSE' && !JSON.stringify(error.details).includes('private-secret'));
  }
  const payload = await invoke(async () => new Response('{"ok":true,"filesTracked":2}'));
  assert.equal(payload.filesTracked, 2);
});

test('structured and URL credential syntax never reaches diagnostic text', () => {
  const text = sanitize('apiKey="credential-marker-123" {"token":"private-token"} https://u:p@local/api?api_key=private-url&x=1 Authorization: Bearer private-bearer');
  for (const value of ['credential-marker-123', 'private-token', 'private-url', 'private-bearer', 'u:p@']) assert.ok(!text.includes(value));
});
