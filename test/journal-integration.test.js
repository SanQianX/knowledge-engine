'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { createEngineServer } = require('../src/server');
const AtomicFile = require('../src/runtime/atomic-file');

// Source checkouts are test fixtures only. Production resolves packaged
// services over HTTP and never depends on sibling paths.
const bridgeRoot = process.env.KB_BRIDGE_TEST_ROOT || path.resolve(__dirname, '../../ai-coding-event-bridge/packages/console');
const vectorRoot = process.env.KB_VECTOR_TEST_ROOT || path.resolve(__dirname, '../../vector-hub');
const enabled = fs.existsSync(path.join(bridgeRoot, 'src/server.js')) && fs.existsSync(path.join(vectorRoot, 'dist/cjs/server/manager.js'));

test('real Git hooks → real project journals → durable engine → real vector index and retrieval', { skip: enabled ? false : 'integration runtime fixtures unavailable' }, async () => {
  const { createBridge, projectRegistry, resolveRepoContext } = require(path.join(bridgeRoot, 'src/bridge'));
  const { createConsoleServer } = require(path.join(bridgeRoot, 'src/server'));
  const { HubManager } = require(path.join(vectorRoot, 'dist/cjs/server/manager'));
  const { createServer } = require(path.join(vectorRoot, 'dist/cjs/server/server'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-journal-e2e-'));
  const home = path.join(root, 'bridge-home');
  const bridge = createBridge({ homeDir: home });
  const manager = await HubManager.load({ rootPath: path.join(root, 'indexes'), configPath: path.join(root, 'vector-config.json'), embeddingsFactory: () => ({ maxTokens: 500, async createEmbeddings(inputs) { const texts = Array.isArray(inputs) ? inputs : [inputs]; return { status: 'success', output: texts.map(() => [1, 0]) }; } }) });
  await manager.saveSettings({ provider: 'minimax', apiKey: 'embedding-test-marker' });
  const vectorServer = http.createServer(createServer(manager)); const bridgeServer = http.createServer(createConsoleServer({ home }));
  for (const server of [vectorServer, bridgeServer]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let active = 0; let maximum = 0; const intervals = [];
  let releaseAnalyses;
  const analysisGate = new Promise(resolve => { releaseAnalyses = resolve; });
  const analyzer = { async runClaim(input) {
    active++; maximum = Math.max(maximum, active); intervals.push({ type: 'start', id: input.projectId, sha: input.claim.commitSha, at: Date.now() });
    try {
      await analysisGate;
      await new Promise(resolve => setTimeout(resolve, 100));
      const filename = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const markdown = `---\ncommit: ${input.claim.commitSha}\n---\n# Frozen evidence ${input.projectId}\n\n真实 Git Hook 集成维护 ${input.claim.commitSha}\n\n用户要求：保持功能简单，复用成熟消息流。\n`;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', filename), markdown);
      AtomicFile.writeJsonAtomic(input.manifestPath, { schema: 'knowledge-staging-manifest/v1', projectId: input.projectId, runId: input.claim.runId, commitSha: input.claim.commitSha, operations: [{ operation: 'create', path: filename, reason: 'Integration fixture accepted frozen evidence', sha256: `sha256:${crypto.createHash('sha256').update(markdown).digest('hex')}`, evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`] }], memoryCandidates: [{ text: '保持功能简单，复用成熟消息流。', entryId: filename, quote: '保持功能简单，复用成熟消息流。' }] });
    } finally { active--; intervals.push({ type: 'finish', id: input.projectId, sha: input.claim.commitSha, at: Date.now() }); }
  } };
  const dataDir = path.join(root, 'engine-state');
  const runtime = createEngineServer({ dataDir, consume: true, analyzer, bridgeUrl: `http://127.0.0.1:${bridgeServer.address().port}`, vectorUrl: `http://127.0.0.1:${vectorServer.address().port}` });
  await runtime.ready;
  const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const registrations = [];
  try {
    for (const name of ['alpha', 'beta', 'gamma']) {
      const repoPath = path.join(root, `中文 代码 ${name}`); const knowledgePath = path.join(root, `中文 知识 ${name}`);
      fs.mkdirSync(repoPath); fs.mkdirSync(knowledgePath);
      git(repoPath, ['init', '-q']); git(repoPath, ['config', 'user.email', 'hook@local.invalid']); git(repoPath, ['config', 'user.name', 'Hook Test']);
      fs.writeFileSync(path.join(repoPath, 'file.txt'), 'baseline\n'); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'baseline']);
      const trackingStartCommit = git(repoPath, ['rev-parse', 'HEAD']);
      const registered = await projectRegistry.addProject({ home, path: repoPath, store: path.join(knowledgePath, 'dev-conversations') });
      const { repoIdentity } = await resolveRepoContext(repoPath);
      const projectId = `project-${name}`;
      runtime.store.addProject({ projectId, repoPath, knowledgePath, trackingStartCommit, repoIdentity, journalId: registered.id, conversationBaselineCursor: 0 });
      await manager.import(knowledgePath, projectId, false);
      const hook = `#!/bin/sh\n"${process.execPath.replace(/\\/g, '/')}" "${path.join(bridgeRoot, 'src/bridge/bin/commit-boundary.js').replace(/\\/g, '/')}" --home "${home.replace(/\\/g, '/')}" --cwd "${repoPath.replace(/\\/g, '/')}" >/dev/null\n`;
      fs.writeFileSync(path.join(repoPath, '.git/hooks/post-commit'), hook, { mode: 0o755 });
      fs.writeFileSync(path.join(repoPath, 'file.txt'), `updated ${name}\n`); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', `feature ${name}`]);
      registrations.push({ projectId, repoPath, knowledgePath, journalId: registered.id, sha: git(repoPath, ['rev-parse', 'HEAD']) });
    }
    await runtime.coordinator.drain();
    const overlapDeadline = Date.now() + 5000;
    while (Date.now() < overlapDeadline && active < 2) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(active, 2, 'two analyses can consume independent projects while third remains queued');
    releaseAnalyses();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && (runtime.store.state.runs.length !== 3 || runtime.store.state.runs.some(r => !r.finishedAt))) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runtime.store.state.runs.length, 3);
    assert.ok(runtime.store.state.runs.every(r => r.state === 'succeeded' && r.indexState === 'succeeded'), JSON.stringify(runtime.store.state.runs.map(r => ({ state: r.state, error: r.error }))));
    assert.equal(maximum, 2, 'third project queues at concurrency cap');
    for (const p of registrations) {
      assert.equal(runtime.store.state.journalCursors[p.journalId], 1);
      assert.equal((await bridge.getConsumer('knowledge-engine')).cursors[p.journalId], 1);
      const result = await runtime.coordinator.retrieval.search({ projectId: p.projectId, query: p.sha });
      assert.ok(result.results.some(r => r.chunk_text.includes(p.sha)));
      assert.equal(result.health.index, 'ok');
      const index = await manager.hub.search(p.sha, { projects: [p.projectId] });
      assert.ok(index.results.length, 'real derived index contains promoted file');
      await bridge.appendCommitBoundary({ repoIdentity: runtime.store.getProject(p.projectId).repoIdentity, commitSha: p.sha });
    }
    await runtime.coordinator.drain();
    assert.equal(runtime.store.state.runs.length, 3, 'duplicate boundaries do not promote twice');
    const scope = { id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(root, '共享 智脑') };
    await runtime.coordinator.memories.configure([scope]);
    const memory = runtime.store.state.memories[0];
    assert.equal(memory.status, 'candidate');
    await runtime.coordinator.memories.update(memory.id, { status: 'confirmed' });
    const sharedDeadline = Date.now() + 10000;
    while (Date.now() < sharedDeadline && runtime.coordinator.sharedIndexJobs.size) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runtime.store.state.sharedScopes[0].index.status, 'ready');
    const sharedIndex = await manager.hub.search('保持功能简单', { projects: ['scope-brain-brain-default'] });
    assert.ok(sharedIndex.results.some(r => r.uri.endsWith('confirmed.md') && r.snippet.includes('保持功能简单')), 'confirmed memory reaches the real vector index');
    const sharedRecall = await runtime.coordinator.retrieval.search({ projectId: registrations[0].projectId, query: '保持功能简单', scope: 'brain' });
    assert.ok(sharedRecall.results.some(r => r.space_id === 'brain:brain-default' && r.match_channels.includes('index:vector-hub')), 'shared scope participates in vector recall');
    await runtime.close();
    const restarted = createEngineServer({ dataDir, analyzer, consume: true, bridgeUrl: `http://127.0.0.1:${bridgeServer.address().port}`, vectorUrl: `http://127.0.0.1:${vectorServer.address().port}` });
    await restarted.ready;
    assert.equal(restarted.store.state.runs.length, 3);
    assert.equal(intervals.filter(e => e.type === 'start').length, 3, 'restart preserves completion');
    await restarted.close();
  } finally {
    releaseAnalyses();
    await runtime.close();
    manager.close?.();
    for (const server of [vectorServer, bridgeServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
