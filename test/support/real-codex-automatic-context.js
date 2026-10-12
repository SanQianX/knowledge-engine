'use strict';
// Read-only native Codex acceptance using the existing user's reviewed hooks.
// No Workbench driver, injected knowledgeContext, trust edits or bypass flags.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(environment.model.startsWith('real Agent and real embeddings'));
  const core = environment.runtimeRoots.shell, workbench = environment.runtimeRoots.workbench;
  const { IntegrationManager } = require(path.join(core, '_site/lib/integration-installer'));
  const { ProfileStore } = require(path.join(workbench, 'packages/server/lib/profile-store'));
  const { createAppServerBridge } = require(path.join(workbench, 'packages/server/lib/bridges/app-server-bridge'));
  const { resolveCliInvocation } = require(path.join(workbench, 'packages/server/lib/drivers/cli-json-runner'));
  const { resolveOpenAIBaseUrl, resolveOpenAIModel } = require(path.join(workbench, 'packages/contracts'));
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const profile = new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model');
  const api = async route => { const r = await fetch(new URL(route, environment.url), { signal: AbortSignal.timeout(20000) }); const d = await r.json(); assert.ok(r.ok && d.ok !== false, route); return d; };
  const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
  const memory = (await api('/api/engine/memories')).memories.find(m => m.status === 'confirmed' && m.evidence.projectId === project.projectId && m.text.includes('AUTOCTX-'));
  const marker = memory?.text.match(/AUTOCTX-[a-f0-9]{24}/)?.[0]; assert.ok(marker);
  const manager = new IntegrationManager({ rootDir: core });
  manager.verifyCodexInstallation();
  const git = args => execFileSync('git', args, { cwd: project.workspacePath, windowsHide: true, encoding: 'utf8' }).trim();
  const before = git(['status', '--porcelain=v1']);
  const prompt = '请说明当前项目的 exportRecords 接口在新开发中应返回哪些 JSON 字段，以及参数非法时应如何反馈。只读分析，不修改或提交文件，不读取配置或凭据，简短回答。';
  assert.ok(!/knowledge|知识库|MCP|检索|memoryLabel|AUTOCTX/i.test(prompt));
  const output = path.join(environment.root, 'real-codex-automatic-context-' + Date.now() + '.json');
  const report = { passed: false, installationSource: environment.installationSource, version: JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version, projectId: project.projectId, marker, prompt, at: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report, { secrets: [profile.apiKey] })); save();
  const requests = [], events = [];
  const proxy = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', b => { if (body.length + b.length > 16 * 1024 * 1024) req.destroy(); else body = Buffer.concat([body, b]); });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const text = JSON.stringify({ input: parsed.input, instructions: parsed.instructions, messages: parsed.messages, system: parsed.system });
      if (req.method === 'POST') requests.push({ number: requests.length + 1, model: parsed.model, containsTask: text.includes(prompt), containsOwnMemory: text.includes('<knowledge_context>') && text.includes(marker) && text.includes(memory.id), bodyHash: crypto.createHash('sha256').update(body).digest('hex') });
      const target = new URL(resolveOpenAIBaseUrl(profile).replace(/\/$/, '') + req.url), headers = { ...req.headers, host: target.host }; delete headers.connection;
      const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); res.on('close', () => upstream.destroy()); upstream.end(body);
    });
  });
  let bridge, threadId, turnId;
  try {
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const providerId = 'acceptance_minimax', keyEnv = 'KB_ACCEPTANCE_PROVIDER_API_KEY';
    const config = { model_provider: providerId, [`model_providers.${providerId}.name`]: 'Acceptance MiniMax', [`model_providers.${providerId}.base_url`]: `http://127.0.0.1:${proxy.address().port}`, [`model_providers.${providerId}.env_key`]: keyEnv, [`model_providers.${providerId}.wire_api`]: 'responses', [`model_providers.${providerId}.requires_openai_auth`]: false, [`model_providers.${providerId}.supports_websockets`]: false };
    const args = ['app-server']; for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value));
    const env = { ...process.env, [keyEnv]: profile.apiKey, KB_DATA_DIR: path.join(environment.root, 'shell'), AI_CODING_EVENT_BRIDGE_HOME: path.join(environment.root, 'events') };
    delete env.KB_KNOWLEDGE_CONTEXT;
    bridge = createAppServerBridge({ command: manager.executable('codex'), args, env, cwd: project.workspacePath, resolveInvocation: resolveCliInvocation, maxRestarts: 0, idleTimeoutMs: 0, requestTimeoutMs: 60000,
      onEvent: event => events.push(event),
      onServerRequest: method => { if (/requestApproval$/i.test(method)) return { decision: 'decline' }; if (/^(applyPatchApproval|execCommandApproval)$/.test(method)) return { decision: 'denied' }; throw new Error('Unsupported native interaction: ' + method); }
    });
    await bridge.start(); await bridge.request('initialize', { clientInfo: { name: 'native-knowledge-acceptance', version: '1' }, capabilities: { experimentalApi: true } }); await bridge.notify('initialized');
    const hookSnapshot = await bridge.request('hooks/list', { cwds: [project.workspacePath] });
    const hooks = (hookSnapshot.data || []).flatMap(e => e.hooks || []).filter(h => h.pluginId === 'project-knowledge@project-knowledge' && h.eventName === 'userPromptSubmit');
    report.hooks = hooks.map(h => ({ command: h.command, sourcePath: h.sourcePath, currentHash: h.currentHash, enabled: h.enabled, trustStatus: h.trustStatus })); save();
    assert.equal(hooks.length, 1); assert.equal(hooks[0].enabled, true); assert.equal(hooks[0].trustStatus, 'trusted', 'review the exact native hook in /hooks before running this acceptance');
    const created = await bridge.request('thread/start', { cwd: project.workspacePath, model: resolveOpenAIModel(profile), sandbox: 'read-only', approvalPolicy: 'on-request' }); threadId = created.thread.id; report.threadId = threadId;
    const mcpDeadline = Date.now() + 60000;
    let knowledgeMcp;
    while (Date.now() < mcpDeadline) {
      const status = await bridge.request('mcpServerStatus/list', { threadId });
      knowledgeMcp = status.data?.find(server => server.name === 'project-knowledge');
      if (knowledgeMcp?.tools?.project_knowledge_resolve) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    report.knowledgeMcp = knowledgeMcp; save();
    assert.equal(knowledgeMcp?.serverInfo?.version, report.version, 'the actual native plugin MCP must initialize the matching npm package');
    assert.ok(knowledgeMcp.tools.project_knowledge_resolve && knowledgeMcp.tools.project_knowledge_search, 'a trusted hook alone does not prove MCP availability');
    const started = await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], model: resolveOpenAIModel(profile) }); turnId = started.turn.id;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && !events.some(e => e.method === 'turn/completed' && e.params?.turn?.id === turnId)) await new Promise(resolve => setTimeout(resolve, 500));
    Object.assign(report, { requests, events }); save();
    const finished = events.find(e => e.method === 'turn/completed' && e.params?.turn?.id === turnId); assert.equal(finished?.params.turn.status, 'completed');
    assert.equal(requests[0]?.containsTask, true, 'do not silently skip an unknown earlier model request');
    assert.equal(requests[0]?.containsOwnMemory, true, 'native first development model request receives current confirmed product memory without a reminder');
    const answer = events.filter(e => e.method === 'item/completed' && e.params?.item?.type === 'agentMessage').map(e => e.params.item.text).join('\n');
    assert.ok(answer.includes(marker), 'ordinary interface analysis must use the current confirmed convention, not an older historical value');
    assert.equal(git(['status', '--porcelain=v1']), before, 'read-only native task preserves all fixture files');
    const hash = crypto.createHash('sha256').update(threadId).digest('hex');
    const logs = (await api('/api/logs?pageSize=500&event=knowledge.context.prepared')).entries.filter(e => e.context?.sessionHash === hash && e.projectId === project.projectId);
    assert.equal(logs.length, 1); assert.equal(logs[0].context.client, 'codex'); assert.equal(logs[0].context.status, 'ready'); assert.ok(logs[0].context.factCount > 0 && logs[0].context.memoryCount > 0);
    report.operationId = logs[0].operationId; report.references = logs[0].context.references; report.answer = answer; report.passed = true; save(); console.log('REAL_CODEX_AUTOMATIC_CONTEXT_PASSED ' + output);
  } catch (error) { report.failure = error.message; Object.assign(report, { requests, events }); save(); throw error; }
  finally { if (threadId && turnId && bridge) await bridge.request('turn/interrupt', { threadId, turnId }).catch(() => {}); await bridge?.close(); proxy.closeAllConnections(); if (proxy.listening) await new Promise(resolve => proxy.close(resolve)); }
}
main().catch(error => { console.error('REAL_CODEX_CONTEXT_FAILED', error.message); process.exitCode = 1; });
