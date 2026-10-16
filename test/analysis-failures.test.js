'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAnalysisFailure, analysisFailure } = require('../src/analysis-failures');

test('billing, rate limits and authentication retain distinct safe recovery reasons', () => {
  const secret = 'provider-credential-must-not-leave-worker';
  for (const input of ['billing_error', { error: { type: 'insufficient_quota', message: secret } }, { cause: { code: 'quota_exceeded', message: secret } }]) {
    const code = classifyAnalysisFailure(input);
    const failure = analysisFailure(code);
    assert.equal(code, 'MODEL_QUOTA_EXHAUSTED');
    assert.match(failure.message, /额度|余额/);
    assert.equal(failure.retryable, true);
    assert.ok(!JSON.stringify(failure).includes(secret));
  }
  assert.equal(classifyAnalysisFailure('rate_limit'), 'MODEL_RATE_LIMITED');
  assert.equal(classifyAnalysisFailure({ status: 429 }), 'MODEL_RATE_LIMITED', 'HTTP 429 alone cannot prove exhausted balance');
  assert.equal(classifyAnalysisFailure({ status: 429, error: { type: 'insufficient_quota' } }), 'MODEL_QUOTA_EXHAUSTED');
  assert.equal(classifyAnalysisFailure('authentication_failed'), 'MODEL_AUTH_FAILED');
  assert.equal(classifyAnalysisFailure({ code: 'MODULE_NOT_FOUND' }), 'AI_RUNTIME_REQUIRED');
  assert.equal(classifyAnalysisFailure({ code: 'ANALYSIS_OUTPUT_MISSING' }), 'ANALYSIS_OUTPUT_MISSING');
  assert.equal(classifyAnalysisFailure({ message: secret }), 'MODEL_FAILED');
  assert.equal(analysisFailure(secret).code, 'MODEL_FAILED', 'unknown IPC codes cannot be reflected into persisted state');
});
