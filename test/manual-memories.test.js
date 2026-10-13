'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const engineRoot = process.env.KB_MANUAL_MEMORY_ENGINE_ROOT ? path.resolve(process.env.KB_MANUAL_MEMORY_ENGINE_ROOT) : path.resolve(__dirname, '..');
const { EngineStore } = require(path.join(engineRoot, 'src/store'));
const { MemoryService } = require(path.join(engineRoot, 'src/memories'));
const { EngineRetrieval } = require(path.join(engineRoot, 'src/retrieval'));
const { EngineContext } = require(path.join(engineRoot, 'src/context'));
const { RuntimeLayout } = require(path.join(engineRoot, 'src/runtime/layout'));
const { createEngineServer } = require(path.join(engineRoot, 'src/server'));
const AtomicFile = require(path.join(engineRoot, 'src/runtime/atomic-file'));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-manual-memory-'));
  const closers = [];
  const store = new EngineStore(path.join(root, 'data'));
  const memories = new MemoryService(store);
  const scopes = [{ id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(root, 'shared') },
    ...['domain-one', 'domain-two'].map(id => ({ id, brainId: 'brain-default', kind: 'domain', knowledgePath: path.join(root, id) }))];
  await memories.configure(scopes);
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await memories.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('engine-manual-memory-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const register = () => {
    for (const [projectId, domainId] of [['project-a', 'domain-one'], ['project-b', 'domain-one'], ['project-c', 'domain-two']]) {
      store.addProject({ projectId, domainId, repoPath: path.join(root, projectId, 'code'), knowledgePath: path.join(root, projectId, 'knowledge') });
      fs.mkdirSync(store.getProject(projectId).knowledgePath, { recursive: true });
    }
  };
  const retrieval = new EngineRetrieval({ store, memories, layout: new RuntimeLayout(store.dataDir), projectStore: { readState: id => store.readRuntime(id) } });
  retrieval.recallIndex = async (scopes, query, candidates, health) => { health.index = 'degraded'; };
  const context = new EngineContext({ retrieval, memories });
  const create = (text, scopeType = 'global', scopeId = 'brain-default') => memories.create({ text, brainId: 'brain-default', scopeType, scopeId });
  return { root, store, memories, retrieval, context, register, create, scopes, onCleanup: close => closers.push(close) };
}

test('manual global memory works before project import; scoped memory persists, is editable and enters only applicable contexts', async t => {
  const f = await fixture(t);
  const global = await f.create('手动全局约定：保持功能简单');
  assert.equal(global.sourceType, 'manual'); assert.equal(global.status, 'confirmed'); assert.equal(global.evidence, null);
  assert.equal(global.syncStatus, 'ready'); assert.equal(f.store.listProjects().length, 0);
  f.register();
  const domain = await f.create('手动领域约定：错误文案用中文', 'domain', 'domain-one');
  const local = await f.create('手动项目约定：导出版本固定为42', 'project', 'project-a');
  for (const [id, expected] of [['project-a', [local.id, domain.id, global.id]], ['project-b', [domain.id, global.id]], ['project-c', [global.id]]]) {
    const result = await f.context.prepare({ projectId: id, query: '开发一个导出功能', scope: 'brain' });
    assert.deepEqual(result.memories.map(m => m.memoryId), expected);
    assert.ok(result.memories.every(m => m.commitSha === null && m.sourceProjectId === null && m.sourceType === 'manual'));
    const rows = (await f.retrieval.search({ projectId: id, query: '手动约定', scope: 'brain' })).results.filter(r => r.memoryId);
    assert.deepEqual(rows.map(r => r.memoryId).sort(), [...expected].sort()); assert.ok(rows.every(r => r.commitSha === null));
  }
  const rows = (await f.retrieval.search({ projectId: 'project-a', query: '手动项目约定', scope: 'brain' })).results;
  const row = rows.find(r => r.memoryId === local.id); assert.ok(row);
  await assert.rejects(f.retrieval.get({ projectId: 'project-c', spaceId: row.space_id, entryId: row.entry_id }), { code: 'PROJECT_NOT_FOUND' });
  await f.memories.update(local.id, { text: '手动项目约定：修改为43', scopeType: 'project', scopeId: 'project-b' });
  assert.ok(!(await f.context.prepare({ projectId: 'project-a', query: '开发导出' })).memories.some(m => m.memoryId === local.id));
  assert.equal((await f.context.prepare({ projectId: 'project-b', query: '开发导出' })).memories.find(m => m.memoryId === local.id).text, '手动项目约定：修改为43');
  assert.ok(!fs.readFileSync(f.memories.file(f.scopes[0], 'memories/projects/project-a.md'), 'utf8').includes('导出版本固定为42'));
  const persisted = new MemoryService(new EngineStore(f.store.dataDir));
  try { await persisted.recover(); assert.equal(persisted.list().find(m => m.id === local.id).sourceType, 'manual'); assert.equal(persisted.list().find(m => m.id === local.id).syncStatus, 'ready'); }
  finally { await persisted.close(); }
  assert.equal(f.store.listRuns().length, 0, 'manual creation never starts an analysis task');
});

test('manual create validates input and provenance, serializes duplicates and preserves durable state on failure', async t => {
  const f = await fixture(t); f.register();
  const before = fs.readFileSync(f.store.file);
  for (const input of [null, [], {}, { text: ' ' }, { text: 'x'.repeat(2001) }, { text: 'x', evidence: {} }, { text: 'x', sourceType: 'agent' }, { text: 'x', status: 'candidate' },
    { text: 'x', scopeType: 'domain', scopeId: 'missing' }, { text: 'x', scopeType: 'project', scopeId: '../escape' }, { text: 'x', brainId: 'missing' }]) {
    await assert.rejects(f.memories.create(input), { code: 'INVALID_ARGUMENT' }); assert.deepEqual(fs.readFileSync(f.store.file), before);
  }
  const results = await Promise.allSettled([f.create('相同手动约定'), f.create('相同手动约定')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'MEMORY_DUPLICATE');
  await assert.rejects(f.create('  相同手动约定  '), { code: 'MEMORY_DUPLICATE' });
  await f.create('相同手动约定', 'project', 'project-a');
  const bytes = fs.readFileSync(f.store.file), records = structuredClone(f.store.state.memories), save = f.store.save;
  f.store.save = () => { throw Object.assign(new Error('controlled full disk'), { code: 'ENOSPC' }); };
  try { await assert.rejects(f.create('不能部分保存'), { code: 'ENOSPC' }); }
  finally { f.store.save = save; }
  assert.deepEqual(f.store.state.memories, records); assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  const state = JSON.parse(bytes); state.memories[0].evidence = { projectId: 'fake', commitSha: 'a'.repeat(40) };
  AtomicFile.writeJsonAtomic(f.store.file, state);
  assert.throws(() => new EngineStore(f.store.dataDir), { code: 'DATA_CORRUPT' });
});

test('HTTP create emits real progress, persists without fake commits, rejects cross-origin writes and reports failed projection honestly', async t => {
  const f = await fixture(t); f.register();
  const app = createEngineServer({ store: f.store, consume: false, managed: true, vectorUrl: 'http://127.0.0.1:1' });
  await app.ready; await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  f.onCleanup(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, events = [];
  app.coordinator.on('progress', event => events.push(event));
  const post = async (body, origin) => {
    const r = await fetch(base + '/api/memories', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const input = { text: '来自网页的手动记忆 <img src=x onerror=alert(1)>', scopeType: 'project', scopeId: 'project-a' };
  assert.equal((await post(input, 'https://untrusted.invalid')).status, 403);
  assert.equal((await post({ ...input, evidence: { commitSha: 'a'.repeat(40) } })).status, 400);
  const saved = await post(input); assert.equal(saved.status, 200); assert.equal(saved.json.memory.status, 'confirmed');
  assert.ok(events.some(e => e.type === 'memory.created')); assert.equal(saved.json.memory.evidence, null);
  const snapshot = await (await fetch(base + '/api/snapshot')).json(); assert.equal(snapshot.memories.length, 1);
  const file = app.coordinator.memories.file(f.scopes[0], 'memories/projects/project-a.md');
  assert.match(fs.readFileSync(file, 'utf8'), /来源：手动添加/); assert.ok(!fs.readFileSync(file, 'utf8').includes('undefined'));
  const write = AtomicFile.writeFileAtomic;
  AtomicFile.writeFileAtomic = (file, ...args) => { if (file.endsWith('confirmed.md')) throw Object.assign(new Error('controlled locked projection'), { code: 'EACCES' }); return write(file, ...args); };
  let pending;
  try { pending = await post({ text: '手动全局写入待恢复' }); assert.equal(pending.json.memory.syncStatus, 'pending'); }
  finally { AtomicFile.writeFileAtomic = write; }
  assert.equal(pending.json.memory.status, 'confirmed'); assert.equal(new EngineStore(f.store.dataDir).state.memories.length, 2);
  await app.coordinator.memories.recover(); assert.equal(app.coordinator.memories.list().find(m => m.id === pending.json.memory.id).syncStatus, 'ready');
  assert.equal(app.store.listRuns().length, 0);
  await app.close();
  const restarted = createEngineServer({ dataDir: f.store.dataDir, consume: false, managed: true, vectorUrl: 'http://127.0.0.1:1' });
  f.onCleanup(() => restarted.close());
  await restarted.ready; await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
  const again = await (await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/memories`)).json();
  assert.equal(again.memories.length, 2); assert.ok(again.memories.every(m => m.sourceType === 'manual' && m.evidence === null && m.syncStatus === 'ready'));
  await restarted.close();
});
