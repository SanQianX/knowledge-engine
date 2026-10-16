'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EngineStore } = require('../src/store');
const { createEngineServer } = require('../src/server');
const AtomicFile = require('../src/runtime/atomic-file');

function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-engine-test-')); }
function git(cwd, args) { return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim(); }
function project(root, name) {
  const repoPath = path.join(root, `代码 ${name}`);
  const knowledgePath = path.join(root, `知识 ${name}`);
  fs.mkdirSync(repoPath, { recursive: true }); fs.mkdirSync(knowledgePath);
  git(repoPath, ['init', '-q']); git(repoPath, ['config', 'user.email', 'test@local.invalid']); git(repoPath, ['config', 'user.name', 'Engine Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial\n'); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', 'initial']);
  const baseline = git(repoPath, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repoPath, 'feature.txt'), `new feature ${name}\n`); git(repoPath, ['add', '.']); git(repoPath, ['commit', '-qm', `feature ${name}`]);
  return { projectId: `project-${name}`, name, repoPath, knowledgePath, trackingStartCommit: baseline, commitSha: git(repoPath, ['rev-parse', 'HEAD']), brainId: 'brain-default', domainId: 'domain-tools' };
}
async function start(options = {}) {
  const runtime = createEngineServer({ dataDir: directory(), ...options });
  await runtime.ready;
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  return { ...runtime, base, async call(route, body, headers = {}) { const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; } };
}
async function eventually(fn, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Condition timed out');
}
function analyzer({ delay = 0, events = [], markdown } = {}) {
  return { async runClaim(input) {
    events.push({ kind: 'start', projectId: input.projectId, sha: input.claim.commitSha, at: Date.now() });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
    const content = markdown === undefined ? `# Verified maintenance ${input.projectId}\n\nCommit ${input.claim.commitSha} implements feature.\n` : markdown;
    AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', relative), content);
    AtomicFile.writeJsonAtomic(input.manifestPath, { schema: 'knowledge-staging-manifest/v1', projectId: input.projectId, runId: input.claim.runId, commitSha: input.claim.commitSha, operations: [{ path: relative, operation: 'create', sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, reason: 'Frozen Git evidence', evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`] }] });
    events.push({ kind: 'finish', projectId: input.projectId, sha: input.claim.commitSha, at: Date.now() });
    return { ok: true };
  } };
}
async function vectorServer(fail = false) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      requests.push({ url: req.url, body: body && JSON.parse(body) });
      res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? { ok: !fail, ...(fail ? { error: { code: 'EMBEDDING_UNAVAILABLE', message: 'embedding service unavailable' } } : {}) } : { results: [], errors: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, setFailure(value) { fail = value; }, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('empty first start, strict state recovery, credentials never persist', async () => {
  const runtime = await start({ runtimeToken: 'local-test-token' });
  try {
    assert.deepEqual((await runtime.call('/api/projects')).body.projects, []);
    const p = project(directory(), 'A');
    assert.equal((await runtime.call('/api/projects', { ...p, apiKey: 'credential-marker', runtimeConfig: { apiKey: 'credential-marker' } })).status, 200);
    assert.equal((await runtime.call('/api/runtime-config', { profile: { apiKey: 'credential-marker' } })).status, 403);
    assert.equal((await runtime.call('/api/runtime-config', { profile: { apiKey: 'credential-marker', mainModel: 'test' } }, { Authorization: 'Bearer local-test-token' })).status, 200);
    assert.ok(!fs.readFileSync(runtime.store.file, 'utf8').includes('credential-marker'));
    assert.equal((await runtime.call('/api/runs', { projectId: p.projectId })).status, 403);
    assert.equal((await runtime.call('/api/runs', { projectId: p.projectId, commitSha: p.commitSha })).status, 403, 'production cannot bypass the journal');
    assert.equal((await runtime.call('/api/runs', { projectId: p.projectId, commitSha: p.commitSha, simulateFailure: true })).status, 403);
    assert.equal((await runtime.call('/api/projects', { ...p, projectId: 'project-conflict' })).status, 409);
  } finally { await runtime.close(); }
  const data = directory(); fs.writeFileSync(path.join(data, 'engine-state.json'), '{broken');
  assert.throws(() => new EngineStore(data), { code: 'DATA_CORRUPT' });
  assert.equal(fs.readFileSync(path.join(data, 'engine-state.json'), 'utf8'), '{broken');
});

test('source-truth retrieval, project/domain/brain scopes and compatibility reads', async () => {
  const vector = await vectorServer();
  const runtime = await start({ vectorUrl: vector.url });
  try {
    const root = directory(); const a = project(root, 'A'); const b = project(root, 'B'); const c = project(root, 'C'); c.domainId = 'domain-other';
    for (const p of [a, b, c]) { runtime.store.addProject(p); fs.writeFileSync(path.join(p.knowledgePath, 'README.md'), `# ${p.name}\nshared-token knowledge ${p.name}\n`); }
    assert.equal((await runtime.call('/api/search', { projectId: a.projectId, query: 'shared-token' })).body.results.length, 1);
    assert.equal((await runtime.call('/api/search', { projectId: a.projectId, query: 'shared-token', scope: 'domain' })).body.results.length, 2);
    assert.equal((await runtime.call('/api/ask', { projectId: a.projectId, query: 'shared-token', scope: 'brain' })).body.citations.length, 3);
    assert.match((await runtime.call('/api/get', { projectId: a.projectId, entryId: 'README.md' })).body.chunks[0].chunk_text, /shared-token/);
    assert.equal((await runtime.call('/api/get', { projectId: a.projectId, entryId: '../outside.md' })).status, 403);
    fs.unlinkSync(path.join(a.knowledgePath, 'README.md'));
    assert.equal((await runtime.call('/api/search', { projectId: a.projectId, query: 'shared-token' })).body.results.length, 0);
  } finally { await runtime.close(); await vector.close(); }
});

test('real Git frozen evidence, promotion, distinct-project concurrency and duplicate suppression', async () => {
  const vector = await vectorServer(); const events = [];
  const runtime = await start({ vectorUrl: vector.url, analyzer: analyzer({ delay: 250, events }) });
  try {
    const root = directory(); const a = project(root, 'A'); const b = project(root, 'B');
    for (const p of [a, b]) { runtime.store.addProject(p); runtime.coordinator.enqueue({ projectId: p.projectId, commitSha: p.commitSha }); }
    await eventually(() => runtime.store.listRuns().every(r => ['succeeded', 'failed'].includes(r.state)));
    assert.deepEqual(runtime.store.listRuns().map(r => ({ state: r.state, error: r.error })), [{ state: 'succeeded', error: null }, { state: 'succeeded', error: null }]);
    const starts = events.filter(e => e.kind === 'start'); const finishes = events.filter(e => e.kind === 'finish');
    assert.equal(starts.length, 2); assert.ok(Math.max(...starts.map(e => e.at)) < Math.min(...finishes.map(e => e.at)), 'analysis intervals overlap');
    for (const p of [a, b]) {
      assert.equal(runtime.store.readRuntime(p.projectId).lastAnalyzedCommit, p.commitSha);
      assert.ok(fs.readFileSync(path.join(p.knowledgePath, 'changes', `${p.commitSha.slice(0, 12)}.md`), 'utf8').includes(p.commitSha));
      runtime.coordinator.enqueue({ projectId: p.projectId, commitSha: p.commitSha });
      assert.ok((await runtime.call('/api/search', { projectId: p.projectId, query: p.commitSha })).body.results.length);
      assert.equal((await runtime.call('/api/history', { projectId: p.projectId })).body.results.length, 1);
    }
    assert.equal(runtime.store.state.runs.length, 2); assert.equal(vector.requests.filter(r => r.url === '/api/sync').length, 2);
  } finally { await runtime.close(); await vector.close(); }
});

test('index failure retains promoted files and reports a separate repair state', async () => {
  const vector = await vectorServer(true); const events = []; const runtime = await start({ vectorUrl: vector.url, analyzer: analyzer({ events }) });
  try {
    const p = project(directory(), 'A'); runtime.store.addProject(p);
    const run = runtime.coordinator.enqueue({ projectId: p.projectId, commitSha: p.commitSha });
    await eventually(() => run.finishedAt);
    assert.equal(run.phase, 'index-pending'); assert.equal(run.indexState, 'failed');
    assert.equal(runtime.store.readRuntime(p.projectId).lastAnalyzedCommit, p.commitSha);
    assert.ok(fs.existsSync(path.join(p.knowledgePath, 'changes', `${p.commitSha.slice(0, 12)}.md`)));
    assert.equal(run.error.details.httpStatus, 503); assert.equal(run.error.details.upstreamCode, 'EMBEDDING_UNAVAILABLE');
    assert.equal(run.error.details.failureKind, 'HTTP_ERROR'); assert.equal(run.error.details.attempt, 1);
    const logDir = path.join(runtime.store.dataDir, 'logs', 'projects', p.projectId);
    const records = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').trim().split('\n').map(JSON.parse);
    const logged = records.find(record => record.event === 'knowledge.index.failed');
    assert.equal(logged.runId, run.runId); assert.equal(logged.commitSha, p.commitSha); assert.equal(logged.phase, 'indexing');
    assert.equal(logged.context.httpStatus, 503); assert.equal(logged.context.upstreamCode, 'EMBEDDING_UNAVAILABLE');
    assert.equal(new EngineStore(runtime.store.dataDir).getRun(run.runId).error.details.upstreamCode, 'EMBEDDING_UNAVAILABLE');
    const promotedAt = run.promotedAt, analysisRunId = run.analysisRunId;
    const file = path.join(p.knowledgePath, 'changes', `${p.commitSha.slice(0, 12)}.md`), bytes = fs.readFileSync(file);
    vector.setFailure(false); runtime.coordinator.retry(run.runId);
    await eventually(() => run.state === 'succeeded');
    assert.equal(run.promotedAt, promotedAt); assert.equal(run.analysisRunId, analysisRunId);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(events.filter(e => e.kind === 'start').length, 1);
    assert.equal(run.indexAttempts, 2); assert.equal(run.error, null);
  } finally { await runtime.close(); await vector.close(); }
});

test('zero-document first commit normalizes its title and becomes indexed, empty output preserves exact failure', async () => {
  const vector = await vectorServer(); const root = directory();
  const runtime = await start({ vectorUrl: vector.url, analyzer: analyzer({ markdown: '## 更新说明\n\n本次冻结提交添加了 feature 文件。\n' }) });
  try {
    const p = project(root, 'empty'); assert.deepEqual(fs.readdirSync(p.knowledgePath), []); runtime.store.addProject(p);
    const run = runtime.coordinator.enqueue({ projectId: p.projectId, commitSha: p.commitSha });
    await eventually(() => run.state === 'succeeded');
    assert.match(fs.readFileSync(path.join(p.knowledgePath, 'changes', `${p.commitSha.slice(0, 12)}.md`), 'utf8'), /^# 提交/);
    assert.equal(run.indexState, 'succeeded');
    runtime.coordinator.analyzer = analyzer({ markdown: ' \n' });
    const other = project(root, 'blank'); runtime.store.addProject(other);
    const failed = runtime.coordinator.enqueue({ projectId: other.projectId, commitSha: other.commitSha });
    await eventually(() => failed.state === 'failed');
    assert.equal(failed.error.code, 'ANALYSIS_EMPTY_DOCUMENT'); assert.equal(failed.error.phase, 'validating'); assert.match(failed.error.message, /正文为空/);
    assert.deepEqual(fs.readdirSync(other.knowledgePath), []); assert.equal(runtime.store.readRuntime(other.projectId).lastAnalyzedCommit, other.trackingStartCommit);
    const logDir = path.join(runtime.store.dataDir, 'logs', 'projects', other.projectId);
    const records = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').trim().split('\n').map(JSON.parse);
    assert(records.some(record => record.event === 'knowledge.maintenance.failed' && record.commitSha === other.commitSha && record.error.message.includes('正文为空')));
    const response = await runtime.call(`/api/runs/${failed.runId}`); assert.match(response.body.run.error.message, /正文为空/);
  } finally { await runtime.close(); await vector.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed earlier commit blocks only its project; retry restores FIFO order', async () => {
  const vector = await vectorServer(); const events = [];
  const root = directory(), a = project(root, 'FIFO-A'), b = project(root, 'FIFO-B');
  const firstSha = a.commitSha;
  fs.writeFileSync(path.join(a.repoPath, 'second.txt'), 'second change\n'); git(a.repoPath, ['add', '.']); git(a.repoPath, ['commit', '-qm', 'second change']);
  const secondSha = git(a.repoPath, ['rev-parse', 'HEAD']);
  let failedOnce = false;
  const delegate = analyzer({ events });
  const runtime = await start({ vectorUrl: vector.url, analyzer: { async runClaim(input) {
    if (input.claim.commitSha === firstSha && !failedOnce) { failedOnce = true; throw Object.assign(new Error('controlled first failure'), { code: 'AI_TIMEOUT', retryable: true }); }
    return delegate.runClaim(input);
  } } });
  try {
    runtime.store.addProject(a); runtime.store.addProject(b);
    const first = runtime.coordinator.enqueue({ projectId: a.projectId, commitSha: firstSha });
    const second = runtime.coordinator.enqueue({ projectId: a.projectId, commitSha: secondSha });
    const other = runtime.coordinator.enqueue({ projectId: b.projectId, commitSha: b.commitSha });
    await eventually(() => first.state === 'failed' && other.state === 'succeeded' && second.phase === 'waiting-previous');
    assert.equal(second.state, 'queued'); assert.ok(!events.some(e => e.sha === secondSha));
    runtime.coordinator.retry(first.runId);
    await eventually(() => first.state === 'succeeded' && second.state === 'succeeded');
    assert.deepEqual(events.filter(e => e.projectId === a.projectId && e.kind === 'start').map(e => e.sha), [firstSha, secondSha]);
    assert.equal(runtime.store.readRuntime(a.projectId).lastAnalyzedCommit, secondSha);
  } finally { await runtime.close(); await vector.close(); }
});

test('quota failure retains journal jobs and waiting commits across restart without retrying the model', async () => {
  const { HeadlessAnalyzer } = require('../src/headless-analyzer');
  const root = directory(), p = project(root, 'quota');
  fs.writeFileSync(path.join(p.repoPath, 'next.txt'), 'next commit\n'); git(p.repoPath, ['add', '.']); git(p.repoPath, ['commit', '-qm', 'after quota']);
  const nextSha = git(p.repoPath, ['rev-parse', 'HEAD']);
  const dataDir = directory();
  const journalId = `sha256:${'d'.repeat(64)}`;
  const events = [p.commitSha, nextSha].map((commitSha, i) => ({ schema: 'git-commit-boundary/v1', sequence: i + 1, commitSha, parents: [], committedAt: new Date().toISOString() }));
  const acks = [];
  const bridge = { async registerConsumer() {}, async listJournals() { return [{ journalId }]; }, async readEvents({ fromSequence }) { return events.filter(e => e.sequence >= fromSequence); }, async ackConsumerCursor(name, sequence) { acks.push(sequence); }, close() {} };
  const worker = new HeadlessAnalyzer({ workerPath: path.join(__dirname, 'fixtures', 'worker-lifecycle.cjs'), resolveProfile: () => ({ apiKey: 'test-not-a-secret', mainModel: 'quota' }) });
  let runtime = await start({ dataDir, bridge, analyzer: worker });
  try {
    runtime.store.addProject({ ...p, journalId });
    await runtime.coordinator.drain();
    await eventually(() => runtime.store.listRuns(p.projectId).some(r => r.state === 'failed') && runtime.store.listRuns(p.projectId).some(r => r.phase === 'waiting-previous'));
    const first = runtime.store.listRuns(p.projectId).find(r => r.commitSha === p.commitSha);
    assert.equal(first.error.code, 'MODEL_QUOTA_EXHAUSTED');
    assert.match(first.error.message, /额度|余额/);
    assert.equal(runtime.store.readRuntime(p.projectId).lastAnalyzedCommit, p.trackingStartCommit, 'failed analysis cannot advance the baseline');
    assert.ok(acks.includes(2), 'both jobs are durable before journal ACK');
    const ids = runtime.store.listRuns(p.projectId).map(r => r.runId);
    await runtime.close();
    let calls = 0;
    runtime = await start({ dataDir, bridge, analyzer: { async runClaim() { calls++; throw new Error('unexpected retry'); } } });
    await runtime.coordinator.drain();
    assert.deepEqual(runtime.store.listRuns(p.projectId).map(r => r.runId), ids);
    assert.equal(calls, 0, 'restart never retries exhausted quota without an explicit retry');
    const page = (await runtime.call(`/api/runs?summary=1&projectId=${p.projectId}`)).body;
    assert.equal(page.runs.length, 2);
    assert.equal(page.runs.find(r => r.commitSha === p.commitSha).error.code, 'MODEL_QUOTA_EXHAUSTED');
    assert.equal(page.runs.find(r => r.commitSha === nextSha).phase, 'waiting-previous');
  } finally { await runtime.close(); }
});
