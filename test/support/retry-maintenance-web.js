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
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-'));
  assert.equal(environment.installationSource, 'project-knowledge/installed-registry/v1');
  const runId = process.argv[3]; assert.match(runId, /^run-[a-f0-9-]+$/);
  const read = async () => { const response = await fetch(environment.url + '/api/engine/runs'); assert.ok(response.ok); return (await response.json()).runs.find(run => run.runId === runId); };
  const before = await read(); assert.equal(before.state, 'failed');
  const proof = path.join(environment.root, `retry-maintenance-${Date.now()}`); fs.mkdirSync(proof);
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
    await waitFor(() => browser.evaluate(`document.querySelector('[data-run-id="${runId}"]').textContent.includes('索引：succeeded')`), 'frontend refresh from backend');
    await browser.screenshot(path.join(proof, 'recovered-1920.png')); assert.equal(browser.exceptions.length, 0);
    Object.assign(report, { passed: true, after, checkedAt: new Date().toISOString() }); save();
    console.log(`NPM_SAME_COMMIT_UI_RECOVERY_PASSED ${path.join(proof, 'result.json')}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`MAINTENANCE_RECOVERY_FAILED: ${error.message}`); process.exitCode = 1; });
