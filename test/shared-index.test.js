'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EngineStore } = require('../src/store');
const { EngineCoordinator } = require('../src/coordinator');

test('shared index survives configuration replacement, reports failures and recovers a missing derived index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-scope-index-'));
  let releaseImport, imports = 0, available = false, fail = false;
  const scope = { id: 'brain-default', kind: 'brain', brainId: 'brain-default', knowledgePath: path.join(root, 'shared') };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects') { res.end(JSON.stringify({ projects: available ? [{ name: 'scope-brain-brain-default', sourceDir: scope.knowledgePath, hasIndex: true }] : [] })); return; }
    imports++;
    if (imports === 1) await new Promise(resolve => { releaseImport = resolve; });
    if (fail) { res.statusCode = 503; res.end(JSON.stringify({ ok: false })); return; }
    available = true; res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new EngineStore(path.join(root, 'engine'));
  const coordinator = new EngineCoordinator(store, { managed: true, vectorUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    await coordinator.ready;
    await coordinator.memories.configure([scope]);
    const deadline = Date.now() + 3000;
    while (!releaseImport && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseImport);
    const original = store.state.sharedScopes[0];
    await coordinator.memories.configure([{ ...scope, name: 'Renamed brain' }]);
    assert.notEqual(store.state.sharedScopes[0], original);
    releaseImport(); await coordinator.sharedIndexJobs.get(scope.id);
    assert.equal(store.state.sharedScopes[0].index.status, 'ready');
    assert.equal(store.state.sharedScopes[0].name, 'Renamed brain');
    await coordinator.indexSharedScope(store.state.sharedScopes[0]);
    assert.equal(imports, 1, 'healthy unchanged content does not request new embeddings');
    available = false; fail = true;
    await coordinator.indexSharedScope(store.state.sharedScopes[0]);
    assert.equal(store.state.sharedScopes[0].index.status, 'pending');
    assert.equal(store.state.sharedScopes[0].index.error.details.httpStatus, 503);
    const logDir = path.join(root, 'engine/logs/system');
    const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').trim().split('\n').map(JSON.parse).find(record => record.event === 'knowledge.shared_index.failed');
    assert.equal(log.context.scopeId, scope.id); assert.equal(log.context.httpStatus, 503);
    assert.ok(fs.existsSync(path.join(scope.knowledgePath, 'memories/confirmed.md')), 'index failure never removes source knowledge');
    fail = false;
    await coordinator.indexSharedScope(store.state.sharedScopes[0]);
    assert.equal(store.state.sharedScopes[0].index.status, 'ready');
    assert.equal(imports, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'engine/engine-state.json'))).sharedScopes[0].index.status, 'ready');
  } finally { releaseImport?.(); await coordinator.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }
});
