'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEvidence } = require('./support/formal-acceptance-report');
test('formal acceptance rejects missing, failed, wrong-version and unconfirmed manual evidence', () => {
  const input = { source: [{ label: 'source', passed: true }], installed: [{ label: 'installed', passed: true }], user: [{ label: 'user', passed: true }], manual: { selectionAndImport: 'passed', nativeCancellation: 'passed' }, globalBytes: { passed: true, version: '5.0.9' }, identity: { version: '5.0.9' }, version: '5.0.9' };
  assert.equal(evaluateEvidence(input).passed, true);
  assert.equal(evaluateEvidence({ ...input, installed: [] }).passed, false);
  assert.equal(evaluateEvidence({ ...input, user: [{ label: 'user', passed: false }] }).passed, false);
  assert.equal(evaluateEvidence({ ...input, manual: { ...input.manual, nativeCancellation: 'awaiting-explicit-confirmation' } }).passed, false);
  assert.equal(evaluateEvidence({ ...input, identity: { version: '5.0.9-rc.19' } }).passed, false);
  assert.equal(evaluateEvidence({ ...input, globalBytes: { passed: true, version: '5.0.8' } }).passed, false);
});
