'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  const read = async route => { const response = await fetch(new URL(route, environment.url)); assert.ok(response.ok, route); return response.json(); };
  const settings = await read('/api/vectorhub/settings');
  assert.equal(settings.settings.apiKey, '', 'public configuration must not expose credentials');
  assert.equal(settings.settings.provider, 'minimax');
  assert.equal(settings.settings.model, 'embo-01');
  const dimensions = {};
  for (const id of ['project-real-a', 'project-real-b']) {
    const index = JSON.parse(fs.readFileSync(path.join(environment.root, 'indexes', id, 'index.json'), 'utf8'));
    assert.ok(index.items.length, 'real promoted knowledge must have indexed chunks');
    assert.ok(index.items.every(item => item.vector.length === 1536 && item.vector.every(Number.isFinite)), 'real embo-01 vectors must replace the controlled 2D index');
    dimensions[id] = { chunks: index.items.length, dimension: 1536 };
  }
  const query = new URLSearchParams({ q: '知识文件单写者维护与提交依据', projects: 'project-real-a,project-real-b', isBm25: 'false' });
  const search = await read(`/api/vectorhub/search?${query}`);
  assert.equal(search.errors.length, 0);
  assert.equal(search.projectsSkipped.length, 0);
  assert.ok(search.results.length && search.results.every(row => Number.isFinite(row.score)));
  assert.ok(search.results.every(row => ['project-real-a', 'project-real-b'].includes(row.project)));
  const response = await fetch(new URL('/api/engine/search', environment.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-real-a', scope: 'brain', query: '知识写入', limit: 10 }) });
  assert.ok(response.ok);
  const result = await response.json();
  assert.equal(result.health.index, 'ok', 'unified retrieval must actually use the real vector provider, not silently degrade');
  assert.ok(result.results.length && result.results.some(row => row.commitSha), 'engine must retain promoted commit attribution');
  AtomicFile.writeJsonAtomic(path.join(environment.root, 'real-embedding-acceptance.json'), { passed: true, verifiedAt: new Date().toISOString(), mode: environment.model, installationSource: environment.installationSource, dimensions, semanticResults: search.results.length, engineResults: result.results.length, citedCommits: [...new Set(result.results.map(row => row.commitSha).filter(Boolean))], secretsExposed: false });
  process.stdout.write('REAL_EMBEDDING_ACCEPTANCE_PASSED dimension=1536\n');
}
main().catch(error => { process.stderr.write(`${error.code || 'ACCEPTANCE_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
