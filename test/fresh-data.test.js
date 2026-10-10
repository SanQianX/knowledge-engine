'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EngineStore } = require('../src/store');
const { createEngineServer } = require('../src/server');

test('old engine state is rejected unchanged, never migrated or scheduled', () => {
  for (const schemaVersion of [undefined, 1, 2]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-reject-old-'));
    const bytes = JSON.stringify({ schemaVersion, projects: [], runs: [{ trigger: 'upgrade-recovery', state: 'queued' }] });
    fs.writeFileSync(path.join(root, 'engine-state.json'), bytes);
    assert.throws(() => new EngineStore(root), { code: 'SCHEMA_UNSUPPORTED' });
    assert.equal(fs.readFileSync(path.join(root, 'engine-state.json'), 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['engine-state.json']);
  }
});

test('fresh startup has no upgrade recovery, queued unbind cancels without model calls and persists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fresh-unbind-'));
  let analyses = 0;
  const engine = createEngineServer({ dataDir: path.join(root, 'engine'), managed: true, runtimeToken: 'fresh-test-token', analyzer: { async runClaim() { analyses++; } }, bridge: { async registerConsumer() {}, async listJournals() { return []; } } });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  t.after(() => engine.close());
  const base = `http://127.0.0.1:${engine.server.address().port}`;
  assert.equal(engine.store.state.runs.length, 0);
  assert.equal((await fetch(base + '/api/runtime-auth')).status, 403);
  assert.equal((await fetch(base + '/api/runtime-auth', { headers: { Authorization: 'Bearer fresh-test-token', Origin: base } })).status, 403);
  assert.equal((await fetch(base + '/api/runtime-auth', { headers: { Authorization: 'Bearer fresh-test-token' } })).status, 200);
  assert.equal((await fetch(base + '/api/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fresh-test-token' }, body: '{}' })).status, 404);
  const project = { projectId: 'project-remove', repoPath: path.join(root, 'code'), knowledgePath: path.join(root, 'knowledge') };
  fs.mkdirSync(project.repoPath); fs.mkdirSync(project.knowledgePath);
  fs.writeFileSync(path.join(project.repoPath, 'source.txt'), 'keep code');
  fs.writeFileSync(path.join(project.knowledgePath, 'README.md'), 'keep knowledge');
  engine.store.addProject(project);
  const run = engine.coordinator.enqueue({ projectId: project.projectId, commitSha: 'a'.repeat(40), trigger: 'git-hook' });
  const response = await fetch(base + '/api/projects/project-remove', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cancelledRuns, 1);
  assert.equal(run.state, 'cancelled');
  assert.equal(engine.store.listProjects().length, 0);
  assert.equal(new EngineStore(path.join(root, 'engine')).getRun(run.runId).state, 'cancelled');
  await engine.coordinator.activate();
  assert.equal(analyses, 0);
  assert.equal(fs.readFileSync(path.join(project.repoPath, 'source.txt'), 'utf8'), 'keep code');
  assert.equal(fs.readFileSync(path.join(project.knowledgePath, 'README.md'), 'utf8'), 'keep knowledge');
});

test('actual writer lease blocks unbind even when a run is index-pending', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-active-unbind-'));
  const engine = createEngineServer({ dataDir: root, managed: true }); await engine.ready;
  t.after(() => engine.close());
  engine.store.addProject({ projectId: 'project-active', repoPath: path.join(root, 'code'), knowledgePath: path.join(root, 'knowledge') });
  const run = engine.store.addRun({ projectId: 'project-active', commitSha: 'b'.repeat(40) });
  engine.store.updateRun(run.runId, { state: 'index-pending' });
  engine.coordinator.active.set('project-active', run.runId);
  await assert.rejects(engine.coordinator.removeProject('project-active'), { code: 'PROJECT_BUSY' });
  assert.ok(engine.store.getProject('project-active'));
  engine.coordinator.active.clear();
  assert.equal((await engine.coordinator.removeProject('project-active')).removed, true);
});
