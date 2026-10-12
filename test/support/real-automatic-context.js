'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(environment.model.startsWith('real Agent and real embeddings'));
  const core = environment.runtimeRoots.shell;
  const { ProfileStore } = require(path.join(environment.runtimeRoots.workbench, 'packages/server/lib/profile-store'));
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const profile = new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model');
  const api = async (route, body, method) => { const response = await fetch(new URL(route, environment.url), { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); const data = await response.json(); assert.ok(response.ok && data.ok !== false, `${route}: ${data.error?.code || data.error || response.status}`); return data; };
  const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
  const knownMemories = (await api('/api/engine/memories')).memories;
  const ownedConfirmed = knownMemories.find(m => m.status === 'confirmed' && m.evidence.projectId === project.projectId && m.text.includes('AUTOCTX-'));
  const candidate = ownedConfirmed || knownMemories.find(m => m.status === 'candidate' && m.evidence.projectId === project.projectId);
  assert.ok(candidate, 'evidenced candidate from real maintenance required');
  const editMemory = process.argv.includes('--edit-memory');
  if (!editMemory) for (const previous of knownMemories.filter(m => m.id !== candidate.id && m.status === 'confirmed' && m.text.includes('AUTOCTX-'))) await api(`/api/engine/memories/${previous.id}`, { status: 'ignored' }, 'PATCH');
  const priorMarker = ownedConfirmed?.text.match(/AUTOCTX-[a-f0-9]{24}/)?.[0];
  const marker = !editMemory && priorMarker || `AUTOCTX-${crypto.randomBytes(12).toString('hex')}`;
  const output = path.join(environment.root, `real-automatic-context-${Date.now()}.json`);
  const report = { passed: false, version: require(path.join(core, 'package.json')).version, installationSource: environment.installationSource, marker, priorMarker, editedPreference: editMemory, projectId: project.projectId, cases: [], startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report, { secrets: [profile.apiKey] })); save();
  const edited = await api(`/api/engine/memories/${candidate.id}`, { text: `本项目所有 JSON 导出对象都包含 memoryLabel 字段，其值固定为 ${marker}；错误文案使用简体中文。`, scopeType: 'project', scopeId: project.projectId, status: 'confirmed' }, 'PATCH');
  assert.equal(edited.memory.status, 'confirmed');
  const doctor = await api('/api/terminal/system/doctor'), cli = doctor.agents['claude-code'].resolvedExecutable;
  const pluginDirectory = path.join(core, 'plugins/project-knowledge');
  const userConfiguration = process.argv.includes('--user-config');
  assert.ok(fs.existsSync(path.join(pluginDirectory, 'hooks/claude.json')));
  const sessionId = crypto.randomUUID(), config = path.join(environment.root, `automatic-cli-${sessionId}`);
  fs.mkdirSync(config, { recursive: true });
  const settingsFile = path.join(config, 'settings.json');
  const { IntegrationManager } = require(path.join(core, '_site/lib/integration-installer'));
  await new IntegrationManager({ rootDir: core, homeDir: config, env: {}, claudeSettingsFile: settingsFile, bridgeHomeDir: path.join(environment.root, 'events') }).installCaptureClaude();
  const filename = path.join(project.workspacePath, `export-${sessionId}.cjs`);
  // Retain prior failed probes as evidence outside the code tree; otherwise
  // the model can copy an earlier probe's deliberately different contract.
  const priorDirectory = path.join(config, 'prior-probe-files');
  for (const entry of (editMemory ? [] : fs.readdirSync(project.workspacePath).filter(name => /^export-[a-f0-9-]{36}\.cjs$/.test(name)))) {
    const source = path.resolve(project.workspacePath, entry), target = path.resolve(priorDirectory, entry);
    assert.ok(source.startsWith(path.resolve(environment.root) + path.sep) && target.startsWith(path.resolve(environment.root) + path.sep));
    if (execFileSync('git', ['ls-files', '--', entry], { cwd: project.workspacePath, encoding: 'utf8', windowsHide: true }).trim()) continue;
    assert.ok(fs.lstatSync(source).isFile()); fs.mkdirSync(priorDirectory, { recursive: true }); fs.renameSync(source, target);
  }
  const prompt = `需求已确定，无需追问。请在当前项目实现一个 CommonJS 模块，只新增绝对路径 ${JSON.stringify(filename)}。模块导出函数 exportRecords(records)，参数为数组时返回 JSON 字符串，其中 records 字段为传入数组；参数不是数组时抛出 Error。遵循当前项目已有的接口约定。不要提交，不要修改其它文件。完成后简短说明。`;
  assert.ok(!/knowledge|知识库|MCP|检索|memoryLabel|AUTOCTX/i.test(prompt.replace(JSON.stringify(filename), '[destination]')));
  const debug = path.join(config, 'native-debug.log');
  // Observe delivery on the first real model request; a debug marker may also
  // appear later in generated code and is not sufficient delivery evidence.
  const modelRequests = [];
  const proxy = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', chunk => { if (body.length + chunk.length > 16 * 1024 * 1024) { req.destroy(); return; } body = Buffer.concat([body, chunk]); });
    req.on('end', () => {
      if (req.method === 'POST' && /\/v1\/messages(?:\?|$)/.test(req.url)) {
        let parsed = {}; try { parsed = JSON.parse(body); } catch {}
        const texts = []; const walk = value => { if (typeof value === 'string') texts.push(value); else if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') Object.values(value).forEach(walk); }; walk(parsed.messages);
        const system = typeof parsed.system === 'string' ? parsed.system : (parsed.system || []).map(p => p.text || '').join('\n');
        const isTitleRequest = !parsed.tools?.length && system.includes('Generate a concise, sentence-case title (3-7 words)');
        modelRequests.push({ number: modelRequests.length + 1, isTitleRequest, containsOwnMemory: [...texts, system].some(text => text.includes(marker) && text.includes(candidate.id) && text.includes('<knowledge_context>')), containsMemory: texts.some(text => text.includes(marker)) || JSON.stringify(parsed.system || '').includes(marker), containsTask: texts.some(text => text.includes(prompt)), model: parsed.model, maxTokens: parsed.max_tokens, toolCount: parsed.tools?.length || 0, roleSequence: parsed.messages?.map(m => m.role), systemPrefix: system.slice(0, 350), textPrefixes: texts.slice(0, 3).map(text => text.slice(0, 60)), bodyHash: crypto.createHash('sha256').update(body).digest('hex'), receivedAt: new Date().toISOString() });
      }
      const target = new URL(profile.baseUrl.replace(/\/$/, '') + req.url);
      const headers = { ...req.headers, host: target.host }; delete headers.connection;
      const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); res.on('close', () => upstream.destroy()); upstream.end(body);
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const args = [...(userConfiguration ? [] : ['--plugin-dir', pluginDirectory]), '--settings', settingsFile, '--print', prompt, '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--debug-file', debug, '--model', profile.models.default];
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, KB_DATA_DIR: path.join(environment.root, 'shell'), AI_CODING_EVENT_BRIDGE_HOME: path.join(environment.root, 'events'), ANTHROPIC_AUTH_TOKEN: profile.apiKey, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, NODE_PATH: '' };
  delete env.CLAUDECODE; delete env.KB_KNOWLEDGE_CONTEXT;
  if (userConfiguration) { if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR; else delete env.CLAUDE_CONFIG_DIR; }
  const child = spawn(/\.[cm]?js$/i.test(cli) ? process.execPath : cli, /\.[cm]?js$/i.test(cli) ? [cli, ...args] : args, { cwd: project.workspacePath, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout = (stdout + b).slice(-8 * 1024 * 1024); }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-12000); });
  const timer = setTimeout(() => child.kill(), 240000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    report.native = { code, sessionId, cliVersion: doctor.agents['claude-code'].versionProbe.version, prompt, events, stderr, modelRequests, configuration: userConfiguration ? 'existing user plugin configuration, no plugin-directory override, not Workbench' : 'isolated native control; npm/source plugin loaded explicitly, not Workbench' }; save();
    assert.equal(code, 0); assert.ok(events.some(e => e.type === 'result' && !e.is_error));
    const firstDevelopment = modelRequests.find(request => request.containsTask && !request.isTitleRequest);
    assert.equal(firstDevelopment?.containsMemory, true, 'confirmed memory must arrive on the first development model request; only the explicitly identified native title generator is auxiliary');
    assert.equal(firstDevelopment.containsOwnMemory, true, 'the product memory ID and envelope must be present, not just an old marker in unrelated client history');
    assert.ok(modelRequests.slice(0, modelRequests.indexOf(firstDevelopment)).every(request => request.isTitleRequest), 'never silently discard an unknown earlier model request');
    assert.ok(fs.existsSync(filename), 'native client must actually implement the plain task');
    const text = fs.readFileSync(filename, 'utf8'), module = { exports: {} };
    vm.runInNewContext(text, { module, exports: module.exports }, { timeout: 1000 });
    assert.equal(typeof module.exports.exportRecords, 'function');
    const result = JSON.parse(module.exports.exportRecords([{ id: 1 }])); assert.equal(result.memoryLabel, marker); assert.deepEqual(JSON.parse(JSON.stringify(result.records)), [{ id: 1 }]);
    assert.throws(() => module.exports.exportRecords('invalid'), error => /[\u4e00-\u9fff]/.test(error.message), 'confirmed Chinese-error preference must affect actual behavior');
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const logs = (await api('/api/logs?pageSize=500&event=knowledge.context.prepared')).entries.filter(e => e.projectId === project.projectId && e.context?.sessionHash === sessionHash);
    assert.equal(logs.length, 1, 'one native pre-prompt context request, no duplicate retrieval'); assert.ok(logs[0].context.memoryCount > 0 && logs[0].context.factCount > 0); assert.equal(logs[0].context.status, 'ready');
    const trace = fs.existsSync(debug) ? fs.readFileSync(debug, 'utf8') : '';
    report.cases.push({ name: 'plain external request automatically retrieves real indexed facts and confirmed memory', passed: true, operationId: logs[0].operationId, references: logs[0].context.references, file: filename, fileHash: crypto.createHash('sha256').update(text).digest('hex'), actualMemoryEffect: result.memoryLabel, debugContainsMarker: trace.includes(marker), hookEvents: events.filter(e => e.type === 'system' && /hook/.test(e.subtype || '')) });
    const projectB = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-b');
    const contextB = await api('/api/engine/context', { repoPath: projectB.workspacePath, query: '实现 JSON 导出' });
    assert.ok(!JSON.stringify(contextB).includes(marker));
    report.cases.push({ name: 'project-exclusive edited preference does not enter another project', passed: true, projectId: projectB.projectId });
    if (process.argv.includes('--commit')) {
      const git = args => execFileSync('git', args, { cwd: project.workspacePath, encoding: 'utf8', windowsHide: true }).trim();
      git(['add', '--', path.basename(filename)]); git(['commit', '-qm', 'acceptance: implement using automatic knowledge context']);
      const commitSha = git(['rev-parse', 'HEAD']), deadline = Date.now() + 15 * 60 * 1000;
      let run;
      while (Date.now() < deadline) { run = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.commitSha === commitSha); assert.ok(!['failed', 'index-pending'].includes(run?.state), run?.error?.code); if (run?.state === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 1500)); }
      assert.equal(run?.state, 'succeeded'); assert.equal(run.indexState, 'succeeded');
      const followingQuery = `为 ${path.basename(filename)} 中的 exportRecords 维护参数校验与返回字段`;
      const next = await api('/api/engine/context', { repoPath: project.workspacePath, query: followingQuery });
      report.maintenance = { commitSha, runId: run.runId, state: run.state, indexState: run.indexState, followingQuery, references: next.facts.map(r => ({ entryId: r.entryId, commitSha: r.commitSha })) }; save();
      assert.ok(next.facts.some(ref => ref.commitSha === commitSha), 'a following development query must retrieve the actual new commit');
      const conversation = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', project.projectId, 'commit-conversations', commitSha + '.json')));
      assert.ok(conversation.turns.some(turn => turn.sessionId === sessionId && turn.userEvents.some(event => event.content === prompt)));
      assert.ok(!conversation.turns.flatMap(turn => turn.userEvents).some(event => event.content.includes(marker)), 'injected memory must not become a forged user instruction');
      report.cases.push({ name: 'native development commit automatically promotes, indexes and becomes next-task context with original capture', passed: true, commitSha, runId: run.runId, followingQuery, references: next.facts.map(r => ({ entryId: r.entryId, commitSha: r.commitSha })) });
    }
    report.passed = true; report.finishedAt = new Date().toISOString(); save(); console.log('REAL_AUTOMATIC_CONTEXT_PASSED ' + output);
  } catch (error) { report.failure = String(error.message).slice(0, 1600); save(); throw error; }
  finally { clearTimeout(timer); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); if (fs.existsSync(debug)) AtomicFile.writeFileAtomic(debug, redactValue(fs.readFileSync(debug, 'utf8'), { secrets: [profile.apiKey] })); }
}
main().catch(error => { console.error(error.code || 'REAL_AUTOMATIC_CONTEXT_FAILED', error.message); process.exitCode = 1; });
