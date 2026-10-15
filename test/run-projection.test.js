'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EngineStore } = require('../src/store');
const { EngineCoordinator } = require('../src/coordinator');
test('1000-run projection is bounded, stable and does not transport frozen evidence', () => {
  const store = new EngineStore('not-used', { deferLoad: true });
  store.state.runs = Array.from({ length: 1000 }, (_, i) => ({ runId: `run-${i + 1}`, sequence: i + 1, projectId: i % 2 ? 'a' : 'b', state: 'succeeded', staging: { evidence: 'x'.repeat(10000) }, evidence: 'must-not-leak' }));
  const first = store.listRunPage({ projectId: 'a', limit: 50 });
  assert.equal(first.runs.length, 50); assert.equal(first.total, 500); assert.equal(first.runs[0].sequence, 1000);
  assert(!JSON.stringify(first).includes('must-not-leak')); assert(!JSON.stringify(first).includes('staging')); assert(JSON.stringify(first).length < 10000);
  const seen = new Set(); let page = first;
  do { for (const run of page.runs) { assert(!seen.has(run.runId)); seen.add(run.runId); } page = page.nextCursor ? store.listRunPage({ projectId: 'a', limit: 50, before: page.nextCursor }) : null; } while (page);
  assert.equal(seen.size, 500);
  assert.throws(() => store.listRunPage({ limit: 10001 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => store.listRunPage({ before: '../' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(store.getRun('run-1').evidence, 'must-not-leak', 'detail reads retain their original evidence');
});
test('managed activation grants only safely wired projects, including recovery and retry', async () => {
  const recovered = [], retried = [];
  const coordinator = Object.assign(Object.create(EngineCoordinator.prototype), {
    ready: Promise.resolve(), executionEnabled: false, consume: false, poll: {},
    promotion: { recoverAll: async allowed => recovered.push([...allowed]) },
    drain: async () => {}, pump() {}, retry: id => retried.push(id),
    store: { state: { runs: [{ projectId: 'good', runId: 'index-good', state: 'index-pending' }, { projectId: 'bad', runId: 'index-bad', state: 'index-pending' }] } },
  });
  await coordinator.activate(['good']);
  assert.deepEqual(recovered, [['good']]); assert.deepEqual(retried, ['index-good']);
  await coordinator.activate(['good']); assert.equal(recovered.length, 1);
  await coordinator.activate(['good', 'bad']); assert.deepEqual(recovered[1], ['bad']); assert(coordinator.allowedProjects.has('bad'));
});
test('an unwired project remains queued while a wired project executes', async () => {
  const runs = [{ projectId: 'bad', runId: 'bad-run', state: 'queued', sequence: 1 }, { projectId: 'good', runId: 'good-run', state: 'queued', sequence: 2 }], executed = [];
  const coordinator = Object.assign(Object.create(EngineCoordinator.prototype), {
    allowedProjects: new Set(['good']), executionEnabled: true, concurrency: 2, active: new Map(), jobs: new Set(),
    store: { state: { runs } }, execute: async run => { executed.push(run.projectId); run.state = 'succeeded'; },
  });
  coordinator.pump(); await Promise.all([...coordinator.jobs]);
  assert.deepEqual(executed, ['good']); assert.equal(runs[0].state, 'queued');
});
