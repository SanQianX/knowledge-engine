'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCommitPrompt } = require('../src/runtime/commit-prompt');
const { sha256 } = require('../src/runtime/conversation-store');
test('the maintenance model receives the exact source hash it must attest', () => {
  const content = '今后所有项目统一采用中文错误文案。';
  const hash = sha256(content);
  const snapshot = { turns: [{ turnId: 't', source: 'claude-code', sessionId: 's', bindingKind: 'direct',
    userEvents: [{ eventId: 'human-event', content, contentHash: hash, inputOrigin: 'human', capturedAt: '2026-10-16T00:00:00.000Z' }], assistantEvents: [] }] };
  const { prompt } = renderCommitPrompt({ conversationSnapshot: snapshot, evidence: {} });
  assert.ok(prompt.includes(hash), 'the producer cannot reliably attest a hash omitted from its frozen evidence prompt');
});
