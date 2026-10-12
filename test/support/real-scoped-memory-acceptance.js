'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  assert.ok(process.env.KB_PRODUCT_INSTALLATION_REPORT, 'this acceptance must use a verified npm installation');
  const installation = JSON.parse(fs.readFileSync(process.env.KB_PRODUCT_INSTALLATION_REPORT));
  assert.equal(installation.integrityPassed, true);
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '智脑桌面验收-memory-real-'));
  const proofDir = path.resolve(__dirname, '../../.agent-state/acceptance/scoped-memories', `run-${Date.now()}`);
  const reportFile = path.join(proofDir, 'report.json');
  const report = { passed: false, version: installation.version, nodeVersion: process.version, installationReport: process.env.KB_PRODUCT_INSTALLATION_REPORT, root, viewport: '1920x1080', model: 'real MiniMax Agent and embeddings', cases: [], startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(reportFile, report);
  const passed = (name, evidence = {}) => { report.cases.push({ name, passed: true, ...evidence }); save(); console.log('SCOPED_MEMORY_CASE ' + name); };
  let child, browser, environment;
  const environmentFile = path.join(root, 'acceptance-environment.json');
  const childEnv = { ...process.env, KB_PRODUCT_TEST_ROOT: root, KB_PRODUCT_TEST_PORT: '0', KB_ACCEPTANCE_REAL_PROFILE_ID: process.env.KB_ACCEPTANCE_REAL_PROFILE_ID || 'minimax', KB_REAL_PROFILE_DATA_DIR: process.env.KB_REAL_PROFILE_DATA_DIR || path.join(os.homedir(), '.project-knowledge-v5/workbench'), KB_ACCEPTANCE_REAL_EMBEDDING: '1', KB_ACCEPTANCE_USER_AGENT_CONFIG: '1' };
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, 'product-preview.js')], { env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    await waitFor(() => {
      if (child.exitCode !== null) throw Object.assign(new Error('Installed fixture exited ' + child.exitCode), { fatal: true });
      if (!fs.existsSync(environmentFile)) return false;
      const current = JSON.parse(fs.readFileSync(environmentFile));
      if (current.pid !== child.pid) return false;
      environment = current; return true;
    }, 'installed real services', 45000);
    assert.ok(environment.model.startsWith('real Agent and real embeddings'));
    assert.ok(Object.values(environment.runtimeRoots).every(directory => directory.startsWith(installation.installedRoot + path.sep)));
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.stdin.write('stop\n');
    await waitFor(() => child.exitCode !== null, 'graceful fixture stop', 45000);
    assert.equal(child.exitCode, 0);
  }
  const api = async (route, body, method) => {
    const response = await fetch(new URL(route, environment.url), { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100000) });
    const payload = await response.json(); assert.ok(response.ok, route + ': ' + (payload.error?.code || response.status)); return payload;
  };
  const helper = async (name, args = []) => {
    const proc = spawn(process.execPath, [path.join(__dirname, name), ...args], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [proc.stdout, proc.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-4000); });
    const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', resolve); });
    assert.equal(code, 0, name + ': ' + output); return output;
  };
  const list = async () => (await api('/api/engine/memories')).memories;
  const paidIndexes = () => {
    const directory = path.join(environment.knowledgeRoot, '.indexes');
    const result = {};
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name, 'index.json');
      if (!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file)).items?.length) continue;
      result[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    return result;
  };
  try {
    save(); await start();
    const domains = [];
    for (const name of ['记忆验收领域 A', '记忆验收领域 B']) domains.push((await api('/api/domains', { name })).domain);
    const projects = [];
    for (const [index, repo] of environment.repositories.entries()) {
      const result = await api('/api/projects/import', { projectId: index ? 'project-real-b' : 'project-real-a', localPath: repo, knowledgePath: path.join(environment.knowledgeRoot, index ? '真实项目 B' : '真实项目 A'), displayName: index ? '真实项目 B' : '真实项目 A', domainId: domains[index].id });
      assert.ok(Object.values(result.modules).every(module => module.ok));
    }
    projects.push(...(await api('/api/projects/aggregated')).projects.sort((a, b) => a.projectId.localeCompare(b.projectId)));
    assert.equal((await api('/api/engine/runs')).runs.length, 0);
    passed('npm-only services and fresh import without history replay', { runtimeRoots: environment.runtimeRoots, domains, projects: projects.map(p => ({ projectId: p.projectId, repo: p.workspacePath, knowledgePath: p.knowledgePath, domainId: p.domainId })) });
    await helper('real-memory-preference.js', [environmentFile]);
    const receiptName = fs.readdirSync(root).find(name => /^real-memory-preference-.*\.json$/.test(name));
    const receipt = JSON.parse(fs.readFileSync(path.join(root, receiptName))); assert.equal(receipt.passed, true);
    report.extractionReceipt = path.join(root, receiptName);
    const candidate = (await list()).find(m => m.evidence.commitSha === receipt.commitSha && m.status === 'candidate');
    assert.ok(candidate); const sourceEvidence = candidate.evidence, originalText = candidate.originalText;
    const marker = 'memoryscope' + crypto.randomBytes(6).toString('hex');
    const text = `${marker}：只保留主要功能，项目知识默认使用简体中文。`;
    const search = (project, scope = 'project') => api('/api/engine/search', { projectId: project.projectId, query: marker, scope, limit: 30 });
    for (const p of projects) assert.ok(!(await search(p, 'brain')).results.some(r => r.memoryId === candidate.id));
    passed('real task, Hook, analysis and evidenced candidate; unconfirmed memory excluded', { memoryId: candidate.id, sourceEvidence, originalText });
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(root, 'browser'), url: environment.url, width: 1920, height: 1080 }); await browser.setViewport(1920, 1080);
    const page = expression => browser.evaluate(expression);
    const click = selector => page(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(() => page('!!document.getElementById("memoryScopeFilter")'), 'memory page');
    await click('[data-view="memory"]'); await click('[data-memory-tab="candidate"]');
    const card = `[data-memory-card="${candidate.id}"]`;
    await waitFor(() => page(`!!document.querySelector(${JSON.stringify(card)})`), 'real candidate in live UI');
    await click(card + ' [data-memory-action="confirm"]');
    await page(`document.getElementById('memoryText').value=${JSON.stringify(text)}`);
    await click('[data-close="memoryDialog"]');
    assert.equal((await list()).find(m => m.id === candidate.id).text, candidate.text);
    passed('cancel preserves original candidate');
    async function review(type, id, suffix) {
      const action = await page(`!!document.querySelector(${JSON.stringify(card + ' [data-memory-action="edit"]')})`) ? 'edit' : 'confirm';
      await click(card + ` [data-memory-action="${action}"]`);
      await waitFor(() => page('document.getElementById("memoryDialog").open'), 'review form');
      await page(`document.getElementById('memoryText').value=${JSON.stringify(text)};document.getElementById('memoryScope').value=${JSON.stringify(type)};document.getElementById('memoryScope').dispatchEvent(new Event('change',{bubbles:true}));${type === 'global' ? '' : `document.getElementById('memoryTarget').value=${JSON.stringify(id)};`}`);
      assert.equal(await page('document.getElementById("memoryOriginal").textContent'), originalText);
      assert.equal(await page('document.getElementById("memoryQuote").textContent'), sourceEvidence.quote);
      await page('document.querySelector(".memory-evidence").open=true');
      await browser.screenshot(path.join(proofDir, `${suffix}-review-1920.png`));
      await click('#confirmMemory');
      await waitFor(() => page('!document.getElementById("memoryDialog").open'), 'atomic review acknowledgment');
      const saved = (await list()).find(m => m.id === candidate.id);
      assert.equal(saved.status, 'confirmed'); assert.equal(saved.scopeType, type); assert.equal(saved.scopeId, id);
      assert.equal(saved.text, text); assert.deepEqual(saved.evidence, sourceEvidence); assert.equal(saved.originalText, originalText);
      return saved;
    }
    async function indexed(memory) {
      const { listMarkdownFiles } = require(path.join(environment.runtimeRoots.engine, 'src/runtime/markdown-knowledge-indexer'));
      await waitFor(async () => {
        const snapshot = await api('/api/engine/snapshot');
        const brain = snapshot.sharedScopes.find(s => s.kind === 'brain');
        const digest = crypto.createHash('sha256');
        for (const file of listMarkdownFiles(brain.knowledgePath).sort()) digest.update(path.relative(brain.knowledgePath, file)).update('\0').update(fs.readFileSync(file));
        return brain.index?.status === 'ready' && brain.index.fingerprint === digest.digest('hex') && snapshot.memories.find(m => m.id === memory.id)?.indexStatus === 'ready';
      }, 'real scoped memory embedding and live snapshot', 180000);
      const brain = (await api('/api/engine/snapshot')).sharedScopes.find(s => s.kind === 'brain');
      const entryId = memory.scopeType === 'global' ? 'memories/confirmed.md' : `memories/${memory.scopeType === 'domain' ? 'domains' : 'projects'}/${memory.scopeId}.md`;
      const file = path.join(brain.knowledgePath, entryId); assert.ok(fs.readFileSync(file, 'utf8').includes(text));
      const vectorFile = path.join(environment.knowledgeRoot, '.indexes', `scope-brain-${brain.id}`, 'index.json');
      const index = JSON.parse(fs.readFileSync(vectorFile)); assert.ok(index.items.length && index.items.every(item => item.vector.length === 1536 && item.vector.every(Number.isFinite)));
      return { entryId, file, vectorFile, chunks: index.items.length, dimension: 1536 };
    }
    let memory = await review('project', projects[1].projectId, 'project');
    await click('[data-memory-tab="confirmed"]');
    const projectIndex = await indexed(memory);
    assert.ok(!(await search(projects[0], 'brain')).results.some(r => r.memoryId === memory.id));
    const included = (await search(projects[1])).results.filter(r => r.memoryId === memory.id);
    assert.ok(included.length && included.every(r => r.commitSha === sourceEvidence.commitSha && r.match_channels.includes('index:vector-hub')));
    passed('edited project B memory excludes its source project A, real vector citation retained', projectIndex);
    memory = await review('domain', domains[0].id, 'domain'); const domainIndex = await indexed(memory);
    assert.ok((await search(projects[0])).results.some(r => r.memoryId === memory.id));
    assert.ok(!(await search(projects[1], 'brain')).results.some(r => r.memoryId === memory.id));
    await api('/api/projects/' + projects[1].projectId, { domainId: domains[0].id }, 'PATCH');
    assert.ok((await search(projects[1])).results.some(r => r.memoryId === memory.id));
    assert.ok(!fs.readFileSync(projectIndex.file, 'utf8').includes(text));
    passed('domain excludes other domains, current project membership changes applicability', domainIndex);
    const brainId = (await api('/api/brain')).brain.id;
    memory = await review('global', brainId, 'global'); const globalIndex = await indexed(memory);
    for (const p of projects) assert.ok((await search(p)).results.some(r => r.memoryId === memory.id));
    assert.ok(!fs.readFileSync(domainIndex.file, 'utf8').includes(text));
    passed('global applies to both projects, obsolete scoped projections cleared', globalIndex);
    const core = environment.runtimeRoots.shell;
    const runtimeEnv = { ...process.env, KB_DATA_DIR: path.join(root, 'shell'), KB_KNOWLEDGE_ENGINE_URL: '', NODE_PATH: '' };
    const cli = async () => {
      const proc = spawn(process.execPath, [path.join(core, 'bin/project-knowledge-kb.js'), 'search', '--project', projects[1].projectId, '--scope', 'project', '--query', marker, '--json'], { env: runtimeEnv, windowsHide: true });
      let output = ''; proc.stdout.on('data', bytes => output += bytes); proc.stderr.resume();
      assert.equal(await new Promise((resolve, reject) => { proc.once('exit', resolve); proc.once('error', reject); }), 0); return JSON.parse(output);
    };
    const normalize = result => result.results.filter(r => r.memoryId === memory.id).map(r => ({ entry: r.entry_id, scope: r.memoryScopeType, target: r.memoryScopeId, commit: r.commitSha, hash: r.content_hash }));
    const load = createRequire(path.join(core, 'package.json'));
    const { Client } = load('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = load('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'scoped-memory-acceptance', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(core, 'bin/project-knowledge-mcp.js')], env: runtimeEnv, stderr: 'pipe' }));
      const mcp = await client.callTool({ name: 'project_knowledge_search', arguments: { projectId: projects[1].projectId, scope: 'project', query: marker } }); assert.ok(!mcp.isError);
      const expected = normalize(await search(projects[1])); assert.ok(expected.length);
      assert.deepEqual(normalize(await cli()), expected); assert.deepEqual(normalize(JSON.parse(mcp.content[0].text)), expected);
      passed('UI API CLI and MCP return identical scoped memory facts and commit citations', { references: expected });
    } finally { await client.close(); }
    const { session } = await api('/api/terminal/sessions', { context: { contextId: projects[1].modules.terminal.projectId, workspaceRef: projects[1].modules.terminal.projectId }, agentId: 'claude-code', aiProfileId: 'acceptance-model', permissionMode: 'bypassPermissions' });
    await api(`/api/terminal/sessions/${session.sessionId}/input`, { text: `${marker} 只保留主要功能：请先参考本次任务的知识上下文，说明其中的长期偏好和来源完整 commit，不修改文件、不提交。回答 SCOPED_MEMORY_CONTEXT_OK。` });
    const finished = await waitFor(async () => {
      const result = await api(`/api/terminal/sessions/${session.sessionId}`);
      assert.ok(!result.events.some(event => event.type === 'claude/error' || event.type === 'claude/result' && event.isError));
      return result.session.state === 'idle' && result.events.at(-1)?.type === 'claude/turn-end' ? result : false;
    }, 'real workbench answer using the reviewed memory', 240000);
    const context = await api(`/api/terminal/sessions/${session.sessionId}/knowledge`);
    assert.ok(context.references.some(r => r.entryId === globalIndex.entryId && r.commitSha === sourceEvidence.commitSha && r.text.includes(marker)));
    assert.ok(finished.events.filter(e => e.type === 'claude/text-delta').length > 1);
    passed('actual streamed Agent receives only relevant confirmed memory with original source SHA', { sessionId: session.sessionId, knowledgeReferences: context.references.map(r => ({ entry: r.entryId, commit: r.commitSha })), deltas: finished.events.filter(e => e.type === 'claude/text-delta').length });
    await helper('real-agent-acceptance.js', [environmentFile, '--round', 'scoped-memory']);
    passed('real single commit and overlapping two-project analysis remain usable', { receipt: path.join(root, 'real-agent-scoped-memory-acceptance.json') });
    await waitFor(async () => !(await api('/api/terminal/health')).conversationCapture.pending, 'capture durable before restart');
    await browser.screenshot(path.join(proofDir, 'confirmed-memory-1920.png')); assert.equal(browser.exceptions.length, 0);
    await browser.close(); browser = null;
    const before = { memory: (await list()).find(m => m.id === memory.id), runs: (await api('/api/engine/runs')).runs.map(r => ({ id: r.runId, state: r.state, promoted: r.promotedAt, analysis: r.analysisRunId, attempts: r.indexAttempts })), indexes: paidIndexes(), events: (await api(`/api/terminal/sessions/${session.sessionId}`)).events };
    await stop(); await start();
    await waitFor(async () => (await list()).find(m => m.id === memory.id)?.syncStatus === 'ready' && (await api('/api/brain')).configuration.indexStorage.status === 'ready', 'restart memory and index projection', 180000);
    const restored = (await list()).find(m => m.id === memory.id);
    for (const key of ['text', 'status', 'scopeType', 'scopeId', 'evidence', 'originalText', 'createdAt', 'updatedAt']) assert.deepEqual(restored[key], before.memory[key]);
    assert.deepEqual((await api('/api/engine/runs')).runs.map(r => ({ id: r.runId, state: r.state, promoted: r.promotedAt, analysis: r.analysisRunId, attempts: r.indexAttempts })), before.runs);
    assert.deepEqual(paidIndexes(), before.indexes); assert.deepEqual((await api(`/api/terminal/sessions/${session.sessionId}`)).events, before.events);
    assert.ok(normalize(await cli()).length);
    passed('restart preserves scoped review, evidence, completed maintenance, paid vectors and streamed history', { runs: before.runs.length, realIndexes: Object.keys(before.indexes).length });
    report.passed = true; report.finishedAt = new Date().toISOString(); save();
    console.log('REAL_SCOPED_MEMORY_ACCEPTANCE_PASSED ' + reportFile);
  } catch (error) { report.failure = { code: error.code || 'ACCEPTANCE_FAILED', message: String(error.message).slice(0, 1500) }; save(); throw error; }
  finally { await browser?.close(); await stop(); }
}
main().catch(error => { console.error(`${error.code || 'REAL_SCOPED_MEMORY_FAILED'}: ${error.message}`); process.exitCode = 1; });
