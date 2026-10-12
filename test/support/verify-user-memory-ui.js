'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const expected = process.argv[2]; assert.match(expected, /^5\.0\.\d+$/);
  const address = 'http://127.0.0.1:5757';
  const read = async route => { const response = await fetch(address + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const identity = await read('/api/runtime/identity'); assert.equal(identity.version, expected); assert.equal(identity.dataDir, path.join(os.homedir(), '.project-knowledge-v5'));
  const core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  assert.equal(JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version, expected);
  const before = (await read('/api/engine/memories')).memories;
  const brain = (await read('/api/brain')).brain;
  const projects = (await read('/api/projects/aggregated')).projects;
  for (const type of ['global', 'domain', 'project']) assert.deepEqual((await read('/api/engine/memories?scopeType=' + type)).memories.map(m => m.id), before.filter(m => m.scopeType === type).map(m => m.id));
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', `memory-ui-${Date.now()}`);
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: address, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    const page = expression => browser.evaluate(expression);
    await waitFor(() => page('!!document.getElementById("memoryScopeFilter")'), 'installed memory UI');
    await page('document.querySelector("[data-view=memory]").click()');
    assert.deepEqual(await page('[...document.getElementById("memoryScope").options].map(o=>o.value)'), ['global', 'domain', 'project']);
    assert.equal(await page('!!document.getElementById("memoryOriginal") && !!document.getElementById("memoryQuote")'), true);
    assert.equal(await page('!!document.getElementById("addMemory")'), false);
    for (const type of ['domain', 'project', 'global']) {
      await page(`document.getElementById('memoryScopeFilter').value=${JSON.stringify(type)};document.getElementById('memoryScopeFilter').dispatchEvent(new Event('change',{bubbles:true}))`);
      assert.equal(await page('document.getElementById("memoryTargetFilter").hidden'), type === 'global');
      if (type !== 'global') {
        const choices = await page('[...document.getElementById("memoryTargetFilter").options].map(o=>o.value).filter(Boolean)');
        assert.deepEqual(choices.sort(), (type === 'domain' ? brain.domains.map(d => d.id) : projects.map(p => p.projectId)).sort());
      }
    }
    await page('document.getElementById("memoryScopeFilter").value="";document.getElementById("memoryScopeFilter").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await page('document.documentElement.scrollWidth > innerWidth'), false);
    assert.equal(browser.exceptions.length, 0);
    await browser.screenshot(path.join(proof, 'installed-memory-1920.png'));
    assert.deepEqual((await read('/api/engine/memories')).memories, before, 'read-only UI acceptance must not fabricate user preferences');
    AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), { passed: true, identity, memoryCount: before.length, projectCount: projects.length, domainCount: brain.domains.length, scopeChoices: ['global', 'domain', 'project'], noManualAddEntry: true, noUserMemoryWrites: true, checkedAt: new Date().toISOString() });
    console.log('USER_MEMORY_UI_PASSED ' + path.join(proof, 'result.json'));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
