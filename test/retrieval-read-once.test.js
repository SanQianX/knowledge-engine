'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');

async function fixture(t, documents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-read-once-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = ['project-recipe', 'project-review'].map((projectId, i) => ({
    projectId, name: ['MaskRecipeEditor401', 'MaskScanReview'][i], brainId: 'brain-default',
    domainId: 'mask', enabled: true, knowledgePath: path.join(root, projectId),
  }));
  for (const [id, entries] of Object.entries(documents)) for (const [entry, text] of Object.entries(entries)) {
    const file = path.join(projects.find(p => p.projectId === id).knowledgePath, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const store = { state: { sharedScopes: [] }, getProject: id => projects.find(p => p.projectId === id), listProjects: () => projects,
    readRuntime: () => ({ index: {} }), listRuns: () => [] };
  const retrieval = new EngineRetrieval({ store, layout: new RuntimeLayout(root), projectStore: { readState: () => ({ index: {} }) } });
  retrieval.recallIndex = async (scopes, query, candidates, health) => { health.index = 'unavailable'; };
  return { root, projects, store, retrieval };
}

test('a single retrieval reads each knowledge file at most once before the bounded final validation', async t => {
  const files = {
    'modules/plate.md': '# Plate 未保存提醒\n\nPlate 保存必须校验 dirty 状态。\n',
    'modules/export.md': '# 报表导出\n\n导出前校验 alignment 对齐参数。\n',
    'changes/ef123b6058ea.md': '# 网络连接\n\nTCP 心跳连接超时恢复。\n',
  };
  const f = await fixture(t, { 'project-recipe': files });
  const tracked = Object.keys(files).map(entry => path.join(f.projects[0].knowledgePath, entry));
  const readsByFile = new Map(Object.keys(files).map(entry => [entry, 0]));
  let readsBeforeVector = null;
  const realRead = fs.readFileSync;
  fs.readFileSync = function countedReadFileSync(target, ...rest) {
    const output = realRead.apply(this, [target, ...rest]);
    if (tracked.includes(path.resolve(String(target)))) {
      const relative = path.relative(f.projects[0].knowledgePath, String(target));
      readsByFile.set(relative, (readsByFile.get(relative) || 0) + 1);
    }
    return output;
  };
  t.after(() => { fs.readFileSync = realRead; });
  f.retrieval.recallIndex = async (scopes, query, candidates, health) => {
    readsBeforeVector = new Map(readsByFile);
    health.index = 'unavailable';
  };
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty', limit: 5 });
  assert.ok(result.results.length);
  assert.ok(readsBeforeVector, 'the vector stage must observe the read counters');
  for (const [entry, count] of readsBeforeVector) {
    assert.ok(count <= 1, `knowledge file ${entry} was fully read ${count} times before the vector stage; at most one scan pass is allowed`);
  }
});

test('plain edits and same-size same-mtime edits are always served fresh', async t => {
  const f = await fixture(t, { 'project-recipe': { 'modules/plate.md': '# Plate 旧约定\n\n旧约定：保存前不需要校验 dirty。' } });
  const first = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty', limit: 5 });
  assert.ok(first.results.length);
  const target = path.join(f.projects[0].knowledgePath, 'modules/plate.md');
  const stat = fs.statSync(target);
  fs.writeFileSync(target, '# Plate 新约定\n\n新约定：保存前必须要校验 dirty。');
  fs.utimesSync(target, stat.atime, stat.mtime);
  const second = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty', limit: 5 });
  assert.ok(second.results.length);
  assert.ok(second.results.every(r => r.chunk_text.includes('新约定')));
  assert.ok(!JSON.stringify(second).includes('不需要校验'));
});

test('documents deleted while the vector call is in flight are discarded and the next rank fills in', async t => {
  const f = await fixture(t, { 'project-recipe': {
    'modules/first.md': '# 配方导出校验\n\n配方导出校验 dirty 参数。',
    'modules/second.md': '# 导出校验\n\n导出时必须检查数组参数。' } });
  f.retrieval.recallIndex = async () => { fs.rmSync(path.join(f.projects[0].knowledgePath, 'modules/first.md')); };
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: '配方导出校验 dirty', limit: 5 });
  assert.ok(result.results.length);
  assert.ok(result.results.every(r => r.entry_id === 'modules/second.md'));
});

test('a symlink escaping the knowledge root never reaches results when the platform allows symlinks', async t => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-read-once-out-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(path.join(outsideRoot, 'secret.md'), '# 越界机密\n\n符号链接越界内容不能进入检索结果。\n');
  const f = await fixture(t, { 'project-recipe': { 'modules/plate.md': '# Plate\n\nPlate 编辑器 dirty 校验。' } });
  let linked = true;
  try {
    fs.symlinkSync(path.join(outsideRoot, 'secret.md'), path.join(f.projects[0].knowledgePath, 'modules', 'leak.md'));
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) linked = false;
    else throw error;
  }
  if (!linked) return t.skip('platform does not allow unprivileged symlinks');
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: '符号链接越界 机密', limit: 10 });
  assert.ok(result.results.every(r => r.entry_id !== 'modules/leak.md'));
});

test('internal conversation evidence and dot directories never enter scan results', async t => {
  const f = await fixture(t, { 'project-recipe': {
    'README.md': '# 项目背景\n\n配方背景知识。',
    'dev-conversations/leak.md': '# 内部会话\n\n会话证据包含 API 密钥不应该被检索。',
    '.secrets/leak.md': '# 密钥\n\nsk-secret-value 不能出现在检索结果。' } });
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: 'API 密钥 secret 会话', limit: 10 });
  assert.equal(result.results.length, 0);
  assert.ok(!JSON.stringify(result).includes('sk-secret-value'));
});

test('request-local scan sources and bodies never leak into public outputs or the engine store', async t => {
  const f = await fixture(t, { 'project-recipe': {
    'README.md': '# 项目背景\n\n配方背景知识。',
    'modules/plate.md': '# Plate 未保存提醒\n\nPlate 保存必须校验 dirty 状态。' } });
  const storeBefore = JSON.stringify(f.store);
  const outputs = [];
  outputs.push(await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty', limit: 5 }));
  outputs.push(await f.retrieval.ask({ projectId: 'project-recipe', query: 'Plate 保存 dirty' }));
  outputs.push(await f.retrieval.get({ projectId: 'project-recipe', entryId: 'modules/plate.md' }));
  outputs.push(await f.retrieval.history({ projectId: 'project-recipe' }));
  const commit = await f.retrieval.retrieveForCommit({ projectId: 'project-recipe',
    conversationSnapshot: { turns: [{ userEvents: [{ content: 'Plate 保存 dirty' }] }] },
    commitEvidence: { subject: 'Plate dirty', files: [{ path: 'modules/plate.md', status: 'M' }] } });
  outputs.push(commit, commit.manifest);
  for (const payload of outputs) {
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('"sources"'), 'the internal request-local sources map must not leak');
    assert.ok(!json.includes('"bodies"'), 'the internal request-local bodies map must not leak');
  }
  assert.equal(JSON.stringify(f.store), storeBefore, 'the engine store must not gain internal retrieval state');
});
