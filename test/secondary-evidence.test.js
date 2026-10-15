'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { citedEntry, verifySecondaryEvidence, verifyCompletedTeardown } = require('./support/secondary-evidence');

test('repeated no-subprocess teardown preserves a completed task but cannot excuse an interrupted task', () => {
  const finished = [{ type: 'claude/result', isError: false }, { type: 'claude/state', state: 'idle' }, { type: 'claude/turn-end' }];
  const stopped = { type: 'claude/state', state: 'aborted', reason: 'no-active-subprocess' };
  verifyCompletedTeardown([...finished, stopped, stopped]);
  assert.throws(() => verifyCompletedTeardown([...finished, { ...stopped, reason: 'killed' }]));
  assert.throws(() => verifyCompletedTeardown([{ type: 'claude/state', state: 'running' }, stopped]));
  assert.throws(() => verifyCompletedTeardown([{ type: 'claude/state', state: 'idle' }, stopped]));
  assert.throws(() => verifyCompletedTeardown([{ type: 'claude/result', isError: true }, ...finished.slice(1), stopped]));
});

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
    { type: 'claude/tool-result', id: 'latest', isError: false, output: JSON.stringify({ ok: true, projectId: 'project-a', source: 'knowledge-retrieval-service', backend: 'hybrid+markdown-truth', query: latest, results: [{ scope_project_id: 'project-a', entry_id: 'changes/aaaaaaaaaaaa.md', commitSha: latest }] }) },
    { type: 'claude/tool-use', id: 'origin', input: { command: 'node project-knowledge-kb.js search --project project-a --query single-writer' } },
    { type: 'claude/tool-result', id: 'origin', isError: false, output: `${entryId} ${origin}` },
    { type: 'claude/tool-use', name: 'Write', input: { file_path: 'D:/test/policy.js' } },
    { type: 'claude/result', isError: false, result: `${entryId} ${origin} SECONDARY_POLICY_OK` },
  ] });
  const good = verifySecondaryEvidence(sample());
  assert.equal(good.commitSha, origin); assert.equal(good.latestQueriedCommit, latest);
  let factual = sample();
  factual.events[1].output = factual.events[1].output.replace('hybrid+markdown-truth', 'markdown-hybrid-fallback');
  assert.equal(verifySecondaryEvidence(factual).commitSha, origin);
  for (const change of [body => { body.projectId = 'project-other'; }, body => { body.source = 'echo'; }, body => { body.results[0].commitSha = 'c'.repeat(40); }, body => { body.results[0].scope_project_id = 'project-other'; }, body => { body.backend = 'made-up'; }]) {
    const invalid = sample(), body = JSON.parse(invalid.events[1].output); change(body); invalid.events[1].output = JSON.stringify(body);
    assert.throws(() => verifySecondaryEvidence(invalid));
  }
  let bad = sample(); bad.source = bad.source.replace(origin, 'c'.repeat(40)); assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events[2].input.command = 'echo project-knowledge-kb.js --project other'; assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events[3].isError = true; assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.events.splice(4, 0, bad.events.splice(3, 1)[0]); assert.throws(() => verifySecondaryEvidence(bad), /pre-edit/);
  bad = sample(); bad.entry.chunks[0].chunk_text = `${origin} unrelated`; assert.throws(() => verifySecondaryEvidence(bad), /single-writer/);
  bad = sample(); bad.entry.projectId = 'project-b'; assert.throws(() => verifySecondaryEvidence(bad));
  bad = sample(); bad.events.at(-1).result = 'SECONDARY_POLICY_OK'; assert.throws(() => verifySecondaryEvidence(bad), /final answer/);
});

test('real model Chinese citation labels parse like English ones', () => {
  const sha = '6d195ab0b282adf239aafe751b83bb0716864a65', entryId = 'changes/6d195ab0b282.md';
  const originalFailingSource = `// 依据知识条目 changes/6d195ab0b282.md 原文：
// "Knowledge has one writer: the engine promotion path."
// 该事实来自提交 ${sha}。`;
  const positives = [
    originalFailingSource,
    `// ${entryId} 提交：${sha}`,
    `// ${entryId} 提交： ${sha}`,
    `// ${entryId} 提交SHA：${sha}`,
    `// ${entryId} 提交SHA: ${sha}`,
    `// ${entryId} 提交sha=${sha}`,
    `// ${entryId} (commitSha\n// ${sha})`,
    `// ${entryId} (commitSha\r\n// ${sha})`,
  ];
  for (const source of positives) {
    assert.deepEqual(citedEntry(source), { entryId, commitSha: sha });
  }
  assert.throws(() => citedEntry(`// ${entryId} 提交 ${sha.slice(0, 12)}`), /full commit/);
  assert.throws(() => citedEntry(`// ${entryId} 散落的 SHA ${sha} 没有提交标签`), /full commit/);
  assert.throws(() => citedEntry(`// changes/../../secret.md 提交 ${sha}`), /escape/);
});
