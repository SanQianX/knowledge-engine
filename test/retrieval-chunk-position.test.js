'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chunkMarkdown, CHUNKER_VERSION } = require('../src/runtime/markdown-knowledge-indexer');
const ranking = require('../src/retrieval-ranking');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');
const { EngineStore } = require('../src/store');
const { MemoryService } = require('../src/memories');

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const filler = '心跳保活与连接池的日常巡检背景说明，用于把词法分块撑到超过一千二百个字符的长度要求。';

async function fixture(t, documents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-chunk-pos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = ['project-recipe'].map(projectId => ({
    projectId, name: 'ChunkPosition', brainId: 'brain-default', domainId: 'mask', enabled: true, knowledgePath: path.join(root, projectId),
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

test('the chunker emits verifiable half-open offsets for every chunk', () => {
  const raw = `---\r\nsourcepaths: [src/legacy.js]\r\n---\r\n\r\n\r\n# 夜间批处理\r\n\r\n${filler}\r\n\r\n核心约定：夜间批处理索引重建窗口为凌晨两点到四点。\r\n\r\n${filler}\r\n`;
  const parsed = ranking.bodyText(raw);
  const chunks = chunkMarkdown(raw);
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    assert.ok(Number.isInteger(chunk.startPos), 'startPos is an integer offset');
    assert.ok(Number.isInteger(chunk.endPos), 'endPos is an integer offset');
    assert.ok(chunk.startPos >= 0 && chunk.endPos > chunk.startPos && chunk.endPos <= parsed.length, 'the range stays inside the canonical body');
    assert.equal(parsed.slice(chunk.startPos, chunk.endPos), chunk.chunkText, 'the canonical body slices to the exact chunk text');
  }
  for (let i = 1; i < chunks.length; i += 1) assert.ok(chunks[i].startPos >= chunks[i - 1].startPos, 'document order is preserved');
});

test('identical repeated sections each keep their own occurrence offsets', () => {
  const section = '## 备份说明\n\n完全一致的重复内容段落出现两次，必须识别第二次出现位置。';
  const body = `# 重复约定\n\n${section}\n\n${section}\n`;
  const parsed = ranking.bodyText(body);
  const chunks = chunkMarkdown(body).filter(c => c.headingPath.includes('备份说明'));
  assert.equal(chunks.length, 2);
  const first = body.indexOf(section), second = body.indexOf(section, first + 1);
  assert.deepEqual([chunks[0].startPos, chunks[0].endPos], [first, first + section.length], 'the first occurrence owns its true range');
  assert.deepEqual([chunks[1].startPos, chunks[1].endPos], [second, second + section.length], 'the second occurrence owns its true range');
  assert.ok(chunks[1].startPos >= chunks[0].endPos, 'the duplicate is not collapsed onto the first index hit');
  for (const chunk of chunks) assert.equal(parsed.slice(chunk.startPos, chunk.endPos), chunk.chunkText);
});

test('split windows expose true offsets and never overlap beyond the configured overlap', () => {
  for (const options of [{}, { maxChars: 300, overlapChars: 50 }, { maxChars: 480, overlapChars: 30 }]) {
    const body = `# 长文分块\n\n${filler.repeat(40)}\n`;
    const parsed = ranking.bodyText(body);
    const chunks = chunkMarkdown(body, options);
    assert.ok(chunks.length > 1, `long periodic text splits under ${JSON.stringify(options)}`);
    // Mirror the chunker's own falsy-safe default before the maxChars/3 cap.
    const overlapChars = Math.min(Number(options.overlapChars ?? 120), Math.floor(Number(options.maxChars ?? 1200) / 3));
    for (let i = 1; i < chunks.length; i += 1) {
      assert.ok(chunks[i - 1].endPos - chunks[i].startPos <= overlapChars, `window overlap stays within the bound under ${JSON.stringify(options)}`);
    }
    for (const chunk of chunks) assert.equal(parsed.slice(chunk.startPos, chunk.endPos), chunk.chunkText, `slice invariant holds under ${JSON.stringify(options)}`);
  }
});

test('hash signs inside code fences never act as headings', () => {
  const body = [
    '# 围栏文档', '',
    '正文段落一，说明脚本约定。', '',
    '```bash', '# 这不是标题而是一条注释', 'echo ok', '```', '',
    '## 真实小节', '',
    '小节正文说明。', '',
    '~~~', '# 波浪围栏内的注释也不算标题', '~~~', '',
  ].join('\n') + '\n';
  const parsed = ranking.bodyText(body);
  const chunks = chunkMarkdown(body);
  for (const chunk of chunks) {
    assert.ok(!chunk.headingPath.some(heading => heading.includes('注释')), 'fenced comments are not headings');
    assert.equal(parsed.slice(chunk.startPos, chunk.endPos), chunk.chunkText);
  }
  assert.ok(chunks.find(c => c.headingPath.join('>') === '围栏文档>真实小节'), 'the real section keeps its heading path');
  const fenceHome = chunks.find(c => c.chunkText.includes('# 这不是标题而是一条注释'));
  assert.ok(fenceHome && fenceHome.headingPath.includes('围栏文档'), 'fenced content stays inside the surrounding section');
});

test('a vector range covering most of a lexical chunk still yields the exact independent slice', async t => {
  const fact = '调度器在峰值水位会主动降级并推迟非关键任务。';
  const body = `# 编排降级\n\n${fact}${filler}\n`;
  const parsed = ranking.bodyText(body);
  const start = parsed.indexOf(fact), end = start + Math.floor((fact.length + filler.length) * 0.6);
  const f = await fixture(t, { 'project-recipe': { 'modules/orchestrator.md': body } });
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536,
    results: [{ project: 'project-recipe', uri: 'modules/orchestrator.md', score: 0.9, scoreType: 'cosine', startPos: start, endPos: end, bodyHash: sha256(parsed) }] }));
  f.retrieval.vectorUrl = url; delete f.retrieval.recallIndex;
  const retrieved = await f.retrieval.retrieve({ projectId: 'project-recipe', signals: { primaryTexts: ['降级推迟了哪些任务'] } });
  const slice = retrieved.candidates.find(c => c.fromVectorRange);
  assert.ok(slice, 'the independent slice survives even though the lexical chunk is mostly covered');
  assert.equal(slice.startPos, start, 'the slice keeps the exact verified start');
  assert.equal(slice.endPos, end, 'the slice keeps the exact verified end');
  assert.equal(slice.chunkText, parsed.slice(start, end), 'the slice text is the precise canonical range');
  assert.equal(slice.scopeWeight, 1, 'a primary project document keeps full weight');
  const lexical = retrieved.candidates.find(c => !c.fromVectorRange && c.entryId === 'modules/orchestrator.md');
  assert.ok(lexical, 'the lexical chunk is still revalidated and returned');
  assert.deepEqual(lexical.vectorRanges, [[start, end]], 'the merged coverage records the precise range');
  const perDoc = retrieved.candidates.filter(c => c.entryId === 'modules/orchestrator.md');
  assert.ok(perDoc.length <= 2, 'a document still contributes at most two fragments');
});

test('vector slices inherit the anchor memory weight so project outranks domain outranks global', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-vector-weight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new EngineStore(path.join(root, 'data'));
  const project = store.addProject({ projectId: 'project-a', domainId: 'domain-one', brainId: 'brain-default', repoPath: path.join(root, 'a', 'code'), knowledgePath: path.join(root, 'a', 'knowledge') }).project;
  fs.mkdirSync(project.knowledgePath, { recursive: true });
  fs.writeFileSync(path.join(project.knowledgePath, 'README.md'), '# 项目知识\n\n项目自身说明。\n');
  const scopes = [
    { id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(root, 'shared-brain') },
    { id: 'domain-one', brainId: 'brain-default', domainId: 'domain-one', kind: 'domain', knowledgePath: path.join(root, 'shared-domain') },
  ];
  const service = new MemoryService(store); await service.configure(scopes);
  await service.create({ text: '全局记忆：所有交付必须保持离线可构建，不依赖外部网络。', scopeType: 'global', scopeId: 'brain-default' });
  await service.create({ text: '领域记忆：领域内所有服务必须复用统一的日志门面。', scopeType: 'domain', scopeId: 'domain-one' });
  await service.create({ text: '项目记忆：本项目必须优先修复测试金字塔的回归裂缝。', scopeType: 'project', scopeId: 'project-a' });
  const retrieval = new EngineRetrieval({ store, memories: service, layout: new RuntimeLayout(store.dataDir), projectStore: { readState: id => store.readRuntime(id) } });
  const rows = ['memories/confirmed.md', 'memories/domains/domain-one.md', 'memories/projects/project-a.md'].map(entry => {
    const entryBody = ranking.bodyText(fs.readFileSync(path.join(scopes[0].knowledgePath, entry), 'utf8'));
    const at = entryBody.indexOf('必须');
    return { project: 'scope-brain-brain-default', uri: entry, score: 0.9, scoreType: 'cosine', startPos: at, endPos: at + 16, bodyHash: sha256(entryBody) };
  });
  const url = await vectorStub(t, () => ({ resultLevel: 'chunk', model: 'embo-01', dimensions: 1536, results: rows }));
  retrieval.vectorUrl = url; delete retrieval.recallIndex;
  const retrieved = await retrieval.retrieve({ projectId: 'project-a', signals: { primaryTexts: ['优先次序怎样裁定'] } });
  const slices = retrieved.candidates.filter(c => c.fromVectorRange);
  assert.equal(slices.length, 3, 'each memory scope contributes one independent slice');
  const weight = entry => retrieved.candidates.find(c => c.fromVectorRange && c.entryId === entry).scopeWeight;
  assert.equal(weight('memories/projects/project-a.md'), 1, 'a project memory keeps full weight instead of the brain scope weight');
  assert.equal(weight('memories/domains/domain-one.md'), 0.75, 'a domain memory keeps its own weight');
  assert.equal(weight('memories/confirmed.md'), 0.6, 'a global memory keeps its own weight');
  assert.ok(weight('memories/projects/project-a.md') > weight('memories/domains/domain-one.md')
    && weight('memories/domains/domain-one.md') > weight('memories/confirmed.md'), 'project > domain > global');
  assert.equal(retrieved.health.verifiedVectorChunks, 0, 'slice-only recall does not count lexical chunks as verified');
  assert.equal(retrieved.health.verifiedVectorSlices, 3, 'slice statistics count the independent fragments');
});

test('chunker version 2 separates stale version-1 cached records through the delta overlay', async t => {
  assert.equal(CHUNKER_VERSION, 2, 'fence-aware heading boundaries require a chunker version bump');
  const body = [
    '# 围栏文档', '',
    '正文段落一，说明脚本约定。', '',
    '```bash', '# 这不是标题而是一条注释', 'echo ok', '```', '',
    '## 真实小节', '',
    '小节正文说明。', '',
  ].join('\n') + '\n';
  const plain = '# 普通文档\n\n普通正文说明。\n';
  const f = await fixture(t, { 'project-recipe': { 'modules/scripts.md': body, 'modules/plain.md': plain } });
  const manifestFile = f.retrieval.layout.getRuntimePath('index-sources', 'project-recipe.json');
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  // A version-1-era cache: the version-1 chunker still counted fenced '#'
  // comments as headings and the manifest seals the version-1 document hash.
  fs.writeFileSync(manifestFile, JSON.stringify({ schema: 'knowledge-index-source-manifest/v1', projectId: 'project-recipe', entries: {
    'modules/scripts.md': { documentHash: sha256(`chunker:1\n${body}`) },
    'modules/plain.md': { documentHash: sha256(`chunker:2\n${plain}`) },
  } }));
  const retrieved = await f.retrieval.retrieve({ projectId: 'project-recipe', signals: { primaryTexts: ['说明'] } });
  const stale = retrieved.candidates.filter(c => c.entryId === 'modules/scripts.md');
  assert.ok(stale.length >= 1, 'current file text is still served from the real source');
  for (const c of stale) {
    assert.equal(c.fromOverlay, true, 'a version-1 cached record is never reused as current version-2 fact');
    assert.ok(!c.headingPath.some(h => h.includes('注释')), 'the version-1 pseudo headings do not come back');
  }
  const parsed = ranking.bodyText(body);
  for (const c of stale) assert.equal(parsed.slice(c.startPos, c.endPos), c.chunkText, 'version-2 offsets stay verifiable against the real file');
  const fresh = retrieved.candidates.filter(c => c.entryId === 'modules/plain.md');
  assert.ok(fresh.length >= 1);
  assert.ok(fresh.every(c => c.fromOverlay === false), 'an up-to-date version-2 record stays off the overlay');
  const health = retrieved.health.scopes.find(s => s.projectId === 'project-recipe');
  assert.equal(health.overlayEntries, 1, 'exactly the stale entry is counted for on-demand derived-index rebuild');
});
