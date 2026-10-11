'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  const priorFile = path.resolve(process.argv[3]);
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  assert.equal(path.dirname(priorFile), environment.root);
  assert.match(path.basename(priorFile), /^real-secondary-development-\d+\.json$/);
  const prior = JSON.parse(fs.readFileSync(priorFile));
  const development = prior.stages.find(stage => stage.stage === 'Agent retrieval before edits and actual test' && stage.passed);
  assert.ok(development && /^[a-f0-9]{40}$/.test(prior.commitSha));
  const proofFile = path.join(environment.root, `real-secondary-recovery-${Date.now()}.json`);
  const proof = { priorFile, sourceCommit: prior.sourceCommit, commitSha: prior.commitSha, projectId: prior.projectId, sessionId: prior.sessionId, installationReport: environment.installationReport, passed: false };
  const save = () => AtomicFile.writeJsonAtomic(proofFile, proof);
  const read = async route => { const response = await fetch(new URL(route, environment.url), { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, `${route}: HTTP ${response.status}`); return response.json(); };
  try {
    const snapshot = await read(`/api/terminal/sessions/${prior.sessionId}`);
    assert.equal(snapshot.session.state, 'idle');
    const prompt = snapshot.events.find(event => event.type === 'claude/user-prompt')?.text;
    assert.ok(prompt?.includes(prior.sourceCommit) && prompt.includes('project-knowledge-kb.js'));
    assert.ok(snapshot.events.some(event => event.type === 'claude/result' && !event.isError && event.result.includes('SECONDARY_POLICY_OK')));
    for (const file of development.files) {
      assert.equal(path.basename(file.path), file.path);
      const bytes = fs.readFileSync(path.join(environment.repositories[0], file.path));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const testFile = development.files.find(file => file.path.endsWith('.test.js'));
    assert.ok(execFileSync(process.execPath, [testFile.path], { cwd: environment.repositories[0], encoding: 'utf8', windowsHide: true }).includes('SECONDARY_POLICY_OK'));
    const deadline = Date.now() + 240000;
    let run;
    while (Date.now() < deadline) {
      run = (await read('/api/engine/runs')).runs.find(item => item.projectId === prior.projectId && item.commitSha === prior.commitSha);
      assert.ok(!['failed', 'index-pending'].includes(run?.state), run?.error?.code);
      if (run?.state === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    assert.equal(run?.state, 'succeeded');
    assert.ok(run.promotedAt && run.indexState === 'succeeded');
    const conversation = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', prior.projectId, 'commit-conversations', `${prior.commitSha}.json`)));
    const turn = conversation.turns.find(item => item.sessionId === prior.sessionId && item.userEvents.some(event => event.content === prompt));
    assert.ok(turn?.assistantEvents.some(event => event.content.includes('SECONDARY_POLICY_OK')));
    const response = await fetch(new URL('/api/engine/search', environment.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: prior.projectId, query: prior.commitSha }), signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok);
    const result = await response.json();
    assert.equal(result.health.index, 'ok');
    assert.ok(result.results.some(item => item.commitSha === prior.commitSha));
    Object.assign(proof, { passed: true, runId: run.runId, promotedAt: run.promotedAt, frozenSnapshotHash: conversation.snapshotHash, unchangedCode: development.files, citations: result.results.map(item => ({ entry: item.entry_id, commit: item.commitSha })), recoveredAt: new Date().toISOString() }); save();
    console.log(`REAL_SECONDARY_RECOVERY_PASSED ${proofFile}`);
  } catch (error) { proof.failure = error.message; save(); throw error; }
}
main().catch(error => { console.error(`${error.code || 'SECONDARY_RECOVERY_FAILED'}: ${error.message}`); process.exitCode = 1; });
