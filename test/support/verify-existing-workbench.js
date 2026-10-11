'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const address = new URL(process.argv[2]);
  assert.equal(address.hostname, '127.0.0.1');
  const core = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@sanqianx/project-knowledge');
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const read = async route => {
    const response = await fetch(new URL(route, address), { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, route); return response.json();
  };
  const identity = await read('/api/runtime/identity');
  assert.equal(identity.dataDir, dataDir);
  assert.equal(identity.version, require(path.join(core, 'package.json')).version);
  assert.match(identity.version, /^5\.0\.9(?:-rc\.\d+)?$/);
  const projects = (await read('/api/projects/aggregated')).projects;
  const project = projects.find(p => path.resolve(p.workspacePath).toLowerCase() === path.resolve(__dirname, '../..').toLowerCase());
  assert.ok(project?.modules.terminal.registered);
  const run = (await read('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
  assert.ok(run?.commitSha, 'an actual repository repair commit must be promoted first');
  const query = JSON.parse(execFileSync(process.execPath, [path.join(core, 'bin/project-knowledge-kb.js'), 'search', '--project', project.projectId, '--query', run.commitSha, '--scope', 'project', '--json'], { env: { ...process.env, KB_DATA_DIR: dataDir, KB_KNOWLEDGE_ENGINE_URL: '', NODE_PATH: '' }, windowsHide: true, encoding: 'utf8' }));
  assert.equal(query.health.index, 'ok');
  assert.ok(query.results.some(result => result.commitSha === run.commitSha));
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `workbench-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const report = { passed: false, identity, projectId: project.projectId, commitSha: run.commitSha, cliReferences: query.results.map(r => ({ entry: r.entry_id, commit: r.commitSha })), startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  save();
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: address.href, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const page = expression => browser.evaluate(expression);
    const frame = expression => page(`document.getElementById('workFrame').contentWindow.eval(${JSON.stringify(expression)})`);
    await waitFor(() => page(`!![...document.getElementById('projectSelect').options].find(o=>o.value===${JSON.stringify(project.projectId)})`), 'existing registered project');
    await page(`(()=>{const s=document.getElementById('projectSelect');s.value=${JSON.stringify(project.projectId)};s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=work]').click()})()`);
    await waitFor(() => frame("!!document.getElementById('chat-input') && !document.getElementById('btn-model').disabled"), 'existing Workbench ready', 60000);
    await frame("document.getElementById('open-settings').click();document.querySelector('[data-s=agents]').click()");
    await waitFor(() => frame("!!document.querySelector('#agent-cards .agent-badge.claude-code')"), 'actual Claude Code discovery');
    await frame("document.querySelector('#agent-cards .agent-badge.claude-code').closest('.agent-card').click();document.getElementById('settings-back').click()");
    const previousSessionId = await frame('state.activeSessionId');
    await frame("document.getElementById('btn-new-session').click()");
    await waitFor(() => frame(`!!state.activeSessionId && state.activeSessionId!==${JSON.stringify(previousSessionId)} && !document.getElementById('btn-model').disabled`), 'fresh user acceptance session');
    await waitFor(() => frame("(()=>{if(document.getElementById('pop-model').hidden)document.getElementById('btn-model').click();return [...document.querySelectorAll('#pop-model button')].some(b=>b.textContent.includes('MiniMax-M3'))})()"), 'user MiniMax profile');
    const model = await frame("(()=>{const b=[...document.querySelectorAll('#pop-model button')].find(b=>b.textContent.includes('MiniMax-M3'));const model=b.querySelector('.grow').textContent.trim();b.click();return model})()");
    await waitFor(() => frame(`document.getElementById('model-label').textContent.includes(${JSON.stringify(model)}) && document.getElementById('pop-model').hidden`), 'temporary chat model applied');
    const prompt = `这是 npm 安装版的只读验收。请依据注入的项目知识，概括提交 ${run.commitSha} 的改动与约束，引用真实知识文件和完整提交 SHA。不要调用工具、修改文件或读取配置。检索关键词：${run.commitSha}。`;
    await frame(`(()=>{const f=document.getElementById('chat-input');f.value=${JSON.stringify(prompt)};f.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click()})()`);
    await waitFor(() => frame("document.getElementById('btn-send').title==='停止'"), 'user UI send accepted');
    const sessionId = await frame('state.activeSessionId');
    let snapshot;
    await waitFor(async () => {
      snapshot = await read(`/api/terminal/sessions/${sessionId}`);
      const failure = snapshot.events.find(e => e.type === 'claude/error' || e.type === 'claude/result' && e.isError);
      if (failure) throw Object.assign(new Error('Real user task failed; consult associated local logs'), { fatal: true });
      return snapshot.session.state === 'idle' && snapshot.events.at(-1)?.type === 'claude/turn-end';
    }, 'actual user task and persisted final turn', 300000);
    assert.match(snapshot.session.model, /^MiniMax-M3/);
    const deltas = snapshot.events.filter(e => e.type === 'claude/text-delta');
    assert.ok(deltas.length > 1);
    assert.ok(snapshot.events.some(e => e.type === 'claude/result' && !e.isError && String(e.result).includes(run.commitSha)));
    const context = await read(`/api/terminal/sessions/${sessionId}/knowledge`);
    assert.ok(context.references.some(r => r.commitSha === run.commitSha));
    await waitFor(() => frame(`document.getElementById('stream-col').textContent.includes(${JSON.stringify(run.commitSha)}) && document.getElementById('btn-send').title!=='停止'`), 'user UI streams and completes');
    await waitFor(() => page("document.querySelectorAll('#contextContent .reference').length>0"), 'user UI knowledge citations');
    assert.equal(browser.exceptions.length, 0);
    await browser.screenshot(path.join(proof, 'user-workbench-1920.png'));
    Object.assign(report, { passed: true, sessionId, model, deltaCount: deltas.length, references: context.references.map(r => ({ entry: r.entryId, commit: r.commitSha, project: r.projectId })), finalTurnPersisted: true, finishedAt: new Date().toISOString() }); save();
    console.log(`EXISTING_USER_REAL_WORKBENCH_PASSED ${proof}`);
  } catch (error) { report.failure = error.message; save(); await browser.screenshot(path.join(proof, 'failure-1920.png')); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`${error.code || 'USER_WORKBENCH_FAILED'}: ${error.message}`); process.exitCode = 1; });
