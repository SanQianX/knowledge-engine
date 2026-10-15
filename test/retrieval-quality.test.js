'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');
const { EngineContext } = require('../src/context');

async function fixture(t, documents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-quality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = ['project-recipe', 'project-review', 'project-other'].map((projectId, i) => ({
    projectId, name: ['MaskRecipeEditor401', 'MaskScanReview', 'Unrelated'][i], brainId: 'brain-default',
    domainId: i === 2 ? 'other-domain' : 'mask', enabled: true, knowledgePath: path.join(root, projectId),
  }));
  for (const [id, entries] of Object.entries(documents)) for (const [entry, text] of Object.entries(entries)) {
    const file = path.join(projects.find(p => p.projectId === id).knowledgePath, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const runs = [];
  const store = { state: { sharedScopes: [] }, getProject: id => projects.find(p => p.projectId === id), listProjects: () => projects,
    readRuntime: () => ({ index: {} }), listRuns: id => runs.filter(r => !id || r.projectId === id) };
  const retrieval = new EngineRetrieval({ store, layout: new RuntimeLayout(root), projectStore: { readState: () => ({ index: {} }) } });
  retrieval.recallIndex = async (scopes, query, candidates, health) => { health.index = 'unavailable'; };
  return { root, projects, runs, store, retrieval };
}

test('recent project progress selects maintained commit history, not domain semantic distractors or copied mtimes', async t => {
  const f = await fixture(t, {
    'project-recipe': { 'changes/ef123b6058ea.md': '# Plate 未保存弹窗修复\n\n首次进入 plate 编辑器不应该提醒未保存。修复初始状态，保留 dirty 追踪限制。',
      'changes/older.md': '# 调光点数组\n\n调光点由单点变成动态多点数组。' },
    'project-review': { 'modules/station.md': '# 最近开发进度\n\n' + '最近开发进度：A→B 工位坐标变换和报表导出。\n'.repeat(100) },
  });
  f.runs.push({ projectId: 'project-recipe', commitSha: 'ef123b6058ea' + '1'.repeat(28), promotedAt: '2026-10-13T08:17:00Z', staging: { operations: [{ path: 'changes/ef123b6058ea.md' }] } },
    { projectId: 'project-recipe', commitSha: 'a'.repeat(40), promotedAt: '2026-10-10T09:35:00Z', staging: { operations: [{ path: 'changes/older.md' }] } });
  fs.utimesSync(path.join(f.projects[0].knowledgePath, 'changes/older.md'), new Date(), new Date());
  const result = await f.retrieval.search({ projectId: 'project-recipe', scope: 'domain', query: 'hello 当前项目最近的进度，最近一次开发的东西是什么', limit: 5 });
  assert.equal(result.results[0]?.entry_id, 'changes/ef123b6058ea.md');
  assert.ok(result.results.every(r => r.scope_project_id === 'project-recipe'));
  assert.equal(result.intent, 'recent');
  const history = await f.retrieval.history({ projectId: 'project-recipe' });
  assert.equal(history.results[0].entry_id, 'changes/ef123b6058ea.md');
});

test('missing recent history is not reported as an empty project when other maintained knowledge exists', async t => {
  const f = await fixture(t, { 'project-recipe': { 'README.md': '# 项目背景\n\n已经保留的配方背景知识。' }, 'project-review': { 'changes/recent.md': '# 最近开发\n\n其他项目的报表改动。' } });
  const result = await f.retrieval.search({ projectId: 'project-recipe', scope: 'domain', query: '最近一次开发的东西是什么' });
  assert.equal(result.results.length, 0); assert.equal(result.matchStatus, 'no-reliable-match');
  assert.equal(result.currentProjectStatus.hasKnowledge, true); assert.match(result.currentProjectStatus.note, /不代表知识为空/);
});

test('a natural storage-location question finds storage rules without knowing the filename', async t => {
  const f = await fixture(t, { 'project-recipe': {
    'modules/vector-index-storage-root.md': '# 向量索引存储根：跟随知识根目录\n\n知识根目录非空时，向量索引保存到知识根目录下的 .indexes。实际存储位置需要读取系统状态，不能把历史文档当作这台电脑的当前配置。',
    'modules/index-rebuild.md': '# 索引重建\n\n向量索引重建会按项目重新处理已有知识文件。重建失败可以重试，成功后恢复检索。',
  }, 'project-review': { 'modules/storage.md': '# 报表存储位置\n\n检测报表保存在用户指定的输出目录。' } });
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: '我想知道我当前向量库存储的位置在哪', limit: 5 });
  assert.equal(result.results[0]?.entry_id, 'modules/vector-index-storage-root.md');
  assert.ok(result.results[0].chunk_text.includes('.indexes'));
  assert.ok(result.results.every(r => r.scope_project_id === 'project-recipe'));
});

test('greetings and unsupported broad questions do not fill results with random vector hits', async t => {
  const f = await fixture(t, { 'project-recipe': { 'README.md': '# Plate\n\nPlate 编辑器用于制作检测配方。' } });
  let requests = 0;
  f.retrieval.recallIndex = async (scopes, query, candidates, health) => { requests++; health.index = 'ok'; for (const c of candidates.values()) c.indexScore = 0.99; };
  const greeting = await f.retrieval.search({ projectId: 'project-recipe', query: '你好' });
  assert.equal(greeting.results.length, 0); assert.equal(requests, 0);
  const absent = await f.retrieval.search({ projectId: 'project-recipe', query: '量子纠缠计算机的天气预报算法' });
  assert.equal(absent.results.length, 0, 'unverified semantic scores do not prove relevance');
  assert.equal(absent.matchStatus, 'no-reliable-match');
  assert.equal(absent.backend, 'markdown-hybrid-fallback', 'an online service without verified vector hits is not hybrid success');
  const answer = await f.retrieval.ask({ projectId: 'project-recipe', query: '量子纠缠计算机的天气预报算法' });
  assert.match(answer.answer, /不代表知识为空/);
});

test('a long document contributes at most two complementary snippets, not every heading', async t => {
  const f = await fixture(t, { 'project-recipe': { 'modules/plate.md': '# Plate 未保存提醒\n\n' + Array.from({ length: 25 }, (_, i) => `## 场景 ${i}\n\nPlate 未保存提醒与 dirty 状态同步。\n`).join('\n') } });
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 未保存提醒 dirty', limit: 30 });
  assert.ok(r.results.length > 0); assert.ok(r.results.length <= 2);
});

test('known commit plus a Chinese topic delivers the actual English patch fact, not only metadata', async t => {
  const commitSha = '9aec087aa15574a3a9aecd9945ed0d62aba82d9b', entryId = 'changes/9aec087aa155.md';
  const text = `# 提交 9aec087a 新增 knowledge-policy-rc6-leader1.txt\n\n提交 ${commitSha} 新增文件，作者 Product Acceptance，主题 acceptance，提交依据完整。\n\n## Patch 证据\n\n\`\`\`diff\n+Knowledge has one writer: the engine promotion path. Preserve native workbench streaming and keep the product simple.\n\`\`\`\n\n## 事实记录\n\n本次知识只记录真实提交变化，不推测知识库为什么由引擎统一写入。该文件未修改源码、构建或 CI。\n\n## 与既有知识的对照\n\n保持知识、提交和当前维护依据一致。\n`;
  const f = await fixture(t, { 'project-recipe': { [entryId]: text } });
  f.runs.push({ projectId: 'project-recipe', commitSha, promotedAt: '2026-10-15T00:00:00Z', staging: { operations: [{ path: entryId }] } });
  f.retrieval.recallIndex = async (scopes, query, candidates, health) => {
    health.index = 'ok';
    for (const c of candidates.values()) if (!c.chunkText.includes('Knowledge has one writer')) Object.assign(c, { vectorVerified: true, vectorCalibrated: true, vectorMinScore: 0.5, indexScore: 0.9 });
  };
  const query = `请先参考注入的项目知识，简要说明知识库为什么由引擎统一写入，并引用提交 ${commitSha} 对应的真实知识依据。查询关键词：知识、提交、单写者、${commitSha}。`;
  const before = fs.readFileSync(path.join(f.projects[0].knowledgePath, entryId), 'utf8');
  const result = await f.retrieval.search({ projectId: 'project-recipe', query, limit: 5 });
  assert.ok(result.results.some(r => r.chunk_text.includes('Knowledge has one writer')), 'Patch evidence must not be squeezed out by repeated commit identifiers and metadata');
  assert.ok(result.results.length <= 2, 'preserve the document diversity limit');
  assert.ok(result.results.every((r, i, rows) => !i || rows[i - 1].score >= r.score));
  const english = await f.retrieval.search({ projectId: 'project-recipe', query: `one writer engine ${commitSha}`, limit: 2 });
  assert.ok(english.results[0].chunk_text.includes('Knowledge has one writer'));
  const identifier = await f.retrieval.search({ projectId: 'project-recipe', query: commitSha, limit: 2 });
  assert.ok(identifier.results.some(r => r.chunk_text.includes('Knowledge has one writer')), 'SHA-only ties are deterministic and retain the first actual evidence section');
  const memories = { store: { state: { memories: [] } }, brainScope: () => null, applicable: () => false };
  const context = await new EngineContext({ retrieval: f.retrieval, memories }).prepare({ projectId: 'project-recipe', query });
  assert.ok(context.facts.some(r => r.text.includes('Knowledge has one writer') && r.commitSha === commitSha));
  assert.ok(context.prompt.length <= 8000);
  assert.equal(fs.readFileSync(path.join(f.projects[0].knowledgePath, entryId), 'utf8'), before);
});

test('explicit project/domain scope remains inclusive but never leaks other-domain facts', async t => {
  const f = await fixture(t, { 'project-recipe': { 'README.md': '# 导出校验\n\n导出前校验配方参数。' },
    'project-review': { 'README.md': '# 导出校验\n\n导出前校验报表参数。' }, 'project-other': { 'README.md': '# 导出校验\n\n导出前校验参数。' } });
  const project = await f.retrieval.search({ projectId: 'project-recipe', scope: 'project', query: '导出校验' });
  assert.ok(project.results.every(r => r.scope_project_id === 'project-recipe'));
  const domain = await f.retrieval.search({ projectId: 'project-recipe', scope: 'domain', query: '导出校验' });
  assert.deepEqual([...new Set(domain.results.map(r => r.scope_project_id))].sort(), ['project-recipe', 'project-review']);
});

test('chunk mode validates body hash and only credits the matching range; stale vectors never select unrelated text', async t => {
  const text = '# 两种功能\n\n## 配方保存\n\nPlate 保存必须校验 dirty 状态。\n\n## 网络连接\n\nTCP 心跳连接超时。\n';
  const f = await fixture(t, { 'project-recipe': { 'modules/editor.md': text } });
  let stale = false, invalidRange = false;
  const vector = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('resultLevel'), 'chunk');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ resultLevel: 'chunk', model: 'mock', results: [{ project: 'project-recipe', uri: 'modules/editor.md', score: 0.95, scoreType: 'cosine',
      startPos: text.indexOf('## 配方保存'), endPos: invalidRange ? text.length + 50 : text.indexOf('## 网络连接'), bodyHash: stale ? 'bad-hash' : crypto.createHash('sha256').update(text).digest('hex') }] }));
  });
  await new Promise(resolve => vector.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => vector.close(resolve)));
  f.retrieval.vectorUrl = `http://127.0.0.1:${vector.address().port}`;
  delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty', limit: 10 });
  assert.ok(r.results.some(row => row.match_channels.includes('index:vector-hub')));
  assert.ok(r.results.every(row => !row.chunk_text.includes('TCP')));
  stale = true;
  const s = await f.retrieval.search({ projectId: 'project-recipe', query: '量子天气', limit: 10 });
  assert.equal(s.results.length, 0);
  stale = false; invalidRange = true;
  const invalid = await f.retrieval.search({ projectId: 'project-recipe', query: 'Plate 保存 dirty' });
  assert.ok(invalid.results.length); assert.ok(invalid.results.every(r => !r.match_channels.includes('index:vector-hub')));
});

test('in-flight retrieval rejects changed primary ownership and discards references moved out of the domain', async t => {
  const f = await fixture(t, { 'project-recipe': { 'README.md': '# 导出\n\n配方导出校验。' }, 'project-review': { 'README.md': '# 导出\n\n报表导出校验。' } });
  f.retrieval.recallIndex = async () => { f.projects[1].domainId = 'other-domain'; };
  const changed = await f.retrieval.search({ projectId: 'project-recipe', scope: 'domain', query: '导出校验' });
  assert.ok(changed.results.length); assert.ok(changed.results.every(r => r.scope_project_id === 'project-recipe'));
  f.retrieval.recallIndex = async () => { f.projects[0].domainId = 'new-domain'; };
  await assert.rejects(f.retrieval.search({ projectId: 'project-recipe', scope: 'domain', query: '导出校验' }), { code: 'PROJECT_SCOPE_CHANGED' });
});

test('late validation discards changed facts and fills from the next current rank without rereading unrelated files', async t => {
  const f = await fixture(t, { 'project-recipe': { 'modules/first.md': '# 配方导出校验\n\n配方导出校验 dirty 参数。', 'modules/second.md': '# 导出校验\n\n导出时必须检查数组参数。' } });
  f.retrieval.recallIndex = async () => { fs.writeFileSync(path.join(f.projects[0].knowledgePath, 'modules/first.md'), '# 已变化\n\n当前文件不再包含旧约定。'); };
  const result = await f.retrieval.search({ projectId: 'project-recipe', query: '配方导出校验 dirty' });
  assert.ok(result.results.length); assert.ok(result.results.every(r => r.entry_id === 'modules/second.md'));
  assert.ok(!JSON.stringify(result).includes('配方导出校验 dirty 参数'));
});
