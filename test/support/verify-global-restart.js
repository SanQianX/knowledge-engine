'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { publicFiles } = require('./verify-global-registry');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');
const fingerprint = root => Object.fromEntries(publicFiles(root).filter(file => !['config.json', 'settings.json'].includes(file)).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

async function main() {
  const task = JSON.parse(fs.readFileSync(process.argv[2])); assert.equal(task.passed, true);
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const core = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@sanqianx/project-knowledge');
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `restart-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const before = await read('/api/runtime/identity'); assert.equal(before.dataDir, dataDir); assert.equal(before.version, '5.0.9-rc.19');
  const runsBefore = (await read('/api/engine/runs')).runs;
  assert.ok(runsBefore.every(run => run.state === 'succeeded'), 'do not interrupt queued or active user maintenance');
  const projectIds = (await read('/api/projects/aggregated')).projects.map(project => project.projectId).sort();
  const indexRoot = (await read('/api/brain')).configuration.indexStorage.actualPath;
  assert.equal(indexRoot, 'D:\\SanQian.Xu\\knowledge\\.indexes');
  const indexes = fingerprint(indexRoot), snapshot = await read(`/api/terminal/sessions/${task.sessionId}`);
  assert.equal(snapshot.session.state, 'idle');
  const run = (script, args) => { const result = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, KB_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true, timeout: 55000 }); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim(); };
  const ownership = path.join(proof, 'owned-processes.json');
  run(path.join(__dirname, 'owned-process-audit.js'), ['record', ownership, String(before.pid)]);
  const stopped = run(path.join(core, 'bin/project-knowledge.js'), ['STOP']);
  run(path.join(__dirname, 'owned-process-audit.js'), ['verify', ownership, 'graceful']);
  const started = run(path.join(core, 'bin/project-knowledge.js'), []);
  await waitFor(async () => { const modules = await read('/api/modules/health'); const brain = await read('/api/brain'); return Object.values(modules.modules).every(module => module.up) && modules.ownership.ready && brain.configuration.indexStorage.status === 'ready'; }, 'actual supervised restart readiness', 180000);
  const after = await read('/api/runtime/identity'); assert.equal(after.version, before.version); assert.notEqual(after.pid, before.pid);
  assert.deepEqual((await read('/api/projects/aggregated')).projects.map(project => project.projectId).sort(), projectIds);
  const runsAfter = (await read('/api/engine/runs')).runs;
  assert.equal(runsAfter.length, runsBefore.length, 'restart must not requeue completed commits');
  for (const old of runsBefore) {
    const current = runsAfter.find(run => run.runId === old.runId);
    for (const key of ['state', 'indexState', 'analysisRunId', 'promotedAt', 'indexAttempts']) assert.equal(current?.[key], old[key]);
  }
  assert.deepEqual(fingerprint(indexRoot), indexes, 'ordinary restart must not rewrite paid vectors');
  const rebuild = await read('/api/vectorhub/rebuild/status'); assert.equal(rebuild.running, false); assert.equal(rebuild.total, 0); assert.deepEqual(rebuild.errors, []);
  const restored = await read(`/api/terminal/sessions/${task.sessionId}`); assert.equal(restored.session.state, 'idle'); assert.deepEqual(restored.events, snapshot.events);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: 'http://127.0.0.1:5757', width: 1920, height: 1080 });
  try {
    const page = expression => browser.evaluate(expression);
    const frame = expression => page(`document.getElementById('workFrame').contentWindow.eval(${JSON.stringify(expression)})`);
    await waitFor(() => page(`!![...document.getElementById('projectSelect').options].find(option=>option.value===${JSON.stringify(task.projectId)})`), 'retained project selection');
    await page(`(()=>{const select=document.getElementById('projectSelect');select.value=${JSON.stringify(task.projectId)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=work]').click()})()`);
    await waitFor(() => frame("!document.getElementById('view-terminal').inert && !!document.querySelector('#project-list .session')"), 'restored session list');
    await frame("document.querySelector('#project-list .session').click()");
    await waitFor(() => frame(`state.activeSessionId===${JSON.stringify(task.sessionId)} && document.getElementById('stream-col').textContent.includes(${JSON.stringify(task.commitSha)}) && document.getElementById('btn-send').title!=='停止'`), 'history click restores the actual streamed answer and commit');
    assert.equal(browser.exceptions.length, 0);
    await browser.screenshot(path.join(proof, 'restored-workbench-1920.png'));
  } finally { await browser.close(); }
  AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), { passed: true, before, after, stopped, started, ownership, projectsPreserved: projectIds, completedRunsUnchanged: runsAfter.length, indexRoot, realIndexFilesUnchanged: Object.keys(indexes).length, rebuild, restoredSessionId: task.sessionId, persistedEventsUnchanged: restored.events.length, restoredAnswerCommit: task.commitSha, uiHistoryClickRestored: true, checkedAt: new Date().toISOString() });
  console.log(`GLOBAL_REAL_RESTART_PASSED ${proof}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
