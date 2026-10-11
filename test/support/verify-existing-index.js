'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const [address, auditFile] = process.argv.slice(2);
  const url = new URL(address);
  assert.equal(url.hostname, '127.0.0.1');
  const before = JSON.parse(fs.readFileSync(path.resolve(auditFile))).before;
  assert.equal(before.dataDir, path.join(os.homedir(), '.project-knowledge-v5'));
  const original = before.runs.find(run => run.commitSha === 'e9f65608a0309aeae792075eac13213c93a83162');
  assert.ok(original?.promotedAt && original.analysisRunId);
  const project = before.projects.find(item => item.projectId === original.projectId);
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `index-only-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const read = async route => { const response = await fetch(new URL(route, url), { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const identity = await read('/api/runtime/identity');
  assert.equal(identity.dataDir, before.dataDir);
  assert.match(identity.version, /^5\.0\.9(?:-rc\.\d+)?$/);
  const report = { passed: false, identity, before: original, historyCause: '历史原因无法恢复：旧版本未保存原始索引错误。', startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  save();
  await waitFor(async () => {
    const configuration = (await read('/api/brain')).configuration;
    return configuration?.scopes && configuration.model && configuration.embedding;
  }, 'existing user supervised modules configured', 180000);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: url.href, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const evaluate = expression => browser.evaluate(expression);
    await waitFor(() => evaluate(`!![...document.getElementById('projectSelect').options].find(o=>o.value===${JSON.stringify(project.projectId)})`), 'existing project registry');
    await evaluate(`(()=>{const select=document.getElementById('projectSelect');select.value=${JSON.stringify(project.projectId)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=activity]').click()})()`);
    await waitFor(() => evaluate(`!!document.querySelector('[data-run-id="${original.runId}"]')`), 'existing failed run remains visible');
    await evaluate(`document.querySelector('[data-run-id="${original.runId}"]').open=true`);
    await browser.screenshot(path.join(proof, 'before-1920.png'));
    const current = (await read('/api/engine/runs')).runs.find(run => run.runId === original.runId);
    if (current.state === 'index-pending') {
      report.retryEntry = 'UI retry failed index stage'; save();
      await evaluate(`document.querySelector('[data-retry-run="${original.runId}"]').click()`);
    } else { report.retryEntry = 'engine activation resumes index-only stage'; save(); }
    await waitFor(async () => {
      const run = (await read('/api/engine/runs')).runs.find(item => item.runId === original.runId);
      if (run?.state === 'index-pending') throw Object.assign(new Error(`Index retry failed: ${run.error?.details?.failureKind || run.error?.code}`), { fatal: true });
      return run?.state === 'succeeded';
    }, 'existing real index recovery', 180000);
    const after = (await read('/api/engine/runs')).runs.find(item => item.runId === original.runId);
    assert.equal(after.analysisRunId, original.analysisRunId);
    assert.equal(after.promotedAt, original.promotedAt);
    assert.equal(after.indexState, 'succeeded');
    const hashes = Object.fromEntries(Object.keys(original.knowledgeHashes).map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(path.join(project.knowledgePath, relative))).digest('hex')]));
    assert.deepEqual(hashes, original.knowledgeHashes, 'index retry must not rewrite already promoted knowledge');
    const searched = await fetch(new URL('/api/engine/search', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.projectId, query: original.commitSha, scope: 'project' }), signal: AbortSignal.timeout(20000) });
    assert.ok(searched.ok);
    const result = await searched.json();
    assert.equal(result.health.index, 'ok');
    assert.ok(result.results.some(item => item.commitSha === original.commitSha));
    const parameters = new URLSearchParams({ projectId: project.projectId, operationId: original.runId, event: 'knowledge.index.completed' });
    const logs = await read('/api/logs?' + parameters);
    assert.ok(logs.entries.length && logs.entries.every(item => item.schema === 'log/v2'));
    await waitFor(() => evaluate(`document.querySelector('[data-run-id="${original.runId}"]').textContent.includes('索引：succeeded')`), 'real backend recovery automatically refreshes UI');
    await browser.screenshot(path.join(proof, 'recovered-1920.png'));
    assert.equal(browser.exceptions.length, 0);
    Object.assign(report, { passed: true, after, unchangedKnowledgeHashes: hashes, citations: result.results.map(item => ({ entry: item.entry_id, commit: item.commitSha })), indexLogs: logs.entries, finishedAt: new Date().toISOString() }); save();
    console.log(`EXISTING_V5_INDEX_ONLY_RECOVERY_PASSED ${proof}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`${error.code || 'INDEX_RECOVERY_FAILED'}: ${error.message}`); process.exitCode = 1; });
