'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const AtomicFile = require('../../src/runtime/atomic-file');
const { RuntimeLayout } = require('../../src/runtime/layout');
const { EngineRetrieval } = require('../../src/retrieval');

async function main() {
  const real = process.argv.includes('--real');
  const owned = path.resolve(__dirname, '../../.agent-state/temporary'); fs.mkdirSync(owned, { recursive: true });
  const at = process.argv.indexOf('--fixture');
  const existing = at < 0 ? null : path.resolve(process.argv[at + 1]);
  const root = existing || fs.mkdtempSync(path.join(owned, 'retrieval-performance-'));
  if (path.dirname(root) !== owned || !path.basename(root).startsWith('retrieval-performance-')) throw new Error('INVALID_FIXTURE_ROOT');
  const reportFile = path.resolve(__dirname, `../../.agent-state/acceptance/retrieval-quality/performance-${Date.now()}.json`);
  const report = { schema: 'retrieval-performance/v1', passed: false, mode: real ? '1000 synthetic documents, real MiniMax embeddings and disk vector indexes' : '1000 synthetic documents, canonical text only; not vector performance', node: process.version, projects: 8, documents: 1000, durations: [] };
  const save = () => AtomicFile.writeJsonAtomic(reportFile, report);
  let server;
  try {
    const projects = Array.from({ length: 8 }, (_, i) => ({ projectId: `project-bench-${i}`, name: `性能项目 ${i}`, brainId: 'brain-default', domainId: 'bench', enabled: true, knowledgePath: path.join(root, `project-${i}`) }));
    if (!existing) for (const project of projects) for (let i = 0; i < 125; i++) {
      AtomicFile.writeFileAtomic(path.join(project.knowledgePath, `modules/component-${i}.md`), `# Component ${i}\n\n组件 ${i} 保存配方前检查 dirty 状态与未保存弹窗，导出报表校验 alignment 对齐参数。\n\n## 连接恢复\n\n网络连接超时后保留有效数据，重新连接时核对任务进度。所属项目 ${project.projectId}。\n`);
    }
    const store = { state: { sharedScopes: [] }, getProject: id => projects.find(p => p.projectId === id), listProjects: () => projects, readRuntime: () => ({ index: {} }), listRuns: () => [] };
    let vectorUrl = 'http://127.0.0.1:1';
    if (real) {
      const { ProfileStore } = require('../../../claude-ai-workbench/packages/server/lib/profile-store');
      const settings = new ProfileStore({ dataDir: path.join(os.homedir(), '.project-knowledge-v5/workbench') }).embeddingRuntime();
      if (!settings?.apiKey || settings.provider !== 'minimax') throw new Error('REAL_MINIMAX_EMBEDDING_REQUIRED');
      const { VectorHub } = require('../../../vector-hub/dist/cjs/core/hub');
      const { createMiniMaxEmbeddings } = require('../../../vector-hub/dist/cjs/core/embeddings');
      let queryCalls = 0, documentCalls = 0;
      const documentVectors = new Map();
      const base = createMiniMaxEmbeddings(settings.apiKey, { model: settings.model, ...(settings.endpoint ? { endpoint: settings.endpoint } : {}) });
      const embeddings = { maxTokens: base.maxTokens, model: settings.model, async createEmbeddings(input) {
        if (typeof input === 'string') { queryCalls++; return base.createEmbeddings(input); }
        const ids = input.map(text => crypto.createHash('sha256').update(text).digest('hex'));
        const missing = [...new Set(ids.filter(id => !documentVectors.has(id)))];
        if (missing.length) {
          documentCalls++;
          const fresh = await base.createEmbeddings(missing.map(id => input[ids.indexOf(id)]));
          if (fresh.status !== 'success') return fresh;
          missing.forEach((id, i) => documentVectors.set(id, fresh.output[i]));
        }
        return { status: 'success', output: ids.map(id => documentVectors.get(id)) };
      } };
      const hub = new VectorHub({ rootPath: path.join(root, '.indexes'), embeddings });
      if (!existing) for (const project of projects) { await hub.syncFolder(project.projectId, project.knowledgePath); process.stdout.write(`Indexed ${project.projectId}\n`); }
      report.documentEmbedding = { calls: documentCalls, distinctTexts: documentVectors.size, reuse: 'identical-text vectors only; every stored vector originates from real MiniMax output' };
      report.indexes = projects.map(project => {
        const index = JSON.parse(fs.readFileSync(path.join(root, '.indexes', project.projectId, 'index.json')));
        const catalog = JSON.parse(fs.readFileSync(path.join(root, '.indexes', project.projectId, 'catalog.json')));
        const documents = Object.keys(catalog.uriToId).length;
        const realVectors = index.items.length > 0 && index.items.every(item => item.vector.length === 1536 && item.vector.every(Number.isFinite));
        if (documents !== 125 || !realVectors) throw new Error('REAL_BENCHMARK_INDEX_REQUIRED');
        return { projectId: project.projectId, documents, chunks: index.items.length, dimensions: 1536 };
      });
      server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const result = await hub.search(url.searchParams.get('q'), { projects: url.searchParams.get('projects').split(','), resultLevel: 'chunk', perProjectLimit: 30, maxResults: 50 });
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
        } catch { res.writeHead(503); res.end('{"error":"VECTOR_QUERY_FAILED"}'); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); vectorUrl = `http://127.0.0.1:${server.address().port}`;
      report.embedding = { model: settings.model, provider: settings.provider };
      report.queryCalls = () => queryCalls;
    }
    const retrieval = new EngineRetrieval({ store, layout: new RuntimeLayout(root), projectStore: { readState: () => ({ index: {} }) }, vectorUrl });
    const profile = { scanMs: 0, vectorMs: 0, pathMs: 0, pathCalls: 0 };
    const scan = retrieval.scanCurrent.bind(retrieval), recall = retrieval.recallIndex.bind(retrieval), inside = retrieval.layout.isPathInside.bind(retrieval.layout);
    retrieval.scanCurrent = (...args) => { const started = performance.now(); try { return scan(...args); } finally { profile.scanMs += performance.now() - started; } };
    retrieval.recallIndex = async (...args) => {
      const started = performance.now();
      try {
        const result = await recall(...args);
        if (!report.firstVectorDiagnostic) report.firstVectorDiagnostic = { health: args[3], ranges: [...args[2].values()].filter(c => c.vectorRanges?.length).slice(0, 5).map(c => ({ verified: c.vectorVerified === true, length: c.chunkText.length, ranges: c.vectorRanges.map(range => range[1] - range[0]), indexScore: c.indexScore })) };
        return result;
      } finally { profile.vectorMs += performance.now() - started; }
    };
    retrieval.layout.isPathInside = (...args) => { const started = performance.now(); try { return inside(...args); } finally { profile.pathMs += performance.now() - started; profile.pathCalls++; } };
    const queries = ['配方保存 dirty 校验', '报表导出 alignment 对齐参数', '网络连接超时恢复', 'Component 42 未保存弹窗'];
    const run = query => retrieval.search({ projectId: projects[0].projectId, scope: 'domain', query, limit: 8 });
    report.warmup = [];
    for (const query of queries) { const start = performance.now(); const result = await run(query); report.warmup.push({ durationMs: performance.now() - start, results: result.results.length, backend: result.backend }); }
    const diagnostic = process.argv.includes('--diagnose');
    for (let i = 0; i < (diagnostic ? 4 : 20); i++) {
      const start = performance.now(), result = await run(queries[i % queries.length]);
      report.durations.push({ durationMs: performance.now() - start, backend: result.backend, vectorStatus: result.health.index, verifiedVectorChunks: result.health.verifiedVectorChunks, vectorUsed: result.results.some(r => r.match_channels.includes('index:vector-hub')) });
    }
    const values = report.durations.map(r => r.durationMs).sort((a, b) => a - b);
    report.p95Ms = values[Math.ceil(values.length * 0.95) - 1];
    report.profile = { ...profile, note: 'path timing is inclusive in the other stages' };
    report.fixture = root;
    if (typeof report.queryCalls === 'function') report.queryCalls = report.queryCalls();
    // Hybrid ranking may correctly prefer lexical facts over weak vector hits.
    // Require real nonempty indexes, successful verified vector recall on every
    // measured query, and actual vector-selected answers; report lexical-only
    // answers separately instead of pretending they used vectors.
    report.vectorSelectedQueries = report.durations.filter(r => r.vectorUsed).length;
    report.passed = diagnostic ? null : report.p95Ms <= 3000 && (!real || report.vectorSelectedQueries > 0 && report.durations.every(r => r.vectorStatus === 'ok' && r.verifiedVectorChunks > 0));
    save(); console.log(JSON.stringify({ reportFile, passed: report.passed, p95Ms: report.p95Ms, queryCalls: report.queryCalls }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.failure = error.code || error.message; save(); throw error; }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (path.dirname(root) !== owned || !path.basename(root).startsWith('retrieval-performance-')) throw new Error('INVALID_CLEANUP_ROOT');
    if (!process.argv.includes('--keep-fixture')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
