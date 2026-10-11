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
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-'));
  assert.ok(environment.model.startsWith('real Agent and real embeddings'));
  const read = async route => (await (await fetch(new URL(route, environment.url))).json());
  const failed = (await read('/api/engine/runs')).runs.find(r => r.state === 'index-pending' && r.projectId === 'project-real-a');
  assert.ok(failed?.promotedAt && failed.analysisRunId && failed.error.details);
  const project = (await read('/api/projects/aggregated')).projects.find(p => p.projectId === failed.projectId);
  const fingerprint = () => Object.fromEntries(failed.staging.operations.filter(op => op.operation !== 'delete').map(op => [op.path, crypto.createHash('sha256').update(fs.readFileSync(path.join(project.knowledgePath, op.path))).digest('hex')]));
  const before = { ...failed, knowledgeHashes: fingerprint() };
  const proof = path.join(environment.root, `real-index-recovery-${Date.now()}`); fs.mkdirSync(proof);
  AtomicFile.writeJsonAtomic(path.join(proof, 'before.json'), before);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: environment.url, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const evaluate = expression => browser.evaluate(expression);
    await waitFor(() => evaluate("document.getElementById('projectSelect').options.length===2"), 'project list');
    await evaluate("(()=>{const field=document.getElementById('projectSelect');field.value='project-real-a';field.dispatchEvent(new Event('change'));document.querySelector('[data-view=activity]').click()})()");
    await waitFor(() => evaluate("document.getElementById('activityUpdates').textContent.includes('HTTP_500')"), 'real upstream failure shown in UI');
    await evaluate("document.querySelector('#activityUpdates details').open=true");
    await browser.screenshot(path.join(proof, 'failure-1920.png'));
    await evaluate("document.getElementById('openSystem').click()");
    await waitFor(() => evaluate("!document.getElementById('systemDrawer').hidden"), 'system drawer');
    await evaluate("document.getElementById('openEmbedding').click()");
    await waitFor(() => evaluate("document.getElementById('embeddingDialog').open"), 'embedding configuration');
    await evaluate("document.getElementById('embeddingEndpoint').value='https://api.minimaxi.com';document.getElementById('embeddingForm').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('embeddingFeedback').textContent.includes('已保存并同步')"), 'configuration feedback', 30000);
    await evaluate("document.querySelector('[data-close=embeddingDialog]').click();document.querySelector('[data-retry-run]').click()");
    await waitFor(async () => (await read('/api/engine/runs')).runs.find(r => r.runId === failed.runId)?.state === 'succeeded', 'real index retry', 120000);
    const after = (await read('/api/engine/runs')).runs.find(r => r.runId === failed.runId);
    assert.equal(after.analysisRunId, before.analysisRunId);
    assert.equal(after.promotedAt, before.promotedAt);
    assert.deepEqual(fingerprint(), before.knowledgeHashes);
    assert.equal(after.indexAttempts, before.indexAttempts + 1);
    const indexRoot = (await read('/api/vectorhub/settings')).settings.rootPath;
    const index = JSON.parse(fs.readFileSync(path.join(indexRoot, failed.projectId, 'index.json')));
    assert.ok(index.items.length && index.items.every(item => item.vector.length === 1536));
    await waitFor(() => evaluate("document.getElementById('activityUpdates').textContent.includes('索引：succeeded')"), 'automatic UI refresh');
    await browser.screenshot(path.join(proof, 'recovered-1920.png'));
    assert.equal(browser.exceptions.length, 0);
    AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), { passed: true, before, after, unchangedKnowledgeHashes: fingerprint(), realVectorChunks: index.items.length, dimension: 1536, installationSource: environment.installationSource, checkedAt: new Date().toISOString() });
    process.stdout.write(`REAL_INDEX_ONLY_WEB_RECOVERY_PASSED ${proof}\n`);
  } catch (error) {
    AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), { passed: false, before, error: { code: error.code || 'RECOVERY_FAILED', message: error.message }, checkedAt: new Date().toISOString() });
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { process.stderr.write(`${error.code || 'RECOVERY_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
