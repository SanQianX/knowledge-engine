'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');
const fingerprint = (directory, relative = '') => !fs.existsSync(directory) ? {} : Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  assert.equal(entry.isSymbolicLink(), false);
  if (!relative && ['config.json', 'settings.json'].includes(entry.name)) return [];
  const file = path.join(directory, entry.name);
  const name = relative + entry.name;
  return entry.isDirectory() ? Object.entries(fingerprint(file, name + '/')) : [[name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
}));

async function main() {
  const [mode, reportFile, address] = process.argv.slice(2);
  assert.ok(['record', 'verify'].includes(mode));
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const oldRoot = path.join(dataDir, 'vectorhub');
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json')));
  const knowledgeRoot = path.resolve(settings.knowledge.rootPath);
  assert.equal(knowledgeRoot.toLowerCase(), 'd:\\sanqian.xu\\knowledge');
  const target = path.join(knowledgeRoot, '.indexes');
  if (mode === 'record') {
    assert.equal(fs.existsSync(reportFile), false);
    AtomicFile.writeJsonAtomic(reportFile, { passed: false, dataDir, knowledgeRoot, target, oldRoot, oldIndexes: fingerprint(oldRoot), recordedAt: new Date().toISOString() });
    console.log(`USER_INDEX_STORAGE_RECORDED ${reportFile}`); return;
  }
  const report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.dataDir, dataDir);
  assert.equal(report.target, target);
  const url = new URL(address); assert.equal(url.hostname, '127.0.0.1');
  const read = async route => { const response = await fetch(new URL(route, url), { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const identity = await read('/api/runtime/identity');
  assert.equal(identity.dataDir, dataDir); assert.match(identity.version, /^5\.0\.9(?:-rc\.\d+)?$/);
  // The launcher becomes reachable before supervised modules acknowledge their
  // configuration. Verify the acknowledged directory, not that transient phase.
  await waitFor(async () => {
    const configuration = (await read('/api/brain')).configuration;
    return configuration?.indexStorage?.status === 'ready' && configuration?.scopeStatus?.status === 'ready' && configuration.embedding;
  }, 'user module configuration acknowledgment', 180000);
  await waitFor(async () => !(await read('/api/vectorhub/rebuild/status')).running, 'user real index rebuild', 180000);
  const brain = await read('/api/brain');
  assert.equal(brain.configuration.indexStorage.actualPath, target);
  assert.equal(brain.configuration.indexStorage.status, 'ready');
  assert.equal(brain.configuration.scopeStatus.status, 'ready');
  assert.deepEqual(fingerprint(oldRoot), report.oldIndexes, 'old C index bytes must remain intact');
  const projectIds = (await read('/api/projects/aggregated')).projects.map(project => project.projectId);
  const indexes = [];
  for (const projectId of projectIds) {
    const index = JSON.parse(fs.readFileSync(path.join(target, projectId, 'index.json')));
    assert.ok(index.items.every(item => item.vector.length === 1536 && item.vector.every(Number.isFinite)));
    const catalog = JSON.parse(fs.readFileSync(path.join(target, projectId, 'catalog.json')));
    assert.ok(Object.keys(catalog.uriToId).every(uri => !uri.split(/[\\/]/).some(segment => ['dev-conversations', '_ai', '_backup', 'node_modules'].includes(segment.toLowerCase()))));
    indexes.push({ projectId, chunks: index.items.length, dimension: index.items.length ? 1536 : null });
  }
  assert.ok(indexes.some(index => index.chunks > 0), 'a real nonempty user index is required');
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `index-directory-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: url.href, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    await waitFor(() => browser.evaluate('!!document.getElementById("openSystem")'), 'user product UI');
    await browser.evaluate('document.getElementById("openSystem").click()');
    await waitFor(() => browser.evaluate(`document.getElementById('indexStoragePath').textContent===${JSON.stringify(target)}`), 'actual acknowledged user directory');
    await browser.evaluate('document.getElementById("indexStoragePath").scrollIntoView({block:"center"})');
    await browser.screenshot(path.join(proof, 'user-directory-1920.png'));
    assert.equal(browser.exceptions.length, 0);
  } finally { await browser.close(); }
  Object.assign(report, { passed: true, identity, indexes, proof, verifiedAt: new Date().toISOString() });
  AtomicFile.writeJsonAtomic(reportFile, report);
  console.log(`USER_INDEX_STORAGE_PASSED ${reportFile}`);
}
main().catch(error => { console.error(`${error.code || 'USER_STORAGE_ACCEPTANCE_FAILED'}: ${error.message}`); process.exitCode = 1; });
