'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runtimeRoots } = require('./retrieval-runtime-roots');

async function main() {
  const roots = runtimeRoots(), { EngineRetrieval } = require(path.join(roots.engine, 'src/retrieval'));
  const { RuntimeLayout } = require(path.join(roots.engine, 'src/runtime/layout'));
  const base = process.env.KB_USER_QUERY_URL || 'http://127.0.0.1:5757';
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'local read-only corpus required');
  const read = async route => { const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30000) }); assert.ok(response.ok); return response.json(); };
  const snapshot = await read('/api/engine/snapshot'), brain = await read('/api/brain');
  const projects = snapshot.projects.filter(p => p.enabled !== false);
  const targets = [['project-knowledge-base', 'modules/vector-index-storage-root.md'], ['vector-hub', 'modules/managed-index-storage.md']];
  const query = '我想知道我当前向量库存储的位置在哪';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-query-readonly-'));
  const report = { schema: 'project-knowledge/user-query-acceptance/v1', runtime: roots.source, version: roots.version || null,
    corpus: 'existing local maintained knowledge; no imports, reindexing, or knowledge writes', query, cases: [],
    runtimeStorage: brain.configuration?.indexStorage || null, runtimeStorageSource: base + '/api/brain', passed: false };
  try {
    // Snapshot registration is read-only. Memory projections are deliberately
    // excluded here: this case measures document discovery, not preference use.
    const store = { state: { sharedScopes: [] }, listProjects: () => projects, getProject: id => projects.find(p => p.projectId === id),
      readRuntime: () => ({ index: {} }), listRuns: id => (snapshot.runs || []).filter(r => !id || r.projectId === id) };
    const retrieval = new EngineRetrieval({ store, layout: new RuntimeLayout(root), projectStore: { readState: () => ({ index: {} }) }, vectorUrl: process.env.KB_USER_QUERY_VECTOR_URL || 'http://127.0.0.1:8787' });
    for (const [name, expectedEntry] of targets) {
      const project = projects.find(p => p.name === name); assert.ok(project, 'registered local corpus: ' + name);
      const file = path.join(project.knowledgePath, expectedEntry);
      const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = digest();
      const result = await retrieval.search({ projectId: project.projectId, query, scope: 'project', limit: 5 });
      const rows = result.results.map(r => ({ entryId: r.entry_id, projectId: r.scope_project_id, commitSha: r.commitSha, channels: r.match_channels, scopeRole: r.scope_reason }));
      report.cases.push({ name, scope: 'project', expectedEntry, rank: rows.findIndex(r => r.entryId === expectedEntry) + 1, backend: result.backend, health: result.health.index, results: rows, unchanged: before === digest() });
      assert.ok(report.cases.at(-1).rank > 0 && report.cases.at(-1).rank <= 5, name + ': storage document must be discoverable in top five');
      assert.ok(rows.every(r => r.projectId === project.projectId)); assert.equal(digest(), before);
    }
    const engine = projects.find(p => p.name === 'knowledge-engine'); assert.ok(engine);
    const domain = await retrieval.search({ projectId: engine.projectId, query, scope: 'domain', limit: 10 });
    const storageEntries = targets.map(([, entry]) => entry);
    report.cases.push({ name: engine.name, scope: 'domain', matchingReferences: domain.results.filter(r => storageEntries.includes(r.entry_id)).map(r => ({ entryId: r.entry_id, projectId: r.scope_project_id, scopeRole: r.scope_reason })) });
    assert.ok(report.cases.at(-1).matchingReferences.length, 'related-domain storage documentation must remain discoverable');
    const storage = report.runtimeStorage;
    assert.equal(storage?.status, 'ready'); assert.equal(path.resolve(storage.actualPath), path.resolve(brain.indexStoragePath));
    assert.equal(path.resolve(storage.expectedPath), path.resolve(brain.knowledgeRoot, '.indexes'));
    report.passed = true;
  } catch (error) { report.error = { code: error.code || error.name, message: error.message }; process.exitCode = 1; }
  finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const directory = path.resolve(__dirname, '../../.agent-state/acceptance/retrieval-quality'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'user-storage-query-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ ...report, report: file }) + '\n');
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
