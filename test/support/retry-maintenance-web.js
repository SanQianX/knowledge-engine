'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');
async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  const userRuntime = process.argv.includes('--user-runtime');
  if (userRuntime) {
    assert.equal(environment.root, path.join(os.homedir(), '.project-knowledge-v5'));
    assert.equal(environment.url, 'http://127.0.0.1:5757');
    const identity = await (await fetch(environment.url + '/api/runtime/identity')).json();
    const installation = JSON.parse(fs.readFileSync(environment.installationReport));
    assert.equal(installation.integrityPassed, true); assert.equal(identity.version, installation.version); assert.equal(identity.dataDir, environment.root);
  } else {
    assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-'));
  }
  assert.equal(environment.installationSource, 'project-knowledge/installed-registry/v1');
  const runId = process.argv[3]; assert.match(runId, /^run-[a-f0-9-]+$/);
  const read = async () => { const response = await fetch(environment.url + '/api/engine/runs'); assert.ok(response.ok); return (await response.json()).runs.find(run => run.runId === runId); };
  const before = await read(); assert.equal(before.state, 'failed');
  const proof = path.join(userRuntime ? path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5') : environment.root, `retry-maintenance-${Date.now()}`); fs.mkdirSync(proof, { recursive: true });
  const report = { passed: false, installationReport: environment.installationReport, before };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report); save();
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: environment.url, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    await waitFor(() => browser.evaluate(`!![...document.getElementById('projectSelect').options].find(o=>o.value===${JSON.stringify(before.projectId)})`), 'actual project');
    await browser.evaluate(`(()=>{const field=document.getElementById('projectSelect');field.value=${JSON.stringify(before.projectId)};field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=activity]').click()})()`);
    await waitFor(() => browser.evaluate(`!!document.querySelector('[data-retry-run="${runId}"]')`), 'original failed maintenance');
    await browser.evaluate(`document.querySelector('[data-run-id="${runId}"]').open=true`);
    await browser.screenshot(path.join(proof, 'original-failure-1920.png'));
    await browser.evaluate(`document.querySelector('[data-retry-run="${runId}"]').click()`);
    await waitFor(async () => (await read()).state !== 'failed', 'UI retry reaches backend');
    await waitFor(async () => {
      const run = await read();
      if (['failed', 'index-pending'].includes(run.state)) throw Object.assign(new Error(`${run.error.code}: ${run.error.message}`), { fatal: true });
      return run.state === 'succeeded';
    }, 'same commit recovers with downloaded runtime', 300000);
    const after = await read(); assert.equal(after.commitSha, before.commitSha); assert.equal(after.analysisRunId, before.analysisRunId);
    assert.equal(after.indexState, 'succeeded'); assert.ok(after.promotedAt);
    const response = await fetch(environment.url + '/api/engine/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: after.projectId, query: after.commitSha, scope: 'project', limit: 5 }) });
    assert.ok(response.ok); const search = await response.json();
    assert.ok(search.results.some(row => row.commitSha === after.commitSha), 'recovered commit knowledge must really be discoverable');
    await waitFor(() => browser.evaluate(`document.querySelector('[data-run-id="${runId}"]').textContent.includes('索引：succeeded')`), 'frontend refresh from backend');
    await browser.screenshot(path.join(proof, 'recovered-1920.png')); assert.equal(browser.exceptions.length, 0);
    Object.assign(report, { passed: true, after, userRuntime, search: { backend: search.backend, matchStatus: search.matchStatus, references: search.results.map(row => ({ entryId: row.entry_id, projectId: row.scope_project_id, commitSha: row.commitSha, channels: row.match_channels })) }, checkedAt: new Date().toISOString() }); save();
    console.log(`NPM_SAME_COMMIT_UI_RECOVERY_PASSED ${path.join(proof, 'result.json')}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`MAINTENANCE_RECOVERY_FAILED: ${error.message}`); process.exitCode = 1; });
