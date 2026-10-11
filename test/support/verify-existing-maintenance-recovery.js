'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const address = new URL(process.argv[2]); assert.equal(address.hostname, '127.0.0.1');
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  const runId = flag('--run-id') || 'run-431c10a3-e32d-4d4e-a84a-f2d0c6afe81a';
  const commitSha = flag('--expected-commit') || '530919e81845b803ef6d61821dd276610279d526';
  assert.match(runId, /^run-[a-f0-9-]+$/); assert.match(commitSha, /^[a-f0-9]{40}$/);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json')));
  const before = persisted.runs.find(run => run.runId === runId);
  assert.equal(before?.commitSha, commitSha); assert.ok(['failed', 'queued', 'running', 'succeeded'].includes(before.state));
  const project = persisted.projects.find(item => item.projectId === before.projectId);
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `maintenance-recovery-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const report = { passed: false, originalFailure: before.error || null, before, commitSha, runId, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  const read = async route => { const response = await fetch(new URL(route, address), { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const identity = await read('/api/runtime/identity');
  assert.equal(identity.dataDir, dataDir); assert.match(identity.version, /^5\.0\.9(?:-rc\.\d+)?$/);
  report.identity = identity; save();
  await waitFor(async () => { const c = (await read('/api/brain')).configuration; return c?.model && c.embedding && c.scopes; }, 'actual supervised configuration', 180000);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: address.href, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const evaluate = expression => browser.evaluate(expression);
    await waitFor(() => evaluate(`!![...document.getElementById('projectSelect').options].find(o=>o.value===${JSON.stringify(project.projectId)})`), 'retained actual project');
    await evaluate(`(()=>{const select=document.getElementById('projectSelect');select.value=${JSON.stringify(project.projectId)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=activity]').click()})()`);
    await waitFor(() => evaluate(`!!document.querySelector('[data-run-id="${runId}"]')`), 'original failed run visible');
    await evaluate(`document.querySelector('[data-run-id="${runId}"]').open=true`);
    await browser.screenshot(path.join(proof, 'before-1920.png'));
    const current = (await read('/api/engine/runs')).runs.find(run => run.runId === runId);
    if (current.state === 'failed') {
      assert.ok(['PROJECT_BUSY', 'WORKER_STOPPED'].includes(current.error?.code), 'retry only the reproduced defect or explicitly interrupted shutdown task');
      report.retryEntry = 'actual UI retry of the original failed run'; save();
      await evaluate(`document.querySelector('[data-retry-run="${runId}"]').click()`);
    } else report.retryEntry = 'original run already recovered or retrying; do not create another run';
    await waitFor(async () => {
      const run = (await read('/api/engine/runs')).runs.find(item => item.runId === runId);
      if (['failed', 'index-pending'].includes(run?.state)) {
        report.after = run; save(); throw Object.assign(new Error(`Actual maintenance recovery failed: ${run.error?.code}`), { fatal: true });
      }
      return run?.state === 'succeeded';
    }, 'original commit real analysis and index recovery', 15 * 60 * 1000);
    const after = (await read('/api/engine/runs')).runs.find(run => run.runId === runId);
    assert.ok(after.promotedAt && after.indexState === 'succeeded');
    const shaRuns = (await read('/api/engine/runs')).runs.filter(run => run.projectId === project.projectId && run.commitSha === commitSha);
    assert.equal(shaRuns.length, 1, 'retry reuses the original commit claim');
    const response = await fetch(new URL('/api/engine/search', address), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.projectId, query: commitSha, scope: 'project' }), signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok); const result = await response.json();
    assert.equal(result.health.index, 'ok'); assert.ok(result.results.some(item => item.commitSha === commitSha));
    const hashes = Object.fromEntries(after.staging.operations.filter(op => op.operation !== 'delete').map(op => [op.path, crypto.createHash('sha256').update(fs.readFileSync(path.join(project.knowledgePath, op.path))).digest('hex')]));
    const logs = await read('/api/logs?' + new URLSearchParams({ projectId: project.projectId, operationId: runId }));
    assert.ok(logs.entries.some(entry => entry.event === 'knowledge.index.completed' && entry.commitSha === commitSha));
    await waitFor(() => evaluate(`document.querySelector('[data-run-id="${runId}"]').textContent.includes('索引：succeeded')`), 'actual UI live recovery');
    await browser.screenshot(path.join(proof, 'recovered-1920.png')); assert.equal(browser.exceptions.length, 0);
    Object.assign(report, { passed: true, after, knowledgeHashes: hashes, citations: result.results.map(item => ({ entryId: item.entry_id, commitSha: item.commitSha })), finishedAt: new Date().toISOString() }); save();
    console.log(`EXISTING_MAINTENANCE_RECOVERY_PASSED ${proof}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`${error.code || 'MAINTENANCE_RECOVERY_FAILED'}: ${error.message}`); process.exitCode = 1; });
