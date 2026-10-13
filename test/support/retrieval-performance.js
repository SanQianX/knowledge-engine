'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const AtomicFile = require('../../src/runtime/atomic-file');
const { RuntimeLayout } = require('../../src/runtime/layout');
const { EngineRetrieval } = require('../../src/retrieval');

async function main() {
  const real = process.argv.includes('--real');
  const owned = path.resolve(__dirname, '../../.agent-state/temporary'); fs.mkdirSync(owned, { recursive: true });
  const root = fs.mkdtempSync(path.join(owned, 'retrieval-performance-'));
  const reportFile = path.resolve(__dirname, `../../.agent-state/acceptance/retrieval-quality/performance-${Date.now()}.json`);
  const report = { schema: 'retrieval-performance/v1', passed: false, mode: real ? '1000 synthetic documents, real MiniMax embeddings and disk vector indexes' : '1000 synthetic documents, canonical text only; not vector performance', node: process.version, projects: 8, documents: 1000, durations: [] };
  const save = () => AtomicFile.writeJsonAtomic(reportFile, report);
  let server;
  try {
    const projects = Array.from({ length: 8 }, (_, i) => ({ projectId: `project-bench-${i}`, name: `性能项目 ${i}`, brainId: 'brain-default', domainId: 'bench', enabled: true, knowledgePath: path.join(root, `project-${i}`) }));
    for (const project of projects) for (let i = 0; i < 125; i++) {
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
      let queryCalls = 0;
      const base = createMiniMaxEmbeddings(settings.apiKey, { model: settings.model, ...(settings.endpoint ? { endpoint: settings.endpoint } : {}) });
      const embeddings = { maxTokens: base.maxTokens, createEmbeddings(input) { if (typeof input === 'string') queryCalls++; return base.createEmbeddings(input); } };
      const hub = new VectorHub({ rootPath: path.join(root, '.indexes'), embeddings });
      for (const project of projects) { await hub.syncFolder(project.projectId, project.knowledgePath); process.stdout.write(`Indexed ${project.projectId}\n`); }
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
    const queries = ['配方保存 dirty 校验', '报表导出 alignment 对齐参数', '网络连接超时恢复', 'Component 42 未保存弹窗'];
    const run = query => retrieval.search({ projectId: projects[0].projectId, scope: 'domain', query, limit: 8 });
    report.warmup = [];
    for (const query of queries) { const start = performance.now(); const result = await run(query); report.warmup.push({ durationMs: performance.now() - start, results: result.results.length, backend: result.backend }); }
    for (let i = 0; i < 20; i++) {
      const start = performance.now(), result = await run(queries[i % queries.length]);
      report.durations.push({ durationMs: performance.now() - start, backend: result.backend, vectorUsed: result.results.some(r => r.match_channels.includes('index:vector-hub')) });
    }
    const values = report.durations.map(r => r.durationMs).sort((a, b) => a - b);
    report.p95Ms = values[Math.ceil(values.length * 0.95) - 1];
    if (typeof report.queryCalls === 'function') report.queryCalls = report.queryCalls();
    report.passed = report.p95Ms <= 3000 && (!real || report.durations.every(r => r.vectorUsed));
    save(); console.log(JSON.stringify({ reportFile, passed: report.passed, p95Ms: report.p95Ms, queryCalls: report.queryCalls }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.failure = error.code || error.message; save(); throw error; }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (path.dirname(root) !== owned || !path.basename(root).startsWith('retrieval-performance-')) throw new Error('INVALID_CLEANUP_ROOT');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
