'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const environmentFile = path.resolve(process.argv[2]);
  const environment = JSON.parse(fs.readFileSync(environmentFile));
  assert.equal(environment.installationSource, 'project-knowledge/installed-registry/v1');
  assert.ok(environment.model.startsWith('real Agent'));
  const report = JSON.parse(fs.readFileSync(path.join(environment.root, 'real-agent-acceptance.json')));
  const sha = report.commits.find(commit => commit.projectId === 'project-real-a' && commit.state === 'succeeded').commitSha;
  const proof = path.join(environment.root, `real-workbench-web-${Date.now()}`);
  fs.mkdirSync(proof);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(environment.root, `real-workbench-browser-${Date.now()}`), url: environment.url, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const run = expression => browser.evaluate(expression);
    const frame = expression => run(`document.getElementById('workFrame').contentWindow.eval(${JSON.stringify(expression)})`);
    await waitFor(() => run("document.getElementById('projectSelect').options.length===2"), 'registered npm projects');
    await run("(()=>{const field=document.getElementById('projectSelect');field.value='project-real-a';field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=work]').click()})()");
    await waitFor(() => frame("!!document.getElementById('chat-input') && !document.getElementById('btn-model').disabled"), 'real Workbench ready');
    await frame("document.getElementById('open-settings').click();document.querySelector('[data-s=agents]').click()");
    await waitFor(() => frame("!!document.querySelector('#agent-cards .agent-badge.claude-code')"), 'actual installed Claude Code discovery');
    await frame("document.querySelector('#agent-cards .agent-badge.claude-code').closest('.agent-card').click();document.getElementById('settings-back').click()");
    assert.equal(await frame('state.currentAgent'), 'claude-code');
    const previousSessionId = await frame('state.activeSessionId');
    await frame("document.getElementById('btn-new-session').click()");
    await waitFor(() => frame(`!!state.activeSessionId && state.activeSessionId !== ${JSON.stringify(previousSessionId)} && !document.getElementById('btn-model').disabled`), 'fresh UI session does not reuse another acceptance task');
    await waitFor(() => frame("(()=>{if(document.getElementById('pop-model').hidden)document.getElementById('btn-model').click();return [...document.querySelectorAll('#pop-model button')].some(button=>button.textContent.includes('MiniMax-M3'))})()"), 'real model configured');
    const selectedModel = await frame("(()=>{const button=[...document.querySelectorAll('#pop-model button')].find(button=>button.textContent.includes('MiniMax-M3'));const model=button.querySelector('.grow').textContent.trim();button.click();return model})()");
    await waitFor(() => frame(`document.getElementById('model-label').textContent.includes(${JSON.stringify(selectedModel)}) && document.getElementById('pop-model').hidden`), 'selected model applied');
    const prompt = `请先参考注入的项目知识，简要说明知识库为什么由引擎统一写入，并引用提交 ${sha} 对应的真实知识依据。不要调用工具或修改文件。查询关键词：知识、提交、单写者、${sha}。`;
    await frame(`(()=>{const field=document.getElementById('chat-input');field.value=${JSON.stringify(prompt)};field.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click()})()`);
    await waitFor(() => frame("document.getElementById('btn-send').title==='停止'"), 'UI send starts real task');
    const sentSessionId = await frame('state.activeSessionId');
    assert.ok(sentSessionId);
    await waitFor(() => frame(`document.getElementById('stream-col').textContent.includes(${JSON.stringify(sha)}) && document.getElementById('btn-send').title!=='停止'`), 'real answer and citation refresh without reload', 300000);
    await waitFor(() => run("document.querySelectorAll('#contextContent .reference').length>0"), 'real retrieval references displayed');
    await waitFor(async () => {
      const snapshot = await (await fetch(new URL(`/api/terminal/sessions/${sentSessionId}`, environment.url))).json();
      if (snapshot.session?.state !== 'idle') return false;
      return snapshot.events.at(-1)?.type === 'claude/turn-end';
    }, 'backend completion and persisted final turn', 300000);
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    const verified = spawnSync(process.execPath, [path.join(__dirname, 'verify-real-workbench.js'), environmentFile, '--expected-model', selectedModel, '--session-id', sentSessionId], { encoding: 'utf8', windowsHide: true });
    assert.equal(verified.status, 0, verified.stderr);
    await browser.screenshot(path.join(proof, 'workbench-real-1920.png'));
    fs.copyFileSync(path.join(environment.root, 'real-workbench-acceptance.json'), path.join(proof, 'real-workbench-acceptance.json'));
    console.log(verified.stdout.trim());
    console.log('NPM_REAL_WORKBENCH_WEB_PASSED (UI send → real Agent → streamed answer and citations; 1920x1080)');
  } catch (error) {
    await browser.screenshot(path.join(proof, 'workbench-failure-1920.png'));
    fs.writeFileSync(path.join(proof, 'failure.json'), JSON.stringify({ passed: false, message: error.message, checkedAt: new Date().toISOString() }, null, 2));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(`${error.code || 'WORKBENCH_FAILED'}: ${error.message}`); process.exitCode = 1; });
