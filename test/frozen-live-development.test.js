'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createEngineServer } = require('../src/server');
const { HeadlessAnalyzer } = require('../src/headless-analyzer');
const { buildAutomationToolPolicy, evaluateAutomationToolUse } = require('../src/runtime/automation-config');
const AtomicFile = require('../src/runtime/atomic-file');

const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
async function waitFor(fn) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Controlled analysis did not reach expected state');
}
for (const isolated of [true, false]) test(isolated ? 'isolated headless analysis survives user edits and another commit, retaining frozen attribution and FIFO' : 'analyzer without isolated evidence capability retains live-source mutation protection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-live-develop-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('engine-live-develop-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repoPath = path.join(root, '代码项目'), knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(repoPath); fs.mkdirSync(knowledgePath);
  git(repoPath, ['init', '-q']); git(repoPath, ['config', 'user.name', 'Engine Test']); git(repoPath, ['config', 'user.email', 'test@local.invalid']);
  AtomicFile.writeFileAtomic(path.join(repoPath, 'feature.txt'), 'baseline\n'); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'baseline']);
  const baseline = git(repoPath, ['rev-parse', 'HEAD']);
  AtomicFile.writeFileAtomic(path.join(repoPath, 'feature.txt'), 'first frozen change\n'); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'first']);
  const firstSha = git(repoPath, ['rev-parse', 'HEAD']);
  const vector = http.createServer((req, res) => { req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.method === 'POST' ? { ok: true } : { results: [], errors: [] })); });
  await new Promise(resolve => vector.listen(0, '127.0.0.1', resolve));
  const analyzer = new HeadlessAnalyzer({ workerPath: path.join(__dirname, 'fixtures/frozen-development.cjs'), resolveProfile: () => ({ apiKey: 'controlled-test-not-real', mainModel: 'controlled' }) });
  const engine = createEngineServer({ dataDir: path.join(root, 'engine'), analyzer: isolated ? analyzer : { runClaim: input => analyzer.runClaim(input), close: () => analyzer.close() }, vectorUrl: `http://127.0.0.1:${vector.address().port}` });
  await engine.ready;
  try {
    const projectId = 'project-live-development';
    engine.store.addProject({ projectId, repoPath, knowledgePath, trackingStartCommit: baseline });
    const first = engine.coordinator.enqueue({ projectId, commitSha: firstSha });
    const output = () => path.join(root, 'engine/runtime/runs', projectId, first.analysisRunId, 'output');
    await waitFor(() => first.analysisRunId && fs.existsSync(path.join(output(), 'analysis-ready')));
    const evidence = path.join(path.dirname(output()), 'input/evidence');
    const patchFile = path.join(evidence, 'patch.diff');
    const patchBefore = fs.existsSync(patchFile) ? fs.readFileSync(patchFile) : null;
    // This edit belongs to the developer while the isolated worker is paused.
    AtomicFile.writeFileAtomic(path.join(repoPath, 'feature.txt'), 'second user change\n');
    git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'second while analysis is active']);
    const secondSha = git(repoPath, ['rev-parse', 'HEAD']);
    const second = engine.coordinator.enqueue({ projectId, commitSha: secondSha });
    AtomicFile.writeFileAtomic(path.join(repoPath, 'draft.txt'), 'uncommitted user draft\n');
    assert.equal(second.state, 'queued'); assert.equal(second.analysisRunId, undefined);
    AtomicFile.writeFileAtomic(path.join(output(), 'continue-analysis'), 'continue');
    await waitFor(() => ['succeeded', 'failed', 'index-pending'].includes(first.state));
    if (!isolated) {
      assert.equal(first.state, 'failed'); assert.equal(first.error.code, 'PROJECT_BUSY');
      assert.deepEqual(fs.readdirSync(knowledgePath), []); assert.equal(second.state, 'queued');
      return;
    }
    assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
    assert.equal(first.commitSha, firstSha);
    if (patchBefore) assert.deepEqual(fs.readFileSync(patchFile), patchBefore);
    const secondOutput = () => path.join(root, 'engine/runtime/runs', projectId, second.analysisRunId, 'output');
    await waitFor(() => second.analysisRunId && fs.existsSync(path.join(secondOutput(), 'analysis-ready')));
    AtomicFile.writeFileAtomic(path.join(secondOutput(), 'continue-analysis'), 'continue');
    await waitFor(() => ['succeeded', 'failed', 'index-pending'].includes(second.state));
    assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
    assert.equal(engine.store.readRuntime(projectId).lastAnalyzedCommit, secondSha);
    for (const sha of [firstSha, secondSha]) assert.ok(fs.readFileSync(path.join(knowledgePath, 'changes', `${sha.slice(0, 12)}.md`), 'utf8').includes(sha));
    assert.equal(fs.readFileSync(path.join(repoPath, 'feature.txt'), 'utf8'), 'second user change\n');
    assert.equal(fs.readFileSync(path.join(repoPath, 'draft.txt'), 'utf8'), 'uncommitted user draft\n');
  } finally { await engine.close(); vector.closeAllConnections(); await new Promise(resolve => vector.close(resolve)); }
});

test('isolated mode still denies code reads/writes, shell execution and final knowledge writes', () => {
  const root = path.resolve(os.tmpdir(), 'engine-boundary-proof');
  const stagingPath = path.join(root, 'run/output'), evidenceRoot = path.join(root, 'run/input/evidence');
  const policy = buildAutomationToolPolicy({ stagingPath, evidenceRoot });
  for (const [tool, input] of [['Read', { file_path: path.join(root, 'code/file.js') }], ['Write', { file_path: path.join(root, 'code/file.js') }], ['Edit', { file_path: path.join(root, 'knowledge/README.md') }], ['Bash', { command: 'git status' }]]) assert.equal(evaluateAutomationToolUse(policy, tool, input).behavior, 'deny');
  assert.equal(evaluateAutomationToolUse(policy, 'Read', { file_path: path.join(evidenceRoot, 'patch.diff') }).behavior, 'allow');
});
