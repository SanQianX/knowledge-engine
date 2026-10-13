'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify, assertInactive } = require('./support/existing-v5-audit');
const failed = { runId: 'failed', projectId: 'a', sequence: 1, state: 'failed', phase: 'failed', indexState: 'pending' };
const queued = { runId: 'queued', projectId: 'a', sequence: 2, state: 'queued', phase: 'waiting-previous', indexState: 'pending' };
const baseline = { dataDir: 'same', projects: [], protectedFiles: [], historyFiles: [], runs: [failed, queued] };
test('explicit blocked upgrade preserves failed and FIFO queued records without clearing them', () => {
  verify(baseline, structuredClone(baseline), { frozen: true, allowBlocked: true });
  assert.throws(() => verify(baseline, baseline, { frozen: true }), /fully indexed/);
  const lost = structuredClone(baseline); lost.runs.pop();
  assert.throws(() => verify(baseline, lost, { frozen: true, allowBlocked: true }), /history must remain/);
  const replayed = structuredClone(baseline); replayed.runs[0].state = 'succeeded';
  assert.throws(() => verify(baseline, replayed, { frozen: true, allowBlocked: true }), /replayed or discarded/);
});
test('blocked upgrade refuses active, unblocked and other-project maintenance', () => {
  for (const state of ['running', 'index-pending', 'starting']) assert.throws(() => assertInactive([{ ...failed, state }], true), /never interrupt/);
  assert.throws(() => assertInactive([{ ...queued, phase: 'queued' }], true), /only a queue blocked/);
  assert.throws(() => assertInactive([failed, { ...queued, projectId: 'b' }], true), /failed predecessor/);
  assert.throws(() => assertInactive([failed, { ...queued, sequence: 0 }], true), /failed predecessor/);
});
