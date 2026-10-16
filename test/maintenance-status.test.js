'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineServer } = require('../src/server');

test('pre-queue journal faults are visible in snapshots and emit change receipts without idle refreshes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-maintenance-status-'));
  let broken = true;
  const bridge = {
    async registerConsumer() {}, async listJournals() { return [{ journalId: 'A' }, { journalId: 'B' }]; },
    async readEvents({ journalId }) { if (broken && journalId === 'A') return [{ schema: 'ai-coding-event/v1', sequence: 1, eventType: 'user_prompt', source: 'unsupported-client', content: 'private-content' }]; return []; },
    async ackConsumerCursor() {}, close() {},
  };
  const runtime = createEngineServer({ dataDir, managed: true, bridge });
  await runtime.ready;
  for (const id of ['A', 'B']) {
    const repoPath = path.join(dataDir, id), knowledgePath = path.join(dataDir, `knowledge-${id}`);
    fs.mkdirSync(repoPath); fs.mkdirSync(knowledgePath);
    runtime.store.addProject({ projectId: `project-${id}`, repoPath, knowledgePath, journalId: id });
  }
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const snapshot = async id => (await (await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/snapshot?summary=1&projectId=project-${id}`)).json());
  const changes = [];
  runtime.coordinator.on('progress', e => { if (e.type === 'knowledge.journal') changes.push(e); });
  try {
    await runtime.coordinator.drain();
    const affected = await snapshot('A'), unaffected = await snapshot('B');
    assert.equal(affected.runs.length, 0);
    assert.equal(affected.maintenance.journal.failures[0].code, 'INVALID_ARGUMENT');
    assert.equal(affected.maintenance.journal.failures[0].sequence, 1);
    assert.equal(affected.maintenance.journal.error !== null, true);
    assert.equal(unaffected.maintenance.journal.error, null);
    assert.equal(unaffected.maintenance.projectId, 'project-B');
    assert.equal((await snapshot('missing')).maintenance.executionEnabled, false, 'an unwired project cannot appear enabled');
    assert.deepEqual(unaffected.maintenance.journal.failures, []);
    assert.ok(!JSON.stringify(affected.maintenance).includes('private-content'));
    assert.equal(changes.length, 1);
    await runtime.coordinator.drain();
    assert.equal(changes.length, 1, 'unchanged faults cannot trigger periodic UI data refreshes');
    broken = false; await runtime.coordinator.drain();
    assert.equal((await snapshot('A')).maintenance.journal.error, null);
    assert.equal(changes.length, 2, 'recovery must invalidate the warning');
  } finally { await runtime.close(); }
});
