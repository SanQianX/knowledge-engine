'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');
const fingerprint = directory => !fs.existsSync(directory) ? {} : Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  assert.equal(entry.isSymbolicLink(), false);
  return entry.isDirectory() ? Object.entries(fingerprint(file)).map(([name, hash]) => [entry.name + '/' + name, hash]) : [[entry.name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
}));

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  const read = async route => { const response = await fetch(new URL(route, environment.url)); assert.ok(response.ok, route); return response.json(); };
  const oldRoot = (await read('/api/vectorhub/settings')).settings.rootPath;
  const oldIndexes = fingerprint(oldRoot);
  const projects = (await read('/api/projects/aggregated')).projects;
  const locations = projects.map(project => ({ projectId: project.projectId, knowledgePath: project.knowledgePath }));
  const knowledgeBefore = Object.fromEntries(locations.map(project => [project.projectId, fingerprint(project.knowledgePath)]));
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance', `index-storage-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const knowledgeRoot = path.join(proof, 'knowledge');
  const target = path.join(knowledgeRoot, '.indexes');
  const report = { passed: false, installationReport: environment.installationReport, oldRoot, target, sourceKnowledgeLocations: locations, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  save();
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: environment.url, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    await waitFor(() => browser.evaluate("!!document.getElementById('projectSelect').options.length"), 'real project list');
    await browser.evaluate("document.getElementById('openSystem').click()");
    await waitFor(() => browser.evaluate("!document.getElementById('systemDrawer').hidden"), 'system settings');
    await browser.evaluate(`document.getElementById('knowledgeRoot').value=${JSON.stringify(knowledgeRoot)};document.getElementById('saveBrainSettings').click()`);
    await waitFor(async () => (await read('/api/brain')).configuration?.indexStorage?.actualPath === target, 'backend storage acknowledgement', 120000);
    await waitFor(async () => !(await read('/api/vectorhub/rebuild/status')).running, 'real vector rebuild', 180000);
    const rebuild = await read('/api/vectorhub/rebuild/status'); assert.deepEqual(rebuild.errors, []);
    const actual = (await read('/api/vectorhub/settings')).settings.rootPath; assert.equal(actual, target);
    assert.deepEqual(fingerprint(oldRoot), oldIndexes, 'original index directory is retained unchanged');
    assert.deepEqual((await read('/api/projects/aggregated')).projects.map(project => ({ projectId: project.projectId, knowledgePath: project.knowledgePath })), locations);
    for (const project of locations) assert.deepEqual(fingerprint(project.knowledgePath), knowledgeBefore[project.projectId], 'storage switch must not move or rewrite knowledge');
    const chunks = {};
    for (const projectId of ['project-real-a', 'project-real-b']) {
      const index = JSON.parse(fs.readFileSync(path.join(target, projectId, 'index.json')));
      assert.ok(index.items.length && index.items.every(item => item.vector.length === 1536));
      chunks[projectId] = index.items.length;
    }
    const searched = await fetch(environment.url + '/api/engine/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-real-a', scope: 'project', query: '提交知识更新与维护', limit: 10 }) });
    assert.ok(searched.ok); const result = await searched.json(); assert.equal(result.health.index, 'ok'); assert.ok(result.results.some(item => item.commitSha));
    await waitFor(() => browser.evaluate(`document.getElementById('indexStoragePath').textContent===${JSON.stringify(target)} && document.getElementById('indexStorageStatus').textContent.includes('已生效')`), 'UI actual path refresh');
    await browser.evaluate("document.getElementById('indexStoragePath').scrollIntoView({block:'center'})");
    await browser.screenshot(path.join(proof, 'actual-directory-1920.png')); assert.equal(browser.exceptions.length, 0);
    Object.assign(report, { passed: true, actual, rebuild, oldIndexes, rebuiltChunks: chunks, newIndexes: fingerprint(target), citations: result.results.map(item => ({ entry: item.entry_id, commit: item.commitSha })), finishedAt: new Date().toISOString() }); save();
    console.log(`REAL_INDEX_STORAGE_UI_PASSED ${path.join(proof, 'result.json')}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`INDEX_STORAGE_FAILED: ${error.message}`); process.exitCode = 1; });
