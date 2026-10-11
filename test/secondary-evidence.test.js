'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { citedEntry, verifySecondaryEvidence } = require('./support/secondary-evidence');

test('real model citations accept commit and commitSha labels without requiring fixed wording', () => {
  const sha = 'd'.repeat(40), entryId = 'changes/dddddddddddd.md';
  for (const citation of [`commit ${sha}`, `commitSha: ${sha}`, `Commit: \`${sha}\``]) {
    assert.deepEqual(citedEntry(`// ${entryId} (${citation})`), { entryId, commitSha: sha });
  }
  assert.throws(() => citedEntry(`// ${entryId} commit dddddddd`), /full commit/);
});

test('secondary acceptance validates actual knowledge origins, not an unrelated latest commit', () => {
  const latest = 'a'.repeat(40), origin = 'b'.repeat(40), entryId = 'changes/bbbbbbbbbbbb.md';
  const sample = () => ({ projectId: 'project-a', latestCommit: latest, file: 'policy.js', source: `// ${entryId}\n// commitSha ${origin}`, entry: { ok: true, projectId: 'project-a', entryId, chunks: [{ chunk_text: `${origin}\nKnowledge has one writer: the engine promotion path.` }] }, events: [
    { type: 'claude/tool-use', id: 'latest', input: { command: `node project-knowledge-kb.js search --project project-a --query ${latest}` } },
    { type: 'claude/tool-result', id: 'latest', isError: false, output: `hybrid+markdown-truth ${latest}` },
    { type: 'claude/tool-use', id: 'origin', input: { command: 'node project-knowledge-kb.js search --project project-a --query single-writer' } },
    { type: 'claude/tool-result', id: 'origin', isError: false, output: `${entryId} ${origin}` },
    { type: 'claude/tool-use', name: 'Write', input: { file_path: 'D:/test/policy.js' } },
    { type: 'claude/result', isError: false, result: `${entryId} ${origin} SECONDARY_POLICY_OK` },
  ] });
  const good = verifySecondaryEvidence(sample());
  assert.equal(good.commitSha, origin); assert.equal(good.latestQueriedCommit, latest);
  let bad = sample(); bad.source = bad.source.replace(origin, 'c'.repeat(40)); assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events[2].input.command = 'echo project-knowledge-kb.js --project other'; assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events[3].isError = true; assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events.splice(4, 0, bad.events.splice(3, 1)[0]); assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.entry.chunks[0].chunk_text = `${origin} unrelated`; assert.throws(() => verifySecondaryEvidence(bad), /single-writer/);
  bad = sample(); bad.entry.projectId = 'project-b'; assert.throws(() => verifySecondaryEvidence(bad));
  bad = sample(); bad.events.at(-1).result = 'SECONDARY_POLICY_OK'; assert.throws(() => verifySecondaryEvidence(bad), /final answer/);
});
