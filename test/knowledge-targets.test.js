'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freezeKnowledgeTargets } = require('../src/knowledge-targets');

test('target inventory includes existing files omitted by retrieval, preserves its frozen version on retry, and stores no document copies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-target-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const knowledge = path.join(root, 'knowledge'), evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(path.join(knowledge, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'modules/secondary-policy.md'), '# Original\n\nprivate-document-marker');
  const input = { config: { knowledgePath: knowledge }, evidenceRoot, projectId: 'project-test', claim: { runId: 'run-test', commitSha: 'a'.repeat(40) }, existingKnowledge: { entries: [{ path: 'changes/old.md', content: 'unrelated selected chunk' }] } };
  const first = freezeKnowledgeTargets(input);
  assert.equal(first.inventory.entries[0].path, 'modules/secondary-policy.md');
  assert.match(first.contract, /create.*not.*inventory/i);
  assert.match(first.contract, /partial/i);
  const bytes = fs.readFileSync(first.file);
  assert.ok(!bytes.includes('private-document-marker'));
  fs.writeFileSync(path.join(knowledge, 'modules/new.md'), '# Later\n\nLater content');
  assert.deepEqual(freezeKnowledgeTargets(input).inventory, first.inventory);
  assert.deepEqual(fs.readFileSync(first.file), bytes);
  assert.deepEqual(fs.readdirSync(evidenceRoot), ['knowledge-targets.json']);
  const bad = JSON.parse(bytes); bad.entries[0].path = '../escape.md';
  fs.writeFileSync(first.file, JSON.stringify(bad));
  assert.throws(() => freezeKnowledgeTargets(input), /inventory/);
});

test('an empty knowledge directory is a valid first-maintenance inventory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-empty-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = freezeKnowledgeTargets({ evidenceRoot: root, config: { knowledgePath: path.join(root, 'absent') }, projectId: 'project-test', claim: { runId: 'run-test', commitSha: 'a'.repeat(40) } });
  assert.deepEqual(frozen.inventory.entries, []);
});
