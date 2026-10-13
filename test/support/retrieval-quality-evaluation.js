'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { EngineRetrieval } = require('../../src/retrieval');
const { RuntimeLayout } = require('../../src/runtime/layout');
const AtomicFile = require('../../src/runtime/atomic-file');
const corpus = require('../fixtures/retrieval-quality-corpus');

function metrics(rows) {
  const positive = rows.filter(r => r.expected.length), negative = rows.filter(r => !r.expected.length);
  return { queries: rows.length, positive: positive.length, negative: negative.length, recallAt5: positive.filter(r => r.rank > 0).length / Math.max(1, positive.length),
    mrrAt5: positive.reduce((sum, r) => sum + (r.rank > 0 ? 1 / r.rank : 0), 0) / Math.max(1, positive.length), noAnswerAccuracy: negative.filter(r => !r.results.length).length / Math.max(1, negative.length) };
}

async function evaluate({ real = false, compare = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-evaluation-'));
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/retrieval-quality'); fs.mkdirSync(proof, { recursive: true });
  const reportPath = path.join(proof, `${real ? 'real-vector' : 'lexical'}-${Date.now()}.json`);
  const report = { schema: 'retrieval-quality/evaluation/v1', passed: false, mode: real ? 'synthetic labelled corpus + real embeddings' : 'deterministic current-file lexical retrieval', baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim(), firstFailures: [], rows: [], startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(reportPath, report);
  let server, hub;
  const scoreTraces = new Map();
  try {
    const projects = ['project-recipe', 'project-review', 'project-other'].map((projectId, i) => ({ projectId, name: ['MaskRecipeEditor401', 'MaskScanReview', 'Finance'][i], brainId: 'brain-default', domainId: i === 2 ? 'finance' : 'mask', knowledgePath: path.join(root, projectId), enabled: true }));
    for (const project of projects) fs.mkdirSync(project.knowledgePath, { recursive: true });
    for (const doc of corpus.documents) AtomicFile.writeFileAtomic(path.join(projects.find(p => p.projectId === doc.projectId).knowledgePath, doc.entry), doc.text);
    const runs = corpus.documents.map((d, i) => ({ projectId: d.projectId, commitSha: crypto.createHash('sha1').update(d.entry).digest('hex'), promotedAt: d.entry.includes('ef123') ? '2026-10-13T08:17:00Z' : '2026-10-10T09:35:00Z', staging: { operations: [{ path: d.entry }] } }));
    const store = { state: { sharedScopes: [] }, getProject: id => projects.find(p => p.projectId === id), listProjects: () => projects, readRuntime: () => ({ index: {} }), listRuns: id => runs.filter(r => !id || r.projectId === id) };
    let vectorUrl = 'http://127.0.0.1:1';
    if (real) {
      const { ProfileStore } = require('../../../claude-ai-workbench/packages/server/lib/profile-store');
      const settings = new ProfileStore({ dataDir: path.join(os.homedir(), '.project-knowledge-v5/workbench') }).embeddingRuntime();
      if (!settings?.apiKey) throw new Error('REAL_EMBEDDING_CONFIGURATION_REQUIRED');
      const { VectorHub } = require('../../../vector-hub/dist/cjs/core/hub');
      const { createMiniMaxEmbeddings, createOpenAIEmbeddings } = require('../../../vector-hub/dist/cjs/core/embeddings');
      const embeddings = settings.provider === 'minimax' ? createMiniMaxEmbeddings(settings.apiKey, { ...(settings.model ? { model: settings.model } : {}), ...(settings.endpoint ? { endpoint: settings.endpoint } : {}) }) : createOpenAIEmbeddings(settings);
      hub = new VectorHub({ rootPath: path.join(root, '.indexes'), embeddings });
      for (const project of projects) await hub.syncFolder(project.projectId, project.knowledgePath);
      server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const data = await hub.search(url.searchParams.get('q'), { projects: url.searchParams.get('projects').split(','), resultLevel: url.searchParams.get('resultLevel') === 'chunk' ? 'chunk' : 'document', perProjectLimit: 30, maxResults: 50 });
          if (data.resultLevel === 'chunk') scoreTraces.set(url.searchParams.get('q'), { model: data.model, dimensions: data.dimensions,
            rows: data.results.map(r => ({ projectId: r.project, entry: path.relative(projects.find(p => p.projectId === r.project).knowledgePath, r.uri).replace(/\\/g, '/'), score: r.score })) });
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
        } catch { res.writeHead(503); res.end('{"error":"VECTOR_QUERY_FAILED"}'); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); vectorUrl = `http://127.0.0.1:${server.address().port}`;
      report.embedding = { provider: settings.provider, model: settings.model, dimensions: 1536 }; save();
    }
    const options = { store, layout: new RuntimeLayout(root), projectStore: { readState: () => ({ index: {} }) }, vectorUrl };
    const current = new EngineRetrieval(options);
    const variants = [['current', current]];
    if (compare) {
      const source = execFileSync('git', ['show', 'HEAD:src/retrieval.js'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', maxBuffer: 1024 * 1024 });
      const baseline = new Module(path.resolve(__dirname, '../../src/baseline-retrieval.js'), module);
      baseline.filename = path.resolve(__dirname, '../../src/baseline-retrieval.js'); baseline.paths = Module._nodeModulePaths(path.dirname(baseline.filename)); baseline._compile(source, baseline.filename);
      variants.unshift(['baseline', new baseline.exports.EngineRetrieval(options)]);
    }
    for (const [variant, retrieval] of variants) for (const c of corpus.cases) {
      const started = Date.now(), found = await retrieval.search({ projectId: c.projectId, scope: c.scope, query: c.query, limit: 10 });
      const documents = []; const seen = new Set();
      for (const row of found.results) { const key = `${row.scope_project_id}:${row.entry_id}`; if (!seen.has(key)) { seen.add(key); documents.push({ projectId: row.scope_project_id, entry: row.entry_id }); } }
      const rank = documents.slice(0, 5).findIndex(r => c.expected.some(e => e.projectId === r.projectId && e.entry === r.entry)) + 1;
      const row = { id: c.id, family: c.family, split: c.split, variant, expected: c.expected, results: documents, rank, durationMs: Date.now() - started, vectorMatched: found.results.some(r => r.match_channels?.includes('index:vector-hub')), status: found.matchStatus || null };
      report.rows.push(row); if (variant === 'current' && (c.expected.length ? !rank : documents.length)) report.firstFailures.push(c.id);
      save();
    }
    if (real) {
      const training = corpus.cases.filter(c => c.split === 'train' && scoreTraces.has(c.query)).map(c => {
        const trace = scoreTraces.get(c.query);
        return { id: c.id, positive: c.expected.length > 0, topScore: Math.max(-1, ...trace.rows.map(r => r.score)),
          expectedScore: Math.max(-1, ...trace.rows.filter(r => c.expected.some(e => e.projectId === r.projectId && e.entry === r.entry)).map(r => r.score)) };
      });
      const negatives = training.filter(c => !c.positive), positives = training.filter(c => c.positive);
      const thresholds = [];
      for (let i = 0; i <= 100; i++) {
        const minScore = i / 100;
        const falsePositiveRate = negatives.filter(c => c.topScore >= minScore).length / Math.max(1, negatives.length);
        const recall = positives.filter(c => c.expectedScore >= minScore).length / Math.max(1, positives.length);
        if (falsePositiveRate <= 0.05) thresholds.push({ minScore, recall, falsePositiveRate });
      }
      thresholds.sort((a, b) => b.recall - a.recall || b.minScore - a.minScore);
      const sample = [...scoreTraces.values()][0];
      report.calibration = { trainedOn: 'train families only', model: sample?.model || null, dimensions: sample?.dimensions, selected: thresholds[0] || null, training };
      save();
    }
    report.metrics = Object.fromEntries(variants.map(([variant]) => [variant, Object.fromEntries(['train', 'test'].map(split => [split, metrics(report.rows.filter(r => r.variant === variant && r.split === split))]))]));
    const heldout = report.metrics.current.test;
    report.passed = heldout.recallAt5 >= 0.9 && heldout.mrrAt5 >= 0.85 && heldout.noAnswerAccuracy === 1;
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ reportPath, passed: report.passed, metrics: report.metrics, failures: report.firstFailures, realVectorHits: report.rows.filter(r => r.variant === 'current' && r.vectorMatched).length }));
    return report;
  } catch (error) { report.failure = error.code || error.name; save(); throw error; }
  finally { if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
if (require.main === module) evaluate({ real: process.argv.includes('--real'), compare: !process.argv.includes('--no-baseline') }).then(r => { if (!r.passed) process.exitCode = 1; }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { evaluate, metrics };
