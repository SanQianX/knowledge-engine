'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  const verifyStartup = process.argv.includes('--verify-startup');
  const proof = path.join(environment.root, `workbench-init-diagnostic-${Date.now()}.json`);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(environment.root, `init-browser-${Date.now()}`), url: 'about:blank', width: 1920, height: 1080 });
  const steps = [];
  try {
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__initTrace = [];
      const eventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, handler, options) {
        if (this.id === 'btn-new-session') window.__initTrace.push({ event: 'new-session-handler', at: performance.now() });
        return eventListener.call(this, type, handler, options);
      };
      window.addEventListener('message', event => {
        if (event.data?.type === 'kb:ready') window.__initTrace.push({ event: 'ready', at: performance.now(), app: event.data.app });
      });
      const originalFetch = window.fetch;
      window.fetch = async function(input, options) {
        const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        const entry = { event: 'request', path: pathname, method: options?.method || 'GET', at: performance.now() };
        window.__initTrace.push(entry);
        if (${verifyStartup} && window.parent !== window && pathname.endsWith('/ui-preferences')) await new Promise(resolve => { window.__releaseStartup = resolve; });
        try { const response = await originalFetch.apply(this, arguments); entry.status = response.status; entry.finished = performance.now(); return response; }
        catch { entry.failed = true; throw new Error('diagnostic request failed'); }
      };
    ` });
    await browser.send('Page.navigate', { url: environment.url });
    const run = expression => browser.evaluate(expression);
    const frame = expression => run(`document.getElementById('workFrame').contentWindow.eval(${JSON.stringify(expression)})`);
    await waitFor(() => run("document.getElementById('projectSelect').options.length===2"), 'registered projects');
    await run("(()=>{const field=document.getElementById('projectSelect');field.value='project-real-a';field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=work]').click()})()");
    await waitFor(() => frame("!!document.getElementById('chat-input') && !document.getElementById('btn-model').disabled"), 'old test ready check');
    const snapshot = label => Promise.all([run('window.__initTrace'), frame("({ trace: window.__initTrace, project: state.activeProjectId, session: state.activeSessionId, selectionEpoch, sessionCreationEpoch, inert: document.getElementById('view-terminal').inert, busy: document.getElementById('view-terminal').getAttribute('aria-busy') })")]).then(([shell, workbench]) => steps.push({ label, shell, workbench }));
    await snapshot('old-ready');
    await frame("document.getElementById('open-settings').click();document.querySelector('[data-s=agents]').click()");
    await waitFor(() => frame("!!document.querySelector('#agent-cards .agent-badge.claude-code')"), 'discovery cards');
    await frame("document.querySelector('#agent-cards .agent-badge.claude-code').closest('.agent-card').click();document.getElementById('settings-back').click()");
    await snapshot('before-click');
    await frame("document.getElementById('btn-new-session').click()");
    await snapshot('after-click');
    if (verifyStartup) {
      assert.equal(steps.at(-1).workbench.inert, true, 'startup controls must be noninteractive while data loads');
      assert.equal(steps.at(-1).workbench.busy, 'true');
      assert.equal(steps.at(-1).workbench.session, null);
      await waitFor(() => frame("typeof window.__releaseStartup === 'function'"), 'controlled startup delay');
      await frame('window.__releaseStartup()');
    }
    await waitFor(() => run("window.__initTrace.some(item=>item.event==='ready' && item.app==='agent-terminal')"), 'actual usable boundary', 30000);
    await snapshot('actual-ready');
    if (verifyStartup) { assert.equal(steps.at(-1).workbench.inert, false); assert.equal(steps.at(-1).workbench.busy, 'false'); }
    if (!(await frame('state.activeSessionId'))) {
      await frame("document.getElementById('btn-new-session').click()");
      await waitFor(() => frame('!!state.activeSessionId'), 'session after usable boundary', 30000);
      await snapshot('after-ready-click');
    }
    assert.equal(browser.exceptions.length, 0);
    fs.writeFileSync(proof, JSON.stringify({ passed: verifyStartup, mode: verifyStartup ? 'installed startup gate with a controlled preference-response delay; no model call' : 'passive initialization diagnostic', checkedAt: new Date().toISOString(), steps, exceptions: browser.exceptions }, null, 2));
    console.log(proof);
    console.log(JSON.stringify(steps.map(step => ({ label: step.label, project: step.workbench.project, session: step.workbench.session, bound: step.workbench.trace.some(item=>item.event==='new-session-handler'), ready: step.shell.some(item=>item.event==='ready' && item.app==='agent-terminal'), postSessions: step.workbench.trace.filter(item=>item.path?.endsWith('/sessions') && item.method==='POST') })), null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
