'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EngineStore } = require('../src/store');
const { MemoryService } = require('../src/memories');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');
const AtomicFile = require('../src/runtime/atomic-file');
const { ConversationStore, sha256: contentSha } = require('../src/runtime/conversation-store');
const PREFERENCE_QUOTE = '保持主要功能简单，避免无必要实体。候选规则alpha；共用规则beta；单项目规则gamma；去重规则delta；旧范围规则zeta；相同内容eta；有效偏好；不能部分保存。';
const SOURCE_PROMPT = `请记住以下所有项目长期约定：${PREFERENCE_QUOTE}`;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-scoped-memory-'));
  const store = new EngineStore(path.join(root, 'data'));
  for (const [projectId, domainId] of [['project-a', 'domain-one'], ['project-b', 'domain-one'], ['project-c', 'domain-two']]) {
    const p = store.addProject({ projectId, domainId, repoPath: path.join(root, projectId, 'code'), knowledgePath: path.join(root, projectId, 'knowledge') }).project;
    fs.mkdirSync(p.knowledgePath, { recursive: true });
    fs.writeFileSync(path.join(p.knowledgePath, 'README.md'), `# 项目知识\n\n明确长期偏好：${PREFERENCE_QUOTE}\n`);
  }
  const scopes = [
    { id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(root, 'shared') },
    ...['domain-one', 'domain-two'].map(id => ({ id, brainId: 'brain-default', domainId: id, kind: 'domain', knowledgePath: path.join(root, id) })),
  ];
  const conversations = new ConversationStore({ layout: new RuntimeLayout(store.dataDir) });
  const service = new MemoryService(store, { readSnapshot: (projectId, commitSha) => conversations.readSnapshot(projectId, commitSha) }); await service.configure(scopes);
  const retrieval = new EngineRetrieval({ store, memories: service, layout: new RuntimeLayout(store.dataDir), projectStore: { readState: id => store.readRuntime(id) }, vectorUrl: 'http://127.0.0.1:1' });
  const frozen = {};
  const freeze = (projectId, commitSha = 'a'.repeat(40)) => frozen[`${projectId}:${commitSha}`] ||= conversations.writeSnapshot(projectId, { commitSha, status: 'available', turns: [{ turnId: 'turn-one', source: 'claude-code', sessionId: 'session-one', bindingKind: 'direct', userEvents: [{ eventId: `evt-${projectId}`, capturedAt: new Date().toISOString(), content: SOURCE_PROMPT, contentHash: contentSha(SOURCE_PROMPT), inputOrigin: 'human' }], assistantEvents: [] }] });
  const capture = (text, scopeType, projectId = 'project-a') => {
    const snapshot = freeze(projectId);
    service.capture({ projectId, commitSha: 'a'.repeat(40), runId: 'run-one', promotedAt: new Date().toISOString(), staging: { operations: [{ path: 'README.md', operation: 'create', evidenceReferences: [`conversation:${snapshot.snapshotHash}`] }], memoryCandidates: [{ text, entryId: 'README.md', quote: PREFERENCE_QUOTE, sourceEventId: `evt-${projectId}`, sourceHash: contentSha(SOURCE_PROMPT), scopeType: scopeType || 'domain', eligibility: { durable: true, crossProject: true, reason: '用户原话要求长期保持', scopeReason: '原话为跨项目约定' } }] } });
    return service.list().find(m => m.text === text && m.evidence.projectId === projectId);
  };
  const found = async (projectId, query, scope = 'brain') => (await retrieval.search({ projectId, query, scope })).results.filter(r => r.entry_id.startsWith('memories/'));
  t.after(() => { service.close?.(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, store, service, scopes, retrieval, capture, found, conversations };
}

test('confirmation edits content and chooses any existing target; scope filtering precedes brain-wide ranking and get', async t => {
  const f = await fixture(t);
  const candidate = f.capture('候选规则alpha');
  assert.equal(candidate.scopeType, 'domain'); assert.equal(candidate.scopeId, 'domain-one');
  assert.deepEqual(await f.found('project-a', '候选规则alpha'), []);
  const accepted = await f.service.update(candidate.id, { text: '编辑后的规则alpha', scopeType: 'project', scopeId: 'project-b', status: 'confirmed' });
  assert.equal(accepted.syncStatus, 'ready'); assert.equal(accepted.evidence.projectId, 'project-a');
  assert.deepEqual(await f.found('project-a', '规则alpha'), []);
  assert.deepEqual(await f.found('project-c', '规则alpha'), []);
  const rows = await f.found('project-b', '规则alpha', 'project'); assert.ok(rows.length); assert.ok(rows.every(r => r.chunk_text.includes('编辑后的')));
  assert.equal(rows[0].commitSha, 'a'.repeat(40));
  await assert.rejects(f.retrieval.get({ projectId: 'project-c', spaceId: rows[0].space_id, entryId: rows[0].entry_id }), { code: 'PROJECT_NOT_FOUND' });
  assert.ok((await f.retrieval.get({ projectId: 'project-b', spaceId: rows[0].space_id, entryId: rows[0].entry_id })).ok);
  await assert.rejects(f.service.update(candidate.id, { text: '不应保存', scopeType: 'domain', scopeId: 'missing-domain' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.service.list()[0].text, '编辑后的规则alpha');
});

test('invalid model candidate document IDs are reported without inventing provenance or losing valid knowledge', async t => {
  const f = await fixture(t);
  const snapshotB = f.conversations.writeSnapshot('project-a', { commitSha: 'b'.repeat(40), status: 'available', turns: [{ turnId: 'turn-again', source: 'claude-code', sessionId: 'session-again', bindingKind: 'direct', userEvents: [{ eventId: 'evt-again', capturedAt: new Date().toISOString(), content: SOURCE_PROMPT, contentHash: contentSha(SOURCE_PROMPT), inputOrigin: 'human' }], assistantEvents: [] }] });
  const sourced = { sourceEventId: 'evt-again', sourceHash: contentSha(SOURCE_PROMPT), scopeType: 'domain', eligibility: { durable: true, crossProject: true, reason: '用户原话要求长期保持', scopeReason: '原话为跨项目约定' } };
  const run = { projectId: 'project-a', commitSha: 'b'.repeat(40), runId: 'run-candidates', promotedAt: new Date().toISOString(), staging: { operations: [{ path: 'README.md', operation: 'create', evidenceReferences: [`conversation:${snapshotB.snapshotHash}`] }], memoryCandidates: [
    { text: '有效偏好', entryId: 'README.md', quote: PREFERENCE_QUOTE, ...sourced },
    { text: '有效偏好', entryId: 'README.md', quote: PREFERENCE_QUOTE, ...sourced },
    { text: '错误标识', entryId: 'candidate-minimal-scope', quote: PREFERENCE_QUOTE },
    { text: '错误引用', entryId: 'README.md', quote: '不存在的引用也超过八个字符' },
  ] } };
  const report = f.service.capture(run);
  assert.equal(report.accepted, 1); assert.equal(report.deduplicated, 1);
  assert.deepEqual(report.rejected.map(r => r.code), ['ENTRY_NOT_PROMOTED', 'QUOTE_MISMATCH']);
  assert.equal(f.service.list().length, 1); assert.ok(fs.existsSync(path.join(f.store.getProject('project-a').knowledgePath, 'README.md')));
  const before = f.store.state.memories, save = f.store.save;
  f.store.save = () => { throw Object.assign(new Error('Controlled disk write failure'), { code: 'EIO' }); };
  try { assert.throws(() => f.service.capture({ ...run, staging: { ...run.staging, memoryCandidates: [{ ...run.staging.memoryCandidates[0], text: '不能部分保存' }] } }), { code: 'EIO' }); }
  finally { f.store.save = save; }
  assert.deepEqual(f.store.state.memories, before);
});

test('global and domain memories remain independent, move safely, and follow current domain membership', async t => {
  const f = await fixture(t);
  const global = f.capture('共用规则beta', 'global');
  await f.service.update(global.id, { status: 'confirmed', scopeType: 'global', scopeId: 'brain-default' });
  for (const id of ['project-a', 'project-b', 'project-c']) assert.ok((await f.found(id, '共用规则beta', 'project')).length);
  await f.service.update(global.id, { scopeType: 'domain', scopeId: 'domain-two' });
  assert.deepEqual(await f.found('project-a', '共用规则beta'), []); assert.ok((await f.found('project-c', '共用规则beta')).length);
  assert.ok(!fs.readFileSync(f.service.file(f.scopes[0]), 'utf8').includes('共用规则beta'));
  f.store.addProject({ ...f.store.getProject('project-a'), domainId: 'domain-two' });
  assert.ok((await f.found('project-a', '共用规则beta')).length);
  const local = f.capture('单项目规则gamma'); await f.service.update(local.id, { status: 'confirmed', scopeType: 'project', scopeId: 'project-a' });
  f.store.removeProject('project-a');
  assert.equal(f.service.list().find(m => m.id === local.id).targetAvailable, false);
  assert.ok((await f.found('project-c', '共用规则beta')).length);
  assert.ok(!(await f.found('project-c', '单项目规则gamma')).some(r => r.memoryId === local.id));
});

test('scoped duplicate keys and extraction tombstones survive edits and restart; legacy v5 remains global', async t => {
  const f = await fixture(t);
  const one = f.capture('去重规则delta'); await f.service.update(one.id, { text: '编辑规则delta', scopeType: 'global', scopeId: 'brain-default' });
  f.capture('去重规则delta'); assert.equal(f.service.list().length, 1);
  await f.service.update(one.id, { status: 'ignored' }); f.capture('去重规则delta'); assert.equal(f.service.list().length, 1);
  assert.equal(f.capture('去重规则delta', undefined, 'project-b'), undefined, '同领域重复指纹不再新建候选');
  const legacy = { id: 'memory-legacy', fingerprint: 'legacy', brainId: 'brain-default', text: '历史全局规则epsilon', status: 'confirmed', evidence: { projectId: 'project-a', commitSha: 'b'.repeat(40), entryId: 'README.md', quote: PREFERENCE_QUOTE } };
  f.store.state.memories.push(legacy); f.store.save(); await f.service.recover();
  const restarted = new MemoryService(new EngineStore(f.store.dataDir)); t.after(() => restarted.close?.()); await restarted.recover();
  assert.equal(restarted.list().find(m => m.id === legacy.id).scopeType, 'global');
  assert.ok((await f.found('project-c', '历史全局规则epsilon')).length);
  assert.equal(restarted.list({ scopeType: 'domain', scopeId: 'domain-one' }).length, 0);
});

test('a failed old-scope rewrite never leaks stale memory after moving; retry repairs only projections', async t => {
  const f = await fixture(t); const m = f.capture('旧范围规则zeta', 'global'); await f.service.update(m.id, { status: 'confirmed' });
  const original = AtomicFile.writeFileAtomic;
  AtomicFile.writeFileAtomic = (file, ...args) => { if (file === f.service.file(f.scopes[0])) throw Object.assign(new Error('controlled locked file'), { code: 'EACCES' }); return original(file, ...args); };
  try {
    const result = await f.service.update(m.id, { scopeType: 'project', scopeId: 'project-a' });
    assert.equal(result.status, 'confirmed'); assert.equal(result.syncStatus, 'pending');
    assert.deepEqual(await f.found('project-c', '旧范围规则zeta'), []);
  } finally { AtomicFile.writeFileAtomic = original; }
  await f.service.recover(); assert.equal(f.service.list().find(x => x.id === m.id).syncStatus, 'ready');
  assert.ok((await f.found('project-a', '旧范围规则zeta')).length); assert.deepEqual(await f.found('project-b', '旧范围规则zeta'), []);
});

test('candidate validation, concurrent review, malformed state and failed state writes preserve confirmed evidence', async t => {
  const f = await fixture(t), one = f.capture('相同内容eta'), two = f.capture('相同内容eta', 'domain', 'project-c');
  await assert.rejects(f.service.update(one.id, { scopeId: '' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.update(one.id, { evidence: {} }), { code: 'INVALID_ARGUMENT' });
  await f.service.update(one.id, { scopeType: 'global', scopeId: 'brain-default', status: 'confirmed' });
  await assert.rejects(f.service.update(two.id, { scopeType: 'global', scopeId: 'brain-default', status: 'confirmed' }), { code: 'MEMORY_DUPLICATE' });
  const before = JSON.stringify(f.store.state.memories), bytes = fs.readFileSync(f.store.file), original = f.store.save;
  f.store.save = () => { throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(f.service.update(one.id, { text: '不应持久化' }), { code: 'ENOSPC' }); } finally { f.store.save = original; }
  assert.equal(JSON.stringify(f.store.state.memories), before); assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  await Promise.all([f.service.update(one.id, { text: '首次并发编辑eta' }), f.service.update(one.id, { text: '最后并发编辑eta' })]);
  assert.equal(f.service.list().find(m => m.id === one.id).text, '最后并发编辑eta');
  f.store.removeProject('project-b'); await f.service.update(two.id, { status: 'ignored' });
  assert.equal(f.service.list().find(m => m.id === two.id).status, 'ignored');
  const state = JSON.parse(fs.readFileSync(f.store.file)); state.memories[0].scopeId = '../escape';
  AtomicFile.writeJsonAtomic(f.store.file, state);
  await assert.rejects(async () => new EngineStore(f.store.dataDir), { code: 'DATA_CORRUPT' });
});
