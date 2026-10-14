'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EngineRetrieval } = require('../src/retrieval');
const ranking = require('../src/retrieval-ranking');
const { RuntimeLayout } = require('../src/runtime/layout');
const { EngineStore } = require('../src/store');
const { MemoryService } = require('../src/memories');

async function fixture(t, documents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-vector-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = ['project-recipe'].map(projectId => ({
    projectId, name: 'VectorVerify', brainId: 'brain-default', domainId: 'mask', enabled: true, knowledgePath: path.join(root, projectId),
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

async function vectorStub(t, handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('resultLevel'), 'chunk');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(handler(url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('a verified vector range smaller than half a lexical chunk still returns the canonical slice', async t => {
  const paragraph = '心跳保活与连接池的日常巡检背景说明，用于把词法分块撑到超过一千二百个字符的长度要求。';
  const fact = '空闲连接超过九十秒会被连接池回收并释放底层句柄。';
  const body = `# 连接池巡检\n\n${paragraph.repeat(40)}\n\n${fact}${paragraph.repeat(40)}\n`;
  const f = await fixture(t, { 'project-recipe': { 'modules/pool.md': body } });
  const startPos = body.indexOf(fact) - 100, endPos = body.indexOf(fact) + fact.length + 300;
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536, projectsSkipped: [],
    results: [{ project: 'project-recipe', uri: 'modules/pool.md', score: 0.9, scoreType: 'cosine', startPos, endPos, bodyHash: sha256(body) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '闲置链路多久清理', limit: 10 });
  assert.equal(r.results.length, 1, 'semantic hit without lexical anchors must survive chunk-size mismatch');
  assert.equal(r.results[0].entry_id, 'modules/pool.md');
  assert.equal(r.results[0].chunk_text, body.slice(startPos, endPos), 'displayed text is cut from the current canonical body at the verified half-open range');
  assert.ok(r.results[0].match_channels.includes('index:vector-hub'));
  assert.equal(r.results[0].matchReason, '已校验向量片段匹配');
  assert.match(r.results[0].chunk_id, /modules\/pool\.md:vector:/);
  assert.equal(r.health.index, 'ok');
  assert.equal(r.matchStatus, 'matched');
});

test('duplicate chunk text is located by document order, so the second occurrence gets the vector evidence', async t => {
  const section = '## 备份说明\n\n完全一致的重复内容段落出现两次，必须识别第二次出现位置。';
  const body = `# 重复约定\n\n${section}\n\n${section}\n`;
  const f = await fixture(t, { 'project-recipe': { 'modules/backup.md': body } });
  const second = body.indexOf(section, body.indexOf(section) + 1);
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536,
    results: [{ project: 'project-recipe', uri: 'modules/backup.md', score: 0.9, scoreType: 'cosine', startPos: second, endPos: second + section.length, bodyHash: sha256(body) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const retrieved = await f.retrieval.retrieve({ projectId: 'project-recipe', signals: { primaryTexts: ['重复内容'] } });
  const rows = retrieved.candidates.filter(c => c.entryId === 'modules/backup.md');
  assert.ok(rows.length);
  const withVector = rows.find(c => c.vectorVerified);
  assert.ok(withVector, 'the chunk at the second occurrence carries the verified range');
  assert.deepEqual(withVector.vectorRanges, [[second, second + section.length]]);
  assert.ok(withVector.startPos >= second, 'chunk position follows document order instead of the first index hit');
});

test('CRLF, frontmatter and leading blank lines keep one half-open coordinate system', async t => {
  const filler = '这段前置说明用于把词法块撑长，确保验证范围不足词法块长度的一半，避免整块被误认为已覆盖。';
  const raw = `---\r\nsourcepaths: [src/legacy.js]\r\n---\r\n\r\n\r\n# 夜间批处理\r\n\r\n${filler}\r\n\r\n核心约定：夜间批处理索引重建窗口为凌晨两点到四点。\r\n\r\n${filler}\r\n`;
  const body = ranking.bodyText(raw);
  const fact = '核心约定：夜间批处理索引重建窗口为凌晨两点到四点。';
  const startPos = body.indexOf(fact), endPos = startPos + fact.length;
  const f = await fixture(t, { 'project-recipe': { 'modules/nightly.md': raw } });
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536,
    results: [{ project: 'project-recipe', uri: 'modules/nightly.md', score: 0.85, scoreType: 'cosine', startPos, endPos, bodyHash: sha256(body) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '晚上的定时任务什么时候执行', limit: 10 });
  assert.equal(r.results.length, 1, 'semantic-only query survives through the canonical slice');
  assert.equal(r.results[0].chunk_text, fact, 'LF-normalized, frontmatter-stripped coordinates on both sides');
  assert.ok(r.results[0].match_channels.includes('index:vector-hub'));
});

test('overlapping and repeated vector ranges stay deduplicated and each document keeps at most two fragments', async t => {
  const sentence = '调度器专属事实的详细说明文字，内容互不重叠且服务于去重验证。';
  const sections = ['调度器', '配额', '熔断', '重试', '限流'].map(name => `## ${name}\n\n${(name + sentence).repeat(8)}`);
  const body = `# 编排次序\n\n${sections.join('\n\n')}\n`;
  const ranges = sections.map(section => { const start = body.indexOf(section) + 30; return [start, start + 80]; });
  const rows = [...ranges.map(([startPos, endPos]) => ({ project: 'project-recipe', uri: 'modules/governance.md', score: 0.9, scoreType: 'cosine', startPos, endPos, bodyHash: sha256(body) })),
    { project: 'project-recipe', uri: 'modules/governance.md', score: 0.88, scoreType: 'cosine', startPos: ranges[0][0], endPos: ranges[0][1], bodyHash: sha256(body) },
    { project: 'project-recipe', uri: 'modules/governance.md', score: 0.87, scoreType: 'cosine', startPos: ranges[1][0] + 5, endPos: ranges[1][1] - 5, bodyHash: sha256(body) }];
  const f = await fixture(t, { 'project-recipe': { 'modules/governance.md': body } });
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536, results: rows }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '五类手段如何排列先后', limit: 30 });
  assert.ok(r.results.length > 0, 'semantic-only query reaches the verified ranges');
  assert.ok(r.results.length <= 2, 'a document contributes at most two complementary fragments');
  assert.equal(new Set(r.results.map(row => row.chunk_id)).size, r.results.length, 'repeated and nested ranges are not counted twice');
});

test('stale hashes, out-of-bounds ranges, unknown projects and invalid scores are rejected with counted safe reasons', async t => {
  const fact = '唯一有效事实：令牌桶限流的补充水位默认为一半。';
  const other = '另一个段落的普通说明文字，不含查询词。';
  const body = `# 限流约定\n\n${other}\n\n${fact}\n`;
  const f = await fixture(t, { 'project-recipe': { 'modules/limits.md': body } });
  const start = body.indexOf(fact), end = start + fact.length;
  const rows = [
    { project: 'project-recipe', uri: 'modules/limits.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: sha256(body) },
    { project: 'project-recipe', uri: 'modules/limits.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: '0'.repeat(64) },
    { project: 'project-recipe', uri: 'modules/limits.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: body.length + 80, bodyHash: sha256(body) },
    { project: 'project-elsewhere', uri: 'modules/limits.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: sha256(body) },
    { project: 'project-recipe', uri: 'modules/limits.md', score: 5, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: sha256(body) },
  ];
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536, results: rows }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '桶的容量余量设置', limit: 10 });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].chunk_text, fact);
  const recall = r.health.vectorRecall || {};
  assert.equal(recall.rows, 5);
  assert.equal(recall.rejected['body-hash-mismatch'], 1);
  assert.equal(recall.rejected['invalid-range'], 1);
  assert.equal(recall.rejected['unknown-project'], 1);
  assert.equal(recall.rejected['invalid-score'], 1);
  assert.ok(!JSON.stringify(r.health).includes(fact), 'health never echoes knowledge body text');
});

test('an uncalibrated model cannot return knowledge on vector score alone', async t => {
  const fact = '专有事实：雪崩二极管的击穿电压随温度漂移。';
  const body = `# 器件笔记\n\n${fact}\n`;
  const f = await fixture(t, { 'project-recipe': { 'modules/device.md': body } });
  const start = body.indexOf(fact);
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'mystery-model', dimensions: 64,
    results: [{ project: 'project-recipe', uri: 'modules/device.md', score: 0.99, scoreType: 'cosine', startPos: start, endPos: start + fact.length, bodyHash: sha256(body) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '这种元件在高温下表现如何', limit: 10 });
  assert.equal(r.results.length, 0);
  assert.equal(r.matchStatus, 'no-reliable-match');
  assert.equal(r.backend, 'markdown-hybrid-fallback');
  assert.equal(r.health.calibration, 'lexical-support-required');
});

test('a vector hit on one range does not spread vector credit to other chunks of the document', async t => {
  const shared = '共享关键词段落。';
  const first = `## 首段\n\n${shared}首段独有补充说明一。`;
  const second = `## 次段\n\n${shared}次段独有补充说明二。`;
  const body = `# 双段文档\n\n${first}\n\n${second}\n`;
  const f = await fixture(t, { 'project-recipe': { 'modules/two.md': body } });
  const start = body.indexOf(second), end = start + second.length;
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536,
    results: [{ project: 'project-recipe', uri: 'modules/two.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: sha256(body) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const r = await f.retrieval.search({ projectId: 'project-recipe', query: '共享关键词', limit: 10 });
  assert.ok(r.results.length);
  const vectorRows = r.results.filter(row => row.match_channels.includes('index:vector-hub'));
  assert.ok(vectorRows.length);
  assert.ok(vectorRows.every(row => row.chunk_text.includes('次段独有补充说明二')), 'only the verified range carries the vector channel');
  assert.ok(r.results.filter(row => !row.match_channels.includes('index:vector-hub')).every(row => !row.chunk_text.includes('次段独有补充说明二')));
});

test('memory slices pass the memory guards while valid, and invalidation removes them via file truth', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-vector-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new EngineStore(path.join(root, 'data'));
  const project = store.addProject({ projectId: 'project-a', domainId: 'domain-one', repoPath: path.join(root, 'a', 'code'), knowledgePath: path.join(root, 'a', 'knowledge') }).project;
  fs.mkdirSync(project.knowledgePath, { recursive: true });
  fs.writeFileSync(path.join(project.knowledgePath, 'README.md'), '# 项目知识\n\n项目自身说明。\n');
  const scopes = [{ id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(root, 'shared') }];
  const service = new MemoryService(store); await service.configure(scopes);
  const retrieval = new EngineRetrieval({ store, memories: service, layout: new RuntimeLayout(store.dataDir), projectStore: { readState: id => store.readRuntime(id) } });
  const created = await service.create({ text: '必须保持零依赖交付，不引入外部运行库。', scopeType: 'global', scopeId: 'brain-default' });
  const entryPath = path.join(scopes[0].knowledgePath, 'memories/confirmed.md');
  const entryBody = ranking.bodyText(fs.readFileSync(entryPath, 'utf8'));
  const memoryStart = entryBody.indexOf('必须保持零依赖交付');
  const row = over => ({ project: 'scope-brain-brain-default', uri: 'memories/confirmed.md', score: 0.9, scoreType: 'cosine',
    startPos: memoryStart, endPos: memoryStart + 20, bodyHash: sha256(entryBody), ...over });
  const ghost = { project: 'scope-brain-brain-default', uri: 'memories/projects/project-b.md', score: 0.9, scoreType: 'cosine',
    startPos: 0, endPos: 20, bodyHash: sha256(entryBody) };
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536, results: [row(), ghost] }));
  retrieval.vectorUrl = url; delete retrieval.recallIndex;
  const found = await retrieval.search({ projectId: 'project-a', query: '打包产物里能不能加第三方件', limit: 10 });
  const memoryRows = found.results.filter(r => r.entry_id === 'memories/confirmed.md');
  assert.equal(memoryRows.length, 1, 'the verified memory slice reaches the caller through the memory guards');
  assert.equal(memoryRows[0].memoryId, created.id);
  assert.equal((found.health.vectorRecall?.rejected || {})['no-current-document'], 1, 'a memory entry outside the readable scope is rejected');
  await service.update(created.id, { status: 'ignored' });
  const invalidated = await retrieval.search({ projectId: 'project-a', query: '打包产物里能不能加第三方件', limit: 10 });
  assert.equal(invalidated.results.filter(r => r.entry_id === 'memories/confirmed.md').length, 0, 'an invalidated memory cannot return through stale vectors');
});
