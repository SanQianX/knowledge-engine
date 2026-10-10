'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const shellRoot = path.resolve(__dirname, '../../../project-knowledge-base');
const { findChrome } = require(path.join(shellRoot, '_site/_test/helpers/find-chrome'));
const { launchCdpBrowser, waitFor } = require(path.join(shellRoot, '_site/_test/helpers/cdp-browser'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), '智脑桌面验收-'));
const proof = path.resolve(__dirname, `../../.agent-state/acceptance/${process.env.KB_PRODUCT_INSTALLATION_REPORT ? 'npm-web-faults' : 'web-faults'}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (repo, args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'product-preview.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KB_PRODUCT_TEST_ROOT: root, KB_PRODUCT_TEST_PORT: '0', KB_ACCEPTANCE_REAL_PROFILE_ID: '', KB_ACCEPTANCE_REAL_EMBEDDING: '0', KB_ACCEPTANCE_FAULT_SCENARIOS: '1' } });
  let tail = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { tail = (tail + data).slice(-4000); });
  let browser, environment;
  try {
    const file = path.join(root, 'acceptance-environment.json');
    await waitFor(() => { if (child.exitCode !== null) throw Object.assign(new Error(tail), { fatal: true }); return fs.existsSync(file); }, 'real product fixture', 25000);
    environment = JSON.parse(fs.readFileSync(file));
    const api = async (route, body) => {
      const response = await fetch(environment.url + route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      const payload = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(payload)}`); return payload;
    };
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(root, 'browser'), url: environment.url, width: 1920, height: 1080 }); await browser.setViewport(1920, 1080);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const NativeSource = window.EventSource; window.__faultStreams = []; window.EventSource = class extends NativeSource { constructor(...args) { super(...args); window.__faultStreams.push(this); } }; })();` });
    await browser.send('Page.navigate', { url: environment.url });
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => run(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); field.value=${JSON.stringify(value)}; field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const select = id => run(`(() => { const field=document.getElementById('projectSelect'); field.value=${JSON.stringify(id)}; field.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('第一个项目')"), 'empty product');
    const projects = [];
    await click('[data-view="projects"]');
    for (const [index, repo] of environment.repositories.entries()) {
      await click('.view.active [data-action="import"]'); await fill('#importCode', repo); await fill('#importKnowledge', path.join(environment.knowledgeRoot, `故障项目 ${index + 1}`));
      await waitFor(() => run("!document.getElementById('confirmImport').disabled"), 'preflight'); await click('#confirmImport');
      await waitFor(() => run(`!document.getElementById('importDialog').open && document.getElementById('projectDetail').textContent.includes(${JSON.stringify(repo)})`), 'four-module import', 30000);
      const id = await run("document.getElementById('projectSelect').value"); projects.push((await api('/api/projects/aggregated')).projects.find(p => p.projectId === id));
    }
    assert.ok(projects.every(p => Object.values(p.modules).every(module => module.registered)));
    const commit = (index, subject) => {
      const repo = projects[index].workspacePath;
      fs.writeFileSync(path.join(repo, 'fault-test.txt'), `${subject}\n`); git(repo, ['add', 'fault-test.txt']); git(repo, ['commit', '-qm', subject]); return git(repo, ['rev-parse', 'HEAD']);
    };
    const getRun = async sha => (await api('/api/engine/runs')).runs.find(item => item.commitSha === sha);
    const timeoutSha = commit(0, 'acceptance-timeout');
    const indexSha = commit(1, 'acceptance-index-failure');
    await waitFor(async () => (await getRun(timeoutSha))?.state === 'failed' && (await getRun(indexSha))?.state === 'index-pending', 'independent model and index failures', 45000);
    const timeoutRun = await getRun(timeoutSha), indexRun = await getRun(indexSha);
    assert.equal(timeoutRun.error.code, 'MODEL_TIMEOUT'); assert.equal(indexRun.error.code, 'INDEX_FAILED');
    const indexFile = path.join(projects[1].knowledgePath, `changes/${indexSha.slice(0, 12)}.md`);
    assert.ok(fs.readFileSync(indexFile, 'utf8').includes(indexSha), 'promotion remains valid when indexing fails');
    const promotedBytes = fs.readFileSync(indexFile);
    await click('[data-view="activity"]');
    await waitFor(() => run(`document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(indexSha.slice(0, 8))}) && document.getElementById('activityUpdates').textContent.includes('索引待修复')`), 'UI reflects partial success');
    await click(`.run[data-run-id="${indexRun.runId}"] summary`);
    assert.ok(await run("document.getElementById('activityUpdates').textContent.includes('知识已更新，索引待修复')"));
    await browser.screenshot(path.join(proof, 'index-pending-1920.png'));
    await click(`[data-retry-run="${indexRun.runId}"]`);
    await waitFor(async () => (await getRun(indexSha))?.state === 'succeeded', 'UI index-only retry', 30000);
    await waitFor(() => run("document.getElementById('activityUpdates').textContent.includes('可检索')"), 'ready feedback without reload');
    assert.ok(fs.readFileSync(indexFile).equals(promotedBytes));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fault-observations.json'))).attempts[indexSha], 1, 'index repair must not re-run the model');

    const queuedSha = commit(0, 'acceptance-after-timeout');
    await waitFor(async () => (await getRun(queuedSha))?.phase === 'waiting-previous', 'same-project FIFO block');
    await select(projects[0].projectId);
    await waitFor(() => run("document.getElementById('activityUpdates').textContent.includes('MODEL_TIMEOUT')"), 'model failure belongs to A');
    assert.equal(await run(`document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(indexSha.slice(0, 8))})`), false, 'B index failure does not leak into A');
    await click(`.run[data-run-id="${timeoutRun.runId}"] summary`); await click(`[data-retry-run="${timeoutRun.runId}"]`);
    await waitFor(async () => (await getRun(timeoutSha))?.state === 'succeeded' && (await getRun(queuedSha))?.state === 'succeeded', 'retry restores FIFO', 45000);
    const retriedTimeout = await getRun(timeoutSha);
    assert.equal(retriedTimeout.analysisRunId, timeoutRun.analysisRunId, 'retry uses the same frozen evidence claim');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fault-observations.json'))).attempts[timeoutSha], 2);
    for (const sha of [timeoutSha, queuedSha]) assert.ok(fs.readFileSync(path.join(projects[0].knowledgePath, `changes/${sha.slice(0, 12)}.md`), 'utf8').includes(sha));

    const beforeFiles = fs.readdirSync(path.join(projects[0].knowledgePath, 'changes')).sort();
    const beforeBytes = beforeFiles.map(name => fs.readFileSync(path.join(projects[0].knowledgePath, 'changes', name)).toString('base64'));
    const invalidSha = commit(0, 'acceptance-invalid');
    await waitFor(async () => (await getRun(invalidSha))?.state === 'failed', 'illegal model manifest', 30000);
    const invalidRun = await getRun(invalidSha); assert.equal(invalidRun.error.code, 'PATH_OUTSIDE_ROOT');
    assert.deepEqual(fs.readdirSync(path.join(projects[0].knowledgePath, 'changes')).sort(), beforeFiles);
    assert.deepEqual(beforeFiles.map(name => fs.readFileSync(path.join(projects[0].knowledgePath, 'changes', name)).toString('base64')), beforeBytes);
    assert.equal(fs.existsSync(path.join(environment.knowledgeRoot, 'outside.md')), false);
    await waitFor(() => run("document.getElementById('activityUpdates').textContent.includes('PATH_OUTSIDE_ROOT')"), 'safe failure visible without reload');
    await click(`.run[data-run-id="${invalidRun.runId}"] summary`); await browser.screenshot(path.join(proof, 'invalid-output-1920.png'));
    await click(`[data-retry-run="${invalidRun.runId}"]`); await waitFor(async () => (await getRun(invalidSha))?.state === 'succeeded', 'invalid output replaced through controlled retry', 30000);

    const emptySha = commit(0, 'acceptance-empty-output');
    await waitFor(async () => (await getRun(emptySha))?.state === 'failed', 'empty Markdown rejected', 30000);
    const emptyRun = await getRun(emptySha); assert.equal(emptyRun.error.code, 'ANALYSIS_EMPTY_DOCUMENT');
    assert.equal(emptyRun.error.phase, 'validating');
    assert.equal(fs.existsSync(path.join(projects[0].knowledgePath, `changes/${emptySha.slice(0, 12)}.md`)), false);
    await waitFor(() => run("document.getElementById('activityUpdates').textContent.includes('知识文档正文为空')"), 'actual validation reason appears without reload');
    const records = (await api(`/api/logs?projectId=${projects[0].projectId}&commitSha=${emptySha}`)).entries;
    assert.ok(records.some(record => record.event === 'knowledge.maintenance.failed' && record.phase === 'validating' && record.error.message.includes('知识文档正文为空')));
    await click('#openSystem'); await click('#openLogs');
    await fill('#logsSearch', emptySha); await click('#loadLogs');
    await waitFor(() => run("document.getElementById('logsContent').textContent.includes('knowledge.maintenance.failed')"), 'diagnostic dialog contains maintenance failure');
    await browser.screenshot(path.join(proof, 'empty-output-diagnostics-1920.png'));
    await run("document.getElementById('logsDialog').close()");
    await click(`.run[data-run-id="${emptyRun.runId}"] summary`); await click(`[data-retry-run="${emptyRun.runId}"]`);
    await waitFor(async () => (await getRun(emptySha))?.state === 'succeeded', 'empty output explicit retry succeeds', 30000);

    await select(projects[1].projectId);
    await browser.send('Network.enable');
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(() => run("document.getElementById('activityConnection').textContent.includes('中断')"), 'connection failure visible', 10000);
    const offlineSha = commit(1, 'acceptance-browser-offline');
    await waitFor(async () => (await getRun(offlineSha))?.state === 'succeeded', 'closed/offline browser cannot stop maintenance', 45000);
    await delay(15000);
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(() => run(`document.getElementById('activityConnection').textContent.includes('已连接') && document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(offlineSha.slice(0, 8))}) && document.getElementById('activityUpdates').textContent.includes('可检索')`), 'snapshot and stream automatically recover', 30000);
    assert.equal(await run("window.__faultStreams.filter(stream=>stream.url.endsWith('/api/engine/progress') && stream.readyState!==2).length"), 1, 'reconnect must reuse the sole progress subscription');
    assert.equal(await run(`document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(invalidSha.slice(0, 8))})`), false);
    await browser.screenshot(path.join(proof, 'reconnected-1920.png'));

    for (const route of ['/api/engine/runtime-config', '/api/engine/scopes', '/api/terminal/internal/resolve-profile', '/api/eventbridge/internal/capture', '/api/vectorhub/internal/runtime-config']) {
      const response = await fetch(environment.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403, route);
    }
    for (const moduleUrl of [environment.modules.engine, environment.modules.workbench, environment.modules.events, environment.modules.vectors]) {
      const response = await fetch(moduleUrl + (moduleUrl === environment.modules.engine ? '/api/runtime-config' : moduleUrl === environment.modules.workbench ? '/api/claude-workbench/v1/internal/resolve-profile' : moduleUrl === environment.modules.events ? '/api/internal/capture' : '/api/internal/runtime-config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403, 'private configuration requires runtime authentication');
    }
    const serialized = JSON.stringify(await api('/api/engine/snapshot')) + JSON.stringify(await api('/api/projects/aggregated')) + fs.readFileSync(path.join(root, 'engine', 'engine-state.json'), 'utf8') + await run('document.body.innerText');
    for (const marker of ['controlled-agent-not-real', 'controlled-embedding-not-real']) assert.ok(!serialized.includes(marker), 'credentials must not appear in projected state, engine store or UI');
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    fs.mkdirSync(proof, { recursive: true }); fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), installationSource: environment.installationSource, runtimeRoots: environment.runtimeRoots, viewport: '1920x1080', model: 'controlled failure injection', embedding: 'controlled substitute', timeoutSha, indexSha, queuedSha, invalidSha, offlineSha, assertions: ['UI model failure and same-claim retry', 'FIFO block and recovery', 'independent project progression', 'UI index-only repair retains promoted bytes', 'illegal output cannot touch canonical knowledge', 'live failure-to-success page refresh', 'browser offline maintenance and automatic snapshot recovery', 'single reconnecting stream and project isolation', 'private endpoint authentication and public-state credential checks'] }, null, 2));
    console.log('PRODUCT_WEB_FAULT_ACCEPTANCE_PASSED (real services/Git/Hook/files/index; controlled failures; desktop only)');
  } catch (error) {
    if (browser) { console.error(await browser.evaluate('document.body.innerText')); await browser.screenshot(path.join(proof, 'failure.png')); }
    throw error;
  } finally {
    if (browser) await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await browser?.close();
    if (child.exitCode === null) { child.stdin.write('stop\n'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]); }
    if (child.exitCode === null) { child.kill(); await delay(1000); }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('智脑桌面验收-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
