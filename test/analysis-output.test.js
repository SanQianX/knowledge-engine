'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { finalizeAnalysisOutput } = require('../src/analysis-output');
const { createDiagnostics } = require('../src/diagnostics');
const { ANALYSIS_SYSTEM_INSTRUCTIONS } = require('../src/analysis-contract');

function fixture(t, content, relative = 'changes/aaaaaaaaaaaa.md') {
  const stagingPath = fs.mkdtempSync(path.join(os.tmpdir(), '空库 产物-'));
  t.after(() => fs.rmSync(stagingPath, { recursive: true, force: true }));
  const job = { projectId: 'project-first', claim: { runId: 'run-first', commitSha: 'a'.repeat(40) }, stagingPath, manifestPath: path.join(stagingPath, 'manifest.json') };
  const file = path.join(stagingPath, 'files', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  const manifest = { schema: 'knowledge-staging-manifest/v1', projectId: job.projectId, runId: job.claim.runId, commitSha: job.claim.commitSha, operations: [{ operation: 'create', path: relative }] };
  fs.writeFileSync(job.manifestPath, JSON.stringify(manifest));
  return { job, file, manifest };
}
test('first-use contract explicitly permits an empty knowledge tree and requires document format', () => {
  assert.match(ANALYSIS_SYSTEM_INSTRUCTIONS, /没有已有知识是正常/); assert.match(ANALYSIS_SYSTEM_INSTRUCTIONS, /# 标题/); assert.match(ANALYSIS_SYSTEM_INSTRUCTIONS, /不强制生成整个知识树/);
});
test('non-empty titleless output is normalized in staging, sealed and idempotent', t => {
  const { job, file } = fixture(t, '## 本次变更\n\n冻结提交证据说明了一项真实修改。\n');
  assert.deepEqual(finalizeAnalysisOutput(job), ['changes/aaaaaaaaaaaa.md']);
  const bytes = fs.readFileSync(file);
  assert.match(bytes.toString('utf8'), /^# 提交 aaaaaaaaaaaa 变更记录/);
  assert.equal(JSON.parse(fs.readFileSync(job.manifestPath)).operations[0].sha256, `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(finalizeAnalysisOutput(job), []);
});
test('frontmatter is preserved when adding a missing title', t => {
  const { job, file } = fixture(t, '---\nsource: commit\n---\n\n真实正文。\n', 'README.md'); finalizeAnalysisOutput(job);
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nsource: commit\n---\n# 项目概览/);
});
test('empty, placeholder, malformed UTF-8 and unbalanced fences never become successful knowledge', t => {
  for (const content of [' \n\t', '# 只有标题\n', '---\nsource: commit\n---\n', 'TODO: 待补充', '```js\ncode', Buffer.from([0xff])]) {
    const { job, file } = fixture(t, content);
    const original = fs.readFileSync(file);
    assert.throws(() => finalizeAnalysisOutput(job)); assert.deepEqual(fs.readFileSync(file), original);
  }
});
test('mismatched identity, escaped paths and mismatched hashes remain rejected', t => {
  for (const alter of [m => m.projectId = 'project-other', m => m.operations[0].path = '../README.md', m => m.operations[0].sha256 = 'sha256:bad']) {
    const { job, file, manifest } = fixture(t, '真实证据正文。'); alter(manifest); fs.writeFileSync(job.manifestPath, JSON.stringify(manifest));
    assert.throws(() => finalizeAnalysisOutput(job)); assert.equal(fs.readFileSync(file, 'utf8'), '真实证据正文。');
  }
});
test('standalone diagnostics persist concrete errors without credentials or prompt evidence', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-diagnostics-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const log = createDiagnostics({ dataDir, secrets: () => ['fixture-provider-credential'] });
  await log.error('knowledge.maintenance.failed', '维护失败', { projectId: 'project-first', commitSha: 'a'.repeat(40), phase: 'validating', error: new Error('empty document; fixture-provider-credential'), context: { prompt: 'private evidence' } });
  const directory = path.join(dataDir, 'logs', 'projects', 'project-first'); const text = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
  const record = JSON.parse(text); assert.equal(record.phase, 'validating'); assert.match(record.error.message, /empty document/); assert(!text.includes('fixture-provider-credential')); assert(!text.includes('private evidence'));
});
