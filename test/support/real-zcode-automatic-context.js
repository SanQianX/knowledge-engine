'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir())); assert.ok(environment.model.startsWith('real Agent and real embeddings'));
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const core = option('--integration-root') || environment.runtimeRoots.shell, workbench = environment.runtimeRoots.workbench;
  const { ProfileStore } = require(path.join(workbench, 'packages/server/lib/profile-store'));
  const profile = new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model');
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const { IntegrationManager } = require(path.join(core, '_site/lib/integration-installer'));
  const { createAppServerBridge } = require(path.join(workbench, 'packages/server/lib/bridges/app-server-bridge'));
  const { runtimeModelForProfile, providerRuntimeEnvironment } = require(path.join(workbench, 'packages/server/lib/drivers/zcode-driver'));
  const { createZCodeProfileRuntime } = require(path.join(workbench, 'packages/server/lib/drivers/zcode-profile-runtime'));
  const api = async (route, body, method) => { const r = await fetch(new URL(route, environment.url), { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); const d = await r.json(); assert.ok(r.ok && d.ok !== false, route + ': ' + (d.error?.code || r.status)); return d; };
  const projects = (await api('/api/projects/aggregated')).projects;
  const project = projects.find(p => p.projectId === 'project-real-a');
  const memory = (await api('/api/engine/memories')).memories.find(m => m.status === 'confirmed' && m.evidence.projectId === project.projectId && m.text.includes('AUTOCTX-'));
  let marker = memory?.text.match(/AUTOCTX-[a-f0-9]{24}/)?.[0]; assert.ok(marker);
  const priorMarker = marker;
  if (process.argv.includes('--edit-memory')) {
    marker = 'AUTOCTX-' + crypto.randomBytes(12).toString('hex');
    const edited = await api('/api/engine/memories/' + memory.id, { text: `本项目所有 JSON 导出对象都包含 memoryLabel 字段，其值固定为 ${marker}；错误文案使用简体中文。`, scopeType: 'project', scopeId: project.projectId, status: 'confirmed' }, 'PATCH');
    assert.equal(edited.memory.status, 'confirmed');
  }
  const cli = (await api('/api/terminal/system/doctor')).agents.zcode.cli.path;
  const root = fs.mkdtempSync(path.join(environment.root, 'native-zcode-'));
  const userConfiguration = process.argv.includes('--user-config'), homeDir = userConfiguration ? os.homedir() : root;
  const configFile = path.join(homeDir, '.zcode/cli/config.json');
  const manager = new IntegrationManager({ rootDir: core, homeDir, zcodeConfigFile: configFile, bridgeHomeDir: path.join(environment.root, 'events') });
  const configFingerprint = value => {
    const config = JSON.parse(JSON.stringify(value));
    if (Array.isArray(config.hooks?.events?.UserPromptSubmit)) config.hooks.events.UserPromptSubmit = config.hooks.events.UserPromptSubmit.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !(h.type === 'process' && h.command === 'node' && h.args?.[1] === '--client' && h.args?.[2] === 'zcode' && /\/node_modules\/(?:@sanqianx\/)?project-knowledge\/plugins\/project-knowledge\/scripts\/context-hook\.cjs$/i.test(String(h.args?.[0]).replace(/\\/g, '/')))) })).filter(g => g.hooks.length);
    if (!config.hooks?.events?.UserPromptSubmit?.length && config.hooks?.events) delete config.hooks.events.UserPromptSubmit;
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
  };
  let backup, preservedConfigHash;
  if (userConfiguration) {
    assert.ok(fs.existsSync(configFile), 'existing native user configuration required');
    backup = path.resolve(__dirname, '../../../.project-knowledge-backups', 'pre-zcode-native-' + Date.now());
    execFileSync(process.execPath, [path.join(__dirname, 'backup-client-configs.js'), backup], { windowsHide: true, stdio: 'pipe' });
    preservedConfigHash = configFingerprint(JSON.parse(fs.readFileSync(configFile)));
    manager.installZCode();
    assert.equal(configFingerprint(JSON.parse(fs.readFileSync(configFile))), preservedConfigHash, 'model, env, third-party hooks and capture remain unchanged');
  } else { await manager.installCaptureZCode(); manager.installZCode(); }
  const output = path.join(root, 'result.json'), requests = [], events = [];
  const report = { passed: false, installationSource: environment.installationSource, runtimeVersion: JSON.parse(fs.readFileSync(path.join(environment.runtimeRoots.shell, 'package.json'))).version, adapterVersion: JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version, adapterRoot: core, nativeVersion: '0.16.9', marker, priorMarker, editedPreference: process.argv.includes('--edit-memory'), configuration: userConfiguration ? 'existing user configuration; native model selection overridden only for this task' : 'isolated control', backup, preservedConfigHash, projectId: project.projectId, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report, { secrets: [profile.apiKey] })); save();
  const filename = path.join(project.workspacePath, 'export-zcode-' + crypto.randomUUID() + '.cjs');
  const prompt = `需求已确定，无需追问。请在当前项目实现 CommonJS 模块，只新增文件 ${JSON.stringify(filename)}。导出 exportRecords(records)，参数为数组时返回 JSON 字符串，其中 records 字段为传入数组；非数组时抛出 Error。遵循已有接口约定，不要提交或修改其它文件，完成后简短说明。`;
  assert.ok(!/knowledge|知识库|MCP|检索|memoryLabel|AUTOCTX/i.test(prompt.replace(JSON.stringify(filename), '[destination]'))); report.prompt = prompt; report.file = filename;
  const proxy = http.createServer((req, res) => {
    let body = Buffer.alloc(0); req.on('data', b => { if (body.length + b.length > 16 * 1024 * 1024) req.destroy(); else body = Buffer.concat([body, b]); });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const text = JSON.stringify({ messages: parsed.messages, system: parsed.system, input: parsed.input, instructions: parsed.instructions });
      requests.push({ number: requests.length + 1, model: parsed.model, containsOwnMemory: text.includes('<knowledge_context>') && text.includes(marker) && text.includes(memory.id), containsKnowledge: text.includes('<knowledge_context>') && text.includes(project.projectId), toolCount: parsed.tools?.length || 0, bodyHash: crypto.createHash('sha256').update(body).digest('hex') });
      const target = new URL(profile.baseUrl.replace(/\/$/, '') + req.url), headers = { ...req.headers, host: target.host }; delete headers.connection;
      const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); res.on('close', () => upstream.destroy()); upstream.end(body);
    });
  });
  let provider, bridge, sessionId;
  const started = Date.now();
  try {
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const baseSpec = runtimeModelForProfile(profile), spec = { ...baseSpec, provider: { ...baseSpec.provider, baseURL: `http://127.0.0.1:${proxy.address().port}` } };
  provider = await createZCodeProfileRuntime(spec);
  bridge = createAppServerBridge({ command: process.execPath, args: [cli, 'app-server', '--stdio'], env: { ...providerRuntimeEnvironment(cli), ...(!userConfiguration ? { USERPROFILE: root } : {}), KB_DATA_DIR: path.join(environment.root, 'shell'), AI_CODING_EVENT_BRIDGE_HOME: path.join(environment.root, 'events'), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: provider.file }, cwd: project.workspacePath, maxRestarts: 0, idleTimeoutMs: 0, requestTimeoutMs: 60000,
    onEvent: event => { if (event.method === 'session/event') events.push(event.params); },
    onServerRequest: (method, params) => {
      if (method === 'session/requestRuntimePreferences') return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' };
      if (method === 'interaction/requestPermission') {
        const input = JSON.stringify(params.input || {}), allowed = input.includes(filename) && !/\.project-knowledge|provider-config/.test(input);
        const choice = (params.options || []).find(o => o.kind === (allowed ? 'allow_once' : 'deny')); assert.ok(choice, 'native permission must offer an explicit choice'); return choice.response;
      }
      throw new Error('Unsupported native interaction: ' + method);
    }
  });
    await bridge.start(); const capabilities = await bridge.request('runtime/capabilities', {}); assert.equal(capabilities.independentPlanState, true);
    const created = await bridge.request('session/create', { workspace: { workspacePath: project.workspacePath, workspaceKey: project.workspacePath }, mode: 'edit', titleGenerationEnabled: false });
    sessionId = created.session.sessionId; report.sessionId = sessionId;
    await bridge.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    const accepted = await bridge.request('session/send', { sessionId, content: prompt, modelSelection: provider.selection }); assert.equal(accepted.accepted, true);
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && !events.some(e => ['turn.completed', 'turn.failed'].includes(e.type))) await new Promise(resolve => setTimeout(resolve, 500));
    Object.assign(report, { requests, events, durationMs: Date.now() - started }); save();
    const result = events.find(e => ['turn.completed', 'turn.failed'].includes(e.type)); assert.equal(result?.type, 'turn.completed'); assert.equal(result.payload.resultType, 'success');
    assert.equal(requests[0]?.containsOwnMemory, true, 'first native development model request must receive indexed facts and product memory without a search reminder');
    assert.equal(requests[0].containsKnowledge, true);
    const text = fs.readFileSync(filename, 'utf8'), module = { exports: {} }; vm.runInNewContext(text, { module, exports: module.exports }, { timeout: 1000 });
    const value = JSON.parse(module.exports.exportRecords([{ id: 2 }])); assert.equal(value.memoryLabel, marker); assert.deepEqual(value.records, [{ id: 2 }]); assert.throws(() => module.exports.exportRecords('bad'), error => /[\u4e00-\u9fff]/.test(error.message));
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const logs = (await api('/api/logs?pageSize=500&event=knowledge.context.prepared')).entries.filter(e => e.context?.sessionHash === sessionHash && e.projectId === project.projectId);
    assert.equal(logs.length, 1); assert.ok(logs[0].context.factCount > 0 && logs[0].context.memoryCount > 0); assert.equal(logs[0].context.client, 'zcode'); assert.equal(logs[0].context.status, 'ready', 'real indexed context, not a hidden file fallback');
    report.operationId = logs[0].operationId; report.actualMemoryEffect = value.memoryLabel;
    if (process.argv.includes('--commit')) {
      const git = args => execFileSync('git', args, { cwd: project.workspacePath, windowsHide: true, encoding: 'utf8' }).trim(); git(['add', '--', path.basename(filename)]); git(['commit', '-qm', 'acceptance: native ZCode uses automatic project context']); const commitSha = git(['rev-parse', 'HEAD']);
      let run; const end = Date.now() + 900000;
      while (Date.now() < end) { run = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.commitSha === commitSha); assert.ok(!['failed', 'index-pending'].includes(run?.state), run?.error?.code); if (run?.state === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 1500)); }
      assert.equal(run?.state, 'succeeded'); assert.equal(run.indexState, 'succeeded');
      const followingQuery = `维护 ${path.basename(filename)} 的 exportRecords 导出和参数校验`;
      const next = await api('/api/engine/context', { repoPath: project.workspacePath, query: followingQuery });
      report.maintenance = { commitSha, runId: run.runId, state: run.state, indexState: run.indexState, followingQuery, references: next.references.map(r => ({ projectId: r.projectId, entryId: r.entryId, commitSha: r.commitSha, memoryId: r.memoryId })) }; save();
      assert.ok(next.facts.some(f => f.commitSha === commitSha));
      const frozen = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', project.projectId, 'commit-conversations', commitSha + '.json')));
      assert.ok(frozen.turns.some(t => t.sessionId === sessionId && t.userEvents.some(e => e.content === prompt)));
      assert.ok(!frozen.turns.flatMap(t => t.userEvents).some(e => e.content.includes('<knowledge_context>')));
    }
    report.passed = true; report.finishedAt = new Date().toISOString(); save(); console.log('REAL_ZCODE_AUTOMATIC_CONTEXT_PASSED ' + output);
  } catch (error) { report.failure = error.message; Object.assign(report, { requests, events }); save(); throw error; }
  finally { if (sessionId && bridge) { await bridge.request('session/stop', { sessionId }).catch(() => {}); } await bridge?.close(); await provider?.close(); proxy.closeAllConnections(); if (proxy.listening) await new Promise(resolve => proxy.close(resolve)); }
}
main().catch(error => { console.error(error.code || 'REAL_ZCODE_CONTEXT_FAILED', error.message); process.exitCode = 1; });
