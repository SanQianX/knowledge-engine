'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  const priorFile = path.resolve(process.argv[3]);
  assert.equal(path.dirname(priorFile), environment.root);
  assert.match(path.basename(environment.root), /^智脑桌面验收-/);
  const prior = JSON.parse(fs.readFileSync(priorFile));
  assert.match(prior.commitSha, /^[a-f0-9]{40}$/);
  const development = prior.stages.find(stage => stage.stage === 'Agent retrieval before edits and actual test' && stage.passed);
  assert.ok(development);
  const proof = { priorFile, commitSha: prior.commitSha, projectId: prior.projectId, scope: 'background maintenance only; not a history-restoration pass', installationReport: environment.installationReport, passed: false };
  const proofFile = path.join(environment.root, `interrupted-maintenance-${Date.now()}.json`);
  try {
    const response = await fetch(new URL('/api/engine/runs', environment.url));
    assert.equal(response.status, 200);
    const run = (await response.json()).runs.find(item => item.commitSha === prior.commitSha && item.projectId === prior.projectId);
    assert.equal(run?.state, 'succeeded'); assert.equal(run.indexState, 'succeeded'); assert.ok(run.promotedAt);
    for (const file of development.files) {
      assert.equal(path.basename(file.path), file.path);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(environment.repositories[0], file.path))).digest('hex'), file.sha256);
    }
    const frozen = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', prior.projectId, 'commit-conversations', `${prior.commitSha}.json`)));
    const turn = frozen.turns.find(item => item.sessionId === prior.sessionId);
    assert.ok(turn?.userEvents.some(event => event.content.includes(prior.sourceCommit) && event.content.includes('project-knowledge-kb.js')));
    assert.ok(turn.assistantEvents.some(event => event.content.includes('SECONDARY_POLICY_OK')));
    const result = await (await fetch(new URL('/api/engine/search', environment.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: prior.projectId, query: prior.commitSha }) })).json();
    assert.equal(result.health.index, 'ok'); assert.ok(result.results.some(item => item.commitSha === prior.commitSha));
    Object.assign(proof, { passed: true, runId: run.runId, promotedAt: run.promotedAt, frozenSnapshotHash: frozen.snapshotHash, citations: result.results.map(item => ({ entry: item.entry_id, commit: item.commitSha })), at: new Date().toISOString() });
    console.log(`INTERRUPTED_MAINTENANCE_PASSED ${proofFile}`);
  } finally { AtomicFile.writeJsonAtomic(proofFile, proof); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
