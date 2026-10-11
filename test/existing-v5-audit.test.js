'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { verify } = require('./support/existing-v5-audit');

test('upgrade evidence rejects lost identity, history or protected configuration without storing credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-existing-v5-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = path.join(root, 'credentials.json'); const knowledge = path.join(root, 'knowledge.md'); const history = path.join(root, 'session.json');
  fs.writeFileSync(credential, 'protected-secret-marker'); fs.writeFileSync(knowledge, 'knowledge'); fs.writeFileSync(history, 'history');
  const before = { dataDir: root, projects: [{ projectId: 'project-test', repoPath: root, knowledgePath: root, brainId: 'brain-default', domainId: null, trackingStartCommit: 'abc', knowledgeFiles: [{ file: knowledge }] }], historyFiles: [{ file: history }], protectedFiles: [{ file: credential, sha256: crypto.createHash('sha256').update(fs.readFileSync(credential)).digest('hex') }], runs: [{ runId: 'run-test', commitSha: 'abc' }] };
  assert.ok(!JSON.stringify(before).includes('protected-secret-marker'));
  verify(before, structuredClone(before));
  const missing = structuredClone(before); missing.projects = [];
  assert.throws(() => verify(before, missing), /project must not disappear/);
  const reset = structuredClone(before); reset.projects[0].trackingStartCommit = 'new-baseline';
  assert.throws(() => verify(before, reset), /trackingStartCommit/);
  const lostRun = structuredClone(before); lostRun.runs = [];
  assert.throws(() => verify(before, lostRun), /run history/);
  fs.writeFileSync(credential, 'replaced'); assert.throws(() => verify(before, before), /protected configuration/);
  fs.writeFileSync(credential, 'protected-secret-marker'); fs.unlinkSync(history);
  assert.throws(() => verify(before, before), /history disappeared/);
});
