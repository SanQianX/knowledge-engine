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
const proof = path.resolve(__dirname, `../../.agent-state/acceptance/${process.env.KB_PRODUCT_INSTALLATION_REPORT ? 'npm-web-regression' : 'web-regression'}`, `run-${Date.now()}-node${process.versions.node.split('.')[0]}`);
const environmentFile = path.join(root, 'acceptance-environment.json');
const git = (repo, args) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'product-preview.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, KB_PRODUCT_TEST_ROOT: root, KB_PRODUCT_TEST_PORT: '0', KB_ACCEPTANCE_REAL_PROFILE_ID: '', KB_ACCEPTANCE_REAL_EMBEDDING: '0', KB_ACCEPTANCE_STREAM_DELAY_MS: '1800', KB_ACCEPTANCE_DISTINCT_MEMORIES: '1', KB_ACCEPTANCE_TITLELESS_OUTPUT: '1', KB_ACCEPTANCE_INVALID_MEMORY_CANDIDATE: '1',
  } });
  let tail = ''; child.stdout.on('data', data => { tail = (tail + data).slice(-6000); }); child.stderr.on('data', data => { tail = (tail + data).slice(-6000); });
  let browser, environment;
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw Object.assign(new Error(`Fixture exited: ${tail}`), { fatal: true });
      return fs.existsSync(environmentFile);
    }, 'four real modules and shell', 25000);
    environment = JSON.parse(fs.readFileSync(environmentFile, 'utf8'));
    const api = async (route, body, method) => {
      const response = await fetch(environment.url + route, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      const payload = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(payload)}`); return payload;
    };
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(root, 'browser'), url: environment.url, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const NativeSource = window.EventSource;
      window.__webStreams = [];
      window.EventSource = class extends NativeSource { constructor(...args) { super(...args); window.__webStreams.push(this); } };
      const nativeFetch = window.fetch.bind(window);
      window.__heldRequests = [];
      window.__registryInFlight = 0;
      window.fetch = async (...args) => {
        const registry = ['/api/brain','/api/projects/aggregated','/api/modules/health','/api/engine/snapshot'].includes(String(args[0]).split('?')[0]);
        if (registry) window.__registryInFlight++;
        let consumed = false;
        const settled = () => { if (registry && !consumed) { consumed = true; window.__registryInFlight--; } };
        try {
          const response = await nativeFetch(...args);
          if (window.__holdRoute && String(args[0]).includes(window.__holdRoute)) { window.__holdRoute = ''; await new Promise(resolve => window.__heldRequests.push(resolve)); }
          if (registry) { const json = response.json.bind(response); response.json = async () => { try { return await json(); } finally { settled(); } }; }
          return response;
        } catch (error) { settled(); throw error; }
      };
    })();` });
    await browser.send('Page.navigate', { url: environment.url });
    const run = expression => browser.evaluate(expression);
    const frame = (id, expression) => run(`document.getElementById(${JSON.stringify(id)}).contentWindow.eval(${JSON.stringify(expression)})`);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value, id) => (id ? expression => frame(id, expression) : run)(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const select = id => run(`(() => { const select = document.getElementById('projectSelect'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => run("document.getElementById('homeContent').textContent.includes('第一个项目')"), 'true empty state');
    assert.equal(await run("getComputedStyle(document.getElementById('indexStoragePath')).display"), 'block', 'actual index path must be a readable block, not overlapping inline boxes');
    await click('[data-view="projects"]'); await click('#createDomain'); await fill('#domainForm input[name="name"]', '网页验收领域'); await click('#domainForm button[type="submit"]');
    await waitFor(() => run("!document.getElementById('domainDialog').open && document.getElementById('projectTree').textContent.includes('网页验收领域')"), 'domain UI feedback');
    await waitFor(() => run('window.__registryInFlight === 0'), 'previous registry read settles before fault injection');
    await run("window.__holdRoute='/api/projects/aggregated';window.dispatchEvent(new Event('online'))");
    await waitFor(() => run('window.__heldRequests.length>0'), 'hold pre-domain registry response');
    await click('#createDomain'); await fill('#domainForm input[name="name"]', '并发刷新验收领域'); await click('#domainForm button[type="submit"]');
    await waitFor(() => run("!document.getElementById('domainDialog').open && document.getElementById('projectTree').textContent.includes('并发刷新验收领域')"), 'domain creation invalidates held reads');
    await run('window.__heldRequests.splice(0).forEach(release=>release())');
    assert.ok(await run("document.getElementById('projectTree').textContent.includes('并发刷新验收领域')"), 'late old read cannot remove the created domain');
    const projects = [];
    for (const [index, repo] of environment.repositories.entries()) {
      await click('.view.active [data-action="import"]'); await fill('#importCode', repo); await fill('#importKnowledge', path.join(environment.knowledgeRoot, `项目 ${index + 1}`));
      await run("document.getElementById('importDomain').value=[...document.getElementById('importDomain').options].find(o=>o.textContent==='网页验收领域').value");
      await waitFor(() => run("!document.getElementById('confirmImport').disabled"), 'real preflight'); await click('#confirmImport');
      await waitFor(() => run(`!document.getElementById('importDialog').open && document.getElementById('projectDetail').textContent.includes(${JSON.stringify(repo)})`), 'real import and refreshed selection', 30000);
      const id = await run("document.getElementById('projectSelect').value");
      const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === id);
      assert.ok(project && Object.values(project.modules).every(m => m.registered), 'all four real modules are registered'); projects.push(project);
    }
    assert.equal((await api('/api/engine/runs')).runs.length, 0, 'import must not analyze old commits');
    const commits = await Promise.all(projects.map(async (project, index) => {
      fs.writeFileSync(path.join(project.workspacePath, 'web-test.txt'), `网页验收 ${index}\n`);
      git(project.workspacePath, ['add', 'web-test.txt']);
      const sha = await new Promise((resolve, reject) => {
        const commit = spawn('git', ['commit', '-qm', `网页真实 Hook 验收 ${index}`], { cwd: project.workspacePath, windowsHide: true, stdio: 'pipe' });
        let stderr = ''; commit.stderr.on('data', data => stderr += data);
        commit.once('exit', code => code === 0 ? resolve(git(project.workspacePath, ['rev-parse', 'HEAD'])) : reject(new Error(stderr)));
      });
      return { projectId: project.projectId, sha };
    }));
    await click('[data-view="activity"]');
    await waitFor(() => run(`document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(commits[1].sha.slice(0, 8))}) && document.getElementById('activityUpdates').textContent.includes('可检索')`), 'commit → promotion → index → live page', 45000);
    assert.equal(await run(`document.getElementById('activityUpdates').textContent.includes(${JSON.stringify(commits[0].sha.slice(0, 8))})`), false, 'A feedback must not appear on B');
    await waitFor(async () => (await api('/api/engine/runs')).runs.filter(r => r.state === 'succeeded').length === 2, 'both projects indexed', 45000);
    const runs = (await api('/api/engine/runs')).runs;
    assert.equal(runs.length, 2); assert.ok(runs.every(r => r.state === 'succeeded' && r.indexState === 'succeeded'));
    assert.ok(runs.every(r => r.memoryCapture.accepted === 1 && r.memoryCapture.rejected[0].code === 'ENTRY_NOT_PROMOTED'));
    await waitFor(() => run("document.getElementById('activityUpdates').textContent.includes('依据无效，未纳入候选箱')"), 'invalid model candidates remain visible without blocking valid promotion');
    await waitFor(async () => (await api('/api/logs?q=knowledge.memory.candidate_rejected')).entries.length === 2, 'candidate rejection diagnostics durable and linked to real commits');
    for (const [index, project] of projects.entries()) {
      const text = fs.readFileSync(path.join(project.knowledgePath, `changes/${commits[index].sha.slice(0, 12)}.md`), 'utf8');
      assert.ok(text.includes(commits[index].sha)); assert.match(text, /^# 提交 .* 变更记录/);
    }
    await waitFor(() => run("document.getElementById('activityConnection').textContent === '已连接实时更新'"), 'completed activity screenshot has an accurate connected status');
    await browser.screenshot(path.join(proof, 'activity-1920-light.png'));

    await select(projects[0].projectId); await click('[data-view="work"]');
    await waitFor(() => frame('workFrame', "document.getElementById('project-list').textContent.includes('测试项目 A') && !!document.getElementById('chat-input') && !document.getElementById('view-terminal').inert"), 'native workbench ready and selected');
    await waitFor(() => frame('workFrame', "!document.getElementById('btn-model').disabled"), 'workbench capabilities loaded');
    await frame('workFrame', "document.getElementById('btn-model').click()");
    await waitFor(() => frame('workFrame', "[...document.querySelectorAll('#pop-model button')].some(button=>button.textContent.includes('controlled-model'))"), 'controlled profile menu');
    await frame('workFrame', "[...document.querySelectorAll('#pop-model button')].find(button=>button.textContent.includes('controlled-model')).click()");
    await fill('#chat-input', '知识写入边界', 'workFrame'); await frame('workFrame', "document.getElementById('btn-send').click()");
    await waitFor(() => frame('workFrame', "document.getElementById('stream-col').textContent.includes('WORKBENCH_')"), 'streaming increment before completion');
    await click('[data-view="home"]'); await click('[data-view="work"]');
    await waitFor(() => frame('workFrame', "document.getElementById('stream-col').textContent.includes('WORKBENCH_RUNTIME_OK')"), 'stream survives shell navigation');
    await waitFor(() => run("document.querySelectorAll('#contextContent .reference').length > 0"), 'actual engine references in shell');
    await click('#contextContent .reference');
    await waitFor(() => run(`document.getElementById('referenceDialog').open && document.getElementById('referenceContent').textContent.includes(${JSON.stringify(commits[0].sha)})`), 'shell citation loads canonical file');
    await run("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedReference=text}}})");
    await click('#copyReference');
    await waitFor(() => run(`window.__copiedReference?.includes(${JSON.stringify(commits[0].sha)})`), 'copy control includes content and provenance');
    await click('[data-close="referenceDialog"]');
    assert.equal(await run("document.querySelector('.knowledge-context').scrollWidth > document.querySelector('.knowledge-context').clientWidth"), false, 'long commit citation must wrap inside the context pane');
    const sessions = await api(`/api/terminal/sessions?contextId=${encodeURIComponent(projects[0].modules.terminal.projectId)}`); assert.equal(sessions.sessions.length, 1);
    const sessionId = sessions.sessions[0].sessionId;
    const context = await api(`/api/terminal/sessions/${sessionId}/knowledge`);
    assert.ok(context.references.some(r => r.projectId === projects[0].projectId));
    assert.ok(!context.references.some(r => r.entryId === 'memories/confirmed.md' && r.text.includes('维护偏好')), 'unconfirmed candidates must not be injected');
    await fill('#chat-input', '项目 A 未发送草稿', 'workFrame');
    await select(projects[1].projectId); await delay(100);
    assert.equal(await frame('workFrame', "document.getElementById('chat-input').value"), '');
    await fill('#chat-input', '项目 B 未发送草稿', 'workFrame');
    await select(projects[0].projectId);
    await waitFor(() => frame('workFrame', "document.getElementById('chat-input').value === '项目 A 未发送草稿' && document.getElementById('stream-col').textContent.includes('WORKBENCH_RUNTIME_OK')"), 'A draft/history recover without B content');
    await fill('#chat-input', '网页中止验收', 'workFrame'); await frame('workFrame', "document.getElementById('btn-send').click()");
    await waitFor(() => frame('workFrame', "document.getElementById('btn-send').title === '停止'"), 'running stop button');
    await frame('workFrame', "document.getElementById('btn-send').click()");
    await waitFor(async () => (await api(`/api/terminal/sessions/${sessionId}`)).session.state === 'aborted', 'abort reaches real backend');
    await delay(2000);
    assert.equal((await api(`/api/terminal/sessions/${sessionId}`)).session.state, 'aborted', 'late model completion must not turn abort into success');

    await click('[data-view="search"]');
    await waitFor(() => frame('vectorFrame', "!!document.getElementById('q')"), 'native search');
    await fill('#q', '知识写入边界', 'vectorFrame'); await frame('vectorFrame', "document.getElementById('search-btn').click()");
    await waitFor(() => frame('vectorFrame', `document.getElementById('results').textContent.includes(${JSON.stringify(commits[0].sha)})`), 'project A search');
    await frame('vectorFrame', "window.__holdRoute='/api/engine/search'; document.getElementById('search-btn').click()");
    await waitFor(() => frame('vectorFrame', 'window.__heldRequests.length === 1'), 'held A response');
    await select(projects[1].projectId);
    await waitFor(() => frame('vectorFrame', `document.getElementById('results').textContent.includes(${JSON.stringify(commits[1].sha)})`), 'B search while A response is late');
    await frame('vectorFrame', 'window.__heldRequests.shift()()'); await delay(200);
    assert.equal(await frame('vectorFrame', `document.getElementById('results').textContent.includes(${JSON.stringify(commits[0].sha)})`), false);
    await frame('vectorFrame', "document.querySelector('#results .res').click()");
    await waitFor(() => frame('vectorFrame', `document.getElementById('dr-body').textContent.includes(${JSON.stringify(commits[1].sha)})`), 'B citation reads real B file');
    await frame('vectorFrame', "document.getElementById('dr-close').click()");
    await frame('vectorFrame', "window.__holdRoute='/api/engine/get'; document.querySelector('#results .res').click()");
    await waitFor(() => frame('vectorFrame', 'window.__heldRequests.length === 1'), 'held B document read');
    await select(projects[0].projectId);
    await waitFor(() => frame('vectorFrame', `document.getElementById('results').textContent.includes(${JSON.stringify(commits[0].sha)})`), 'A results while B document is late');
    await frame('vectorFrame', "document.querySelector('#results .res').click()");
    await waitFor(() => frame('vectorFrame', `document.getElementById('dr-body').textContent.includes(${JSON.stringify(commits[0].sha)})`), 'new A document');
    await frame('vectorFrame', 'window.__heldRequests.shift()()'); await delay(100);
    assert.equal(await frame('vectorFrame', `document.getElementById('dr-body').textContent.includes(${JSON.stringify(commits[1].sha)})`), false, 'late B document cannot overwrite A');
    await frame('vectorFrame', "document.getElementById('dr-close').click()");
    await click('[data-scope="domain"]');
    await waitFor(() => frame('vectorFrame', `document.getElementById('results').textContent.includes(${JSON.stringify(commits[0].sha)}) && document.getElementById('results').textContent.includes(${JSON.stringify(commits[1].sha)})`), 'shared domain includes A and B');

    await click('[data-view="memory"]'); await click('[data-memory-tab="candidate"]');
    await waitFor(() => run("document.querySelectorAll('.memory-card').length === 2"), 'evidenced memory candidates');
    await click('[data-memory-action="evidence"]');
    await waitFor(() => run("document.getElementById('referenceDialog').open && document.getElementById('referenceContent').textContent.includes('维护偏好')"), 'memory evidence reads actual knowledge file');
    await click('[data-close="referenceDialog"]');
    const memoryId = await run("document.querySelector('[data-memory-action=confirm]').dataset.memoryId");
    await click('[data-memory-action="confirm"]'); await fill('#memoryText', '网页验收偏好：先查询知识，再复用成熟消息流。'); await click('#saveMemoryCandidate');
    await waitFor(() => run("!document.getElementById('memoryDialog').open && document.getElementById('memoryContent').textContent.includes('网页验收偏好')"), 'edit persists');
    await click(`[data-memory-action="confirm"][data-memory-id="${memoryId}"]`);
    await run("document.getElementById('memoryScope').value='global';document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}))");
    await click('#confirmMemory');
    await waitFor(() => run("document.querySelectorAll('.memory-card').length === 1"), 'confirmation updates candidate count');
    await click('[data-memory-action="ignore"]'); await waitFor(() => run("!document.querySelector('.memory-card')"), 'ignore persists');
    await click('[data-memory-tab="confirmed"]'); assert.ok(await run("document.getElementById('memoryContent').textContent.includes('网页验收偏好')"));
    const memories = (await api('/api/engine/memories')).memories; assert.equal(memories.filter(m => m.status === 'confirmed').length, 1); assert.equal(memories.filter(m => m.status === 'ignored').length, 1);
    assert.ok((await api('/api/engine/search', { projectId: projects[0].projectId, scope: 'brain', query: '网页验收偏好' })).results.some(r => r.entry_id === 'memories/confirmed.md'));
    await click('[data-memory-action="edit"]');
    const reviewedBeforeCancel = (await api('/api/engine/memories')).memories.find(m => m.id === memoryId);
    await fill('#memoryText', '取消时不得保存的新文字'); await click('#memoryDialog [data-close="memoryDialog"]');
    assert.equal((await api('/api/engine/memories')).memories.find(m => m.id === memoryId).text, reviewedBeforeCancel.text);
    await click('[data-memory-action="edit"]');
    await run(`document.getElementById('memoryScope').value='project';document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('memoryTarget').value=${JSON.stringify(projects[1].projectId)}`);
    await fill('#memoryText', '网页验收偏好：确认后只在项目 B 使用。'); await click('#confirmMemory');
    await waitFor(() => run(`!document.getElementById('memoryDialog').open && document.querySelector('[data-memory-card="${memoryId}"]').textContent.includes('项目 ·')`), 'scope edit and visible target refresh');
    assert.ok(!(await api('/api/engine/search', { projectId: projects[0].projectId, scope: 'brain', query: '网页验收偏好' })).results.some(r => r.memoryId === memoryId));
    assert.ok((await api('/api/engine/search', { projectId: projects[1].projectId, scope: 'project', query: '网页验收偏好' })).results.some(r => r.memoryId === memoryId));
    await run(`document.getElementById('memoryScopeFilter').value='project';document.getElementById('memoryScopeFilter').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('memoryTargetFilter').value=${JSON.stringify(projects[0].projectId)};document.getElementById('memoryTargetFilter').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await run("document.querySelectorAll('.memory-card').length"), 0);
    await run(`document.getElementById('memoryTargetFilter').value=${JSON.stringify(projects[1].projectId)};document.getElementById('memoryTargetFilter').dispatchEvent(new Event('change',{bubbles:true}))`);
    await click('[data-memory-action="edit"]');
    await run(`document.getElementById('memoryScope').value='domain';document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('memoryTarget').value=${JSON.stringify(projects[0].domainId)}`);
    await click('#confirmMemory');
    await run("document.getElementById('memoryScopeFilter').value='';document.getElementById('memoryScopeFilter').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor(() => run(`document.querySelector('[data-memory-card="${memoryId}"]').textContent.includes('领域 ·')`), 'domain target selected and acknowledged');
    for (const p of projects) assert.ok((await api('/api/engine/search', { projectId: p.projectId, scope: 'project', query: '网页验收偏好' })).results.some(r => r.memoryId === memoryId));
    await browser.screenshot(path.join(proof, 'memory-scope-review-1920.png'));
    await click('[data-memory-action="edit"]');
    await run("document.getElementById('memoryScope').value='global';document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}))");
    await click('#confirmMemory');
    await waitFor(() => run("!document.getElementById('memoryDialog').open"), 'scope review settles');

    const beforeManual = (await api('/api/engine/memories')).memories.length;
    await click('#addMemory'); await fill('#memoryText', '取消添加不得写入'); await click('#memoryDialog [data-close="memoryDialog"]');
    assert.equal((await api('/api/engine/memories')).memories.length, beforeManual);
    await click('[data-memory-tab="candidate"]'); await click('#addMemory');
    assert.equal(await run("document.getElementById('memoryScope').value"), 'project', 'manual memory defaults to the current project, not all projects');
    assert.equal(await run("document.getElementById('memoryTarget').value"), projects[0].projectId);
    assert.equal(await run("document.getElementById('memoryEvidenceDetails').hidden && document.getElementById('saveMemoryCandidate').hidden"), true);
    const manualText = '手动项目约定：导出采用42 <img src=x onerror="window.__manualXss=1">';
    await fill('#memoryText', manualText); await click('#confirmMemory');
    await waitFor(() => run("!document.getElementById('memoryDialog').open && document.getElementById('memoryContent').textContent.includes('手动项目约定')"), 'manual creation saves and switches to confirmed tab with a matching filter');
    const manualProject = (await api('/api/engine/memories')).memories.find(m => m.text === manualText);
    assert.equal(manualProject.sourceType, 'manual'); assert.equal(manualProject.status, 'confirmed'); assert.equal(manualProject.evidence, null);
    assert.equal(await run("window.__manualXss || 0"), 0); assert.equal(await run("document.getElementById('memoryContent').querySelector('img') !== null"), false);
    assert.equal(await run(`document.querySelector('[data-memory-card="${manualProject.id}"]').textContent.includes('手动添加')`), true);
    await click('#addMemory'); await fill('#memoryText', manualText); await click('#confirmMemory');
    await waitFor(() => run("!document.getElementById('memoryFeedback').hidden && document.getElementById('memoryFeedback').textContent.includes('相同记忆')"), 'duplicate feedback preserves the draft and dialog');
    assert.equal(await run("document.getElementById('memoryDialog').open"), true);
    assert.equal((await api('/api/engine/memories')).memories.length, beforeManual + 1);
    await click('#memoryDialog [data-close="memoryDialog"]');
    await click(`[data-memory-action="edit"][data-memory-id="${manualProject.id}"]`);
    assert.equal(await run("document.getElementById('memoryEvidenceDetails').hidden"), true);
    await fill('#memoryText', '手动项目约定：导出采用43'); await click('#confirmMemory');
    await waitFor(() => run("!document.getElementById('memoryDialog').open && document.getElementById('memoryContent').textContent.includes('导出采用43')"), 'manual edit updates the card');
    for (const [type, text] of [['domain', '手动领域约定：错误文案使用中文'], ['global', '手动全局约定：不要添加无必要实体']]) {
      await click('#addMemory'); await fill('#memoryText', text);
      await run(`document.getElementById('memoryScope').value=${JSON.stringify(type)};document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}))`);
      if (type === 'domain') await run(`document.getElementById('memoryTarget').value=${JSON.stringify(projects[0].domainId)}`);
      await click('#confirmMemory');
      await waitFor(() => run(`!document.getElementById('memoryDialog').open && document.getElementById('memoryContent').textContent.includes(${JSON.stringify(text)})`), 'manual ' + type + ' feedback');
    }
    const manualMemories = (await api('/api/engine/memories')).memories.filter(m => m.sourceType === 'manual');
    assert.equal(manualMemories.length, 3);
    await waitFor(async () => (await api('/api/engine/memories')).memories.filter(m => m.sourceType === 'manual').every(m => m.syncStatus === 'ready' && m.indexStatus === 'ready'), 'manual memories reach the real derived vector index', 30000);
    for (const p of projects) {
      const context = await api('/api/engine/context', { projectId: p.projectId, query: '开发导出功能', scope: 'brain', client: 'workbench' });
      assert.equal(context.memories.filter(m => m.sourceType === 'manual').length, p.projectId === projects[0].projectId ? 3 : 2);
      assert.ok(context.memories.filter(m => m.sourceType === 'manual').every(m => m.commitSha === null));
    }
    for (const m of manualMemories) {
      const entry = m.scopeType === 'global' ? 'memories/confirmed.md' : `memories/${m.scopeType === 'domain' ? 'domains' : 'projects'}/${m.scopeId}.md`;
      const indexed = await api('/api/engine/search', { projectId: projects[0].projectId, scope: 'brain', query: m.text });
      assert.ok(indexed.results.some(r => r.memoryId === m.id && r.entry_id === entry && r.commitSha === null && r.match_channels.includes('index:vector-hub')), 'manual memory is actually indexed, not merely served by text fallback');
    }
    await run("document.getElementById('memoryScopeFilter').value='';document.getElementById('memoryScopeFilter').dispatchEvent(new Event('change',{bubbles:true}))");
    await browser.screenshot(path.join(proof, 'manual-memories-1920-light.png'));

    await click('[data-view="activity"]'); await click('[data-activity-tab="sessions"]');
    await waitFor(() => frame('bridgeFrame', "document.getElementById('main-title').textContent.includes('测试项目 A')"), 'native event bridge bound to A');
    await waitFor(() => frame('bridgeFrame', "document.getElementById('live-flow').textContent.includes('WORKBENCH_RUNTIME_OK')"), 'native workbench events appear in bridge UI');
    await click('#openSystem'); await click('#openEngine');
    await waitFor(() => frame('engineFrame', `document.getElementById('scopeProject').value === ${JSON.stringify(projects[0].projectId)}`), 'native engine diagnostic scope');
    assert.equal(await frame('engineFrame', "getComputedStyle(document.getElementById('btnShowTrigger')).display"), 'none', 'production must not expose a debug-only run action');
    assert.equal(await frame('engineFrame', "getComputedStyle(document.getElementById('btnShowRegister')).display"), 'none', 'embedded diagnostics cannot own another project registry');
    await click('[data-close="engineDialog"]');
    const frameIds = ['workFrame', 'vectorFrame', 'bridgeFrame', 'engineFrame'];
    const iframeUrls = await run(`Object.fromEntries(${JSON.stringify(frameIds)}.map(id=>[id,document.getElementById(id).src]))`);
    const frameMarkers = await run(`Object.fromEntries(${JSON.stringify(frameIds)}.map(id=>{const win=document.getElementById(id).contentWindow;return[id,win.__identityMarker=crypto.randomUUID()]}))`);
    for (let round = 0; round < 3; round++) {
      for (const view of ['home', 'work', 'search', 'memory', 'projects', 'activity']) {
        await click(`[data-view="${view}"]`); assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false, `overflow ${view}`);
      }
      await select(projects[0].projectId); await select(projects[1].projectId); await select(projects[0].projectId);
    }
    assert.deepEqual(await run(`Object.fromEntries(${JSON.stringify(frameIds)}.map(id=>[id,document.getElementById(id).src]))`), iframeUrls);
    assert.deepEqual(await run(`Object.fromEntries(${JSON.stringify(frameIds)}.map(id=>[id,document.getElementById(id).contentWindow.__identityMarker]))`), frameMarkers);
    assert.equal(await run("window.__webStreams.filter(s=>s.url.endsWith('/api/engine/progress') && s.readyState!==2).length"), 1, 'one shell progress subscription');
    await click('#themeToggle');
    await waitFor(async () => (await Promise.all(frameIds.map(id => frame(id, "document.body.dataset.kbTheme === 'dark'")))).every(Boolean), 'same embedded theme');
    await click('[data-view="search"]');
    await waitFor(() => frame('vectorFrame', "!!document.querySelector('#results .res') && !document.querySelector('#results .skel') && !document.querySelector('#search-btn:disabled')"), 'dark search screenshot includes completed results');
    await browser.screenshot(path.join(proof, 'search-1920-dark.png'));
    await click('#openSystem');
    await waitFor(() => run("document.getElementById('maintenanceModel').value==='acceptance-model'"), 'saved maintenance default loaded');
    await click('#saveMaintenance');
    await waitFor(() => run("document.getElementById('configurationStatus').textContent.includes('已保存并同步')"), 'maintenance default acknowledged by backend');
    assert.equal((await api('/api/terminal/maintenance-default')).profileId, 'acceptance-model');
    await click('#repairWiring');
    await waitFor(() => run("document.getElementById('wiringFeedback').textContent==='四个模块已连接。'"), 'idempotent wiring repair');
    assert.equal((await api('/api/projects/aggregated')).projects.length, 2);
    await fill('#brainName', '网页验收智脑');
    await fill('#knowledgeRoot', environment.knowledgeRoot);
    await click('#saveBrainSettings');
    await waitFor(() => run("document.getElementById('brainLabel').textContent==='网页验收智脑'"), 'brain settings refresh');
    assert.equal((await api('/api/brain')).brain.name, '网页验收智脑');
    assert.ok(fs.existsSync(path.join(projects[0].knowledgePath, `changes/${commits[0].sha.slice(0, 12)}.md`)), 'saving settings does not move knowledge');
    await click('#openEmbedding');
    await waitFor(() => run("document.getElementById('embeddingDialog').open"), 'embedding configuration opened');
    assert.equal(await run("document.getElementById('embeddingSecret').value"), '', 'saved key must not enter the form');
    await click('#embeddingForm button[type="submit"]');
    await waitFor(() => run("document.getElementById('embeddingFeedback').textContent.includes('已保存并同步')"), 'blank credential keeps configured key');
    assert.equal((await api('/api/terminal/embedding-config')).configured, true);
    await click('#disableEmbedding');
    await waitFor(() => run("document.getElementById('embeddingFeedback').textContent.includes('已停用')"), 'embedding disabled honestly');
    assert.equal((await api('/api/terminal/embedding-config')).configured, false);
    await click('#embeddingForm button[type="submit"]');
    await waitFor(() => run("document.getElementById('toast').textContent.includes('向量模型凭据未配置')"), 'disabled independent credential cannot be silently reused');
    assert.equal((await api('/api/terminal/embedding-config')).configured, false);
    await fill('#embeddingSecret', 'controlled-embedding-not-real');
    await click('#embeddingForm button[type="submit"]');
    await waitFor(() => run("document.getElementById('embeddingFeedback').textContent.includes('已保存并同步')"), 'explicit configuration restores embeddings');
    assert.equal((await api('/api/terminal/embedding-config')).configured, true);
    await click('[data-close="embeddingDialog"]');
    await click('#openSystem'); await click('#configureProviders');
    await waitFor(() => frame('workFrame', "document.getElementById('view-settings').classList.contains('active')"), 'shell opens native provider management');
    await frame('workFrame', "document.getElementById('settings-back').click()");
    await click('#openSystem'); await click('#openLogs');
    await waitFor(() => run("document.getElementById('logsStatus').textContent.includes('条诊断记录')"), 'real diagnosis');
    await run("document.getElementById('logsScope').value='project';document.getElementById('logsScope').dispatchEvent(new Event('change',{bubbles:true}))");
    await fill('#logsSearch', commits[0].sha); await click('#loadLogs');
    await waitFor(() => run(`document.getElementById('logsContent').textContent.includes(${JSON.stringify(commits[0].sha)})`), 'project and commit diagnostic filter');
    const exported = await fetch(`${environment.url}/api/logs/export?projectId=${encodeURIComponent(projects[0].projectId)}&q=${commits[0].sha}`);
    assert.equal(exported.status, 200);
    const logLines = (await exported.text()).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(logLines.length && logLines.every(record => record.projectId === projects[0].projectId && record.schema === 'log/v2'));
    await click('#exportLogs');
    await click('[data-close="logsDialog"]'); await waitFor(() => run("window.__webStreams.filter(s=>s.url.includes('/api/logs/stream') && s.readyState!==2).length === 0"), 'diagnostic subscription closes');
    await browser.send('Page.navigate', { url: environment.url + '/#memory' });
    await waitFor(() => run("document.getElementById('memoryContent').textContent.includes('网页验收偏好')"), 'page reopen restores durable memory');
    await waitFor(() => run("document.getElementById('memoryContent').textContent.includes('手动全局约定') && document.getElementById('memoryContent').textContent.includes('导出采用43')"), 'page reopen restores manual memories and immutable manual provenance');
    assert.equal(await run("document.documentElement.dataset.theme"), 'dark');
    assert.equal(await run("document.getElementById('brainLabel').textContent"), '网页验收智脑');
    await click('[data-view="projects"]');
    await select(projects[1].projectId);
    await click('[data-action="unbind"]');
    await waitFor(() => run("document.getElementById('unbindDialog').open"), 'real unbind confirmation dialog');
    await click('[data-close="unbindDialog"]');
    assert.equal((await api('/api/projects/aggregated')).projects.length, 2, 'cancel must not remove a project');
    await waitFor(() => run('window.__registryInFlight === 0'), 'previous project selection read settles before fault injection');
    await run("window.__holdRoute='/api/projects/aggregated'; window.dispatchEvent(new Event('online'));");
    await waitFor(() => run('window.__heldRequests.length > 0'), 'hold a pre-unbind registry response');
    await click('[data-action="unbind"]'); await click('#confirmUnbind');
    await waitFor(async () => (await api('/api/projects/aggregated')).projects.length === 1, 'four-module keep-data unbind');
    assert.ok(fs.existsSync(projects[1].workspacePath));
    assert.ok(fs.existsSync(path.join(projects[1].knowledgePath, `changes/${commits[1].sha.slice(0, 12)}.md`)));
    assert.equal((await api('/api/engine/projects')).projects.length, 1);
    await waitFor(() => run("document.getElementById('projectSelect').options.length === 1 && !document.getElementById('unbindDialog').open"), 'project disappears from UI without reload');
    await run('window.__heldRequests.splice(0).forEach(release=>release());');
    await waitFor(() => run("document.getElementById('projectSelect').options.length === 1"), 'late registry cannot restore an unbound project');
    await browser.screenshot(path.join(proof, 'unbind-1920-dark.png'));
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    fs.mkdirSync(proof, { recursive: true });
    fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), nodeVersion: process.version, installationReport: environment.installationReport, installationSource: environment.installationSource, runtimeRoots: environment.runtimeRoots, viewport: '1920x1080', model: 'controlled substitute', embedding: 'controlled substitute', commits, assertions: ['UI imports and four-module wiring', 'true Git Hook to live UI', 'native streamed message/navigation/abort', 'project drafts/history/citations', 'shell canonical citation and controlled clipboard provenance', 'long commit citation wrapping', 'late search and document response isolation', 'domain scope', 'memory evidence/edit/confirm/ignore and disk retrieval', 'native bridge events and engine diagnostics', 'four stable iframe identities', 'single progress subscription', 'four uniform embedded themes', 'maintenance default save and wiring repair', 'brain name/settings persistence without moving files', 'blank embedding credential preservation, disable revocation and explicit reconfiguration', 'native provider settings entry', 'project/commit diagnostic filtering and JSONL export', 'diagnostic subscription cleanup', 'durable reload', 'four-module keep-data unbind'] }, null, 2));
    console.log(`PRODUCT_WEB_UI_ACCEPTANCE_PASSED ${proof} (real services/Git/Hook/files/index; controlled model/embedding; 1920x1080 only)`);
  } catch (error) {
    if (browser) { console.error(await browser.evaluate("document.body.innerText + '\\nWORKBENCH: ' + (document.getElementById('workFrame').contentDocument?.body?.innerText || '')")); await browser.screenshot(path.join(proof, 'failure.png')); }
    throw error;
  } finally {
    await browser?.close(); child.stdin.write('stop\n');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
    if (child.exitCode === null) { child.kill(); await delay(1000); }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('智脑桌面验收-'));
    // Windows can retain an exited browser/worker's directory handle briefly.
    // The exact owned root was checked above; never widen cleanup on failure.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
