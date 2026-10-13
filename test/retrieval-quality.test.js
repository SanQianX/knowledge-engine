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
