'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EngineStore } = require('../src/store');
const { EngineCoordinator } = require('../src/coordinator');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-journal-contract-'));
  const store = new EngineStore(path.join(root, 'state'));
  for (const id of ['A', 'B']) {
    const repoPath = path.join(root, id), knowledgePath = path.join(root, `knowledge-${id}`);
    fs.mkdirSync(repoPath); fs.mkdirSync(knowledgePath);
    store.addProject({ projectId: `project-${id}`, name: id, repoPath, knowledgePath, journalId: id });
  }
  const events = { A: [], B: [] }, acks = [];
  const bridge = {
    async registerConsumer() {},
    async listJournals() { return ['A', 'B'].map(journalId => ({ journalId })); },
    async readEvents({ journalId, fromSequence }) { return events[journalId].filter(e => e.sequence >= fromSequence); },
    async ackConsumerCursor(name, sequence, { journalId }) { acks.push({ sequence, journalId }); },
    close() {},
  };
  const coordinator = new EngineCoordinator(store, { bridge, managed: true });
  await coordinator.ready;
  const projected = (source, sequence) => ({ schema: 'ai-coding-event/v1', source, sequence, eventId: `event-${source}-${sequence}`, eventType: 'user_prompt', role: 'user', content: 'private test requirement', turnId: 'turn-test', sessionId: 'session-test', capturedAt: new Date().toISOString() });
  return { root, store, coordinator, events, acks, projected };
}

test('canonical ZCode events do not block commit consumption and remain ZCode evidence', async () => {
  const f = await fixture();
  try {
    f.events.A.push(f.projected('zcode', 1), { schema: 'git-commit-boundary/v1', sequence: 2, commitSha: 'a'.repeat(40), parents: [], openTurnIdsAtCommit: ['turn-test'], committedAt: new Date().toISOString(), operationId: 'op-test-journal' });
    await f.coordinator.drain();
    assert.equal(f.coordinator.journalError, null);
    assert.equal(f.coordinator.conversations.readEvents('project-A')[0].source, 'zcode');
    assert.equal(f.store.listRuns('project-A')[0].commitSha, 'a'.repeat(40));
    assert.equal(f.store.state.journalCursors.A, 2);
    assert.ok(f.acks.some(a => a.journalId === 'A' && a.sequence === 2));
  } finally { await f.coordinator.close(); }
});

test('a blocked journal preserves its cursor, diagnoses once, and does not starve another project', async () => {
  const f = await fixture();
  try {
    f.events.A.push(f.projected('unsupported-client', 1));
    f.events.B.push(f.projected('codex', 1));
    await f.coordinator.drain(); await f.coordinator.drain();
    assert.equal(f.store.state.journalCursors.A || 0, 0);
    assert.equal(f.store.state.journalCursors.B, 1);
    assert.ok(!f.acks.some(a => a.journalId === 'A'));
    assert.equal(f.coordinator.journalFailures.get('A').sequence, 1);
    const logRoot = path.join(f.store.dataDir, 'logs', 'projects', 'project-A');
    const logs = fs.readFileSync(path.join(logRoot, fs.readdirSync(logRoot)[0]), 'utf8');
    const failures = logs.trim().split('\n').map(JSON.parse).filter(r => r.event === 'knowledge.journal.failed');
    assert.equal(failures.length, 1, 'polling must not flood logs');
    assert.equal(failures[0].context.journalId, 'A');
    assert.equal(failures[0].context.sequence, 1);
    assert.equal(failures[0].error.code, 'INVALID_ARGUMENT');
    assert.ok(!logs.includes('private test requirement'));
    f.events.A[0].source = 'zcode';
    await f.coordinator.drain();
    assert.equal(f.coordinator.journalError, null);
    assert.equal(f.coordinator.journalFailures.size, 0);
    assert.equal(f.store.state.journalCursors.A, 1);
  } finally { await f.coordinator.close(); }
});
