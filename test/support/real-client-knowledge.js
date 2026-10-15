'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const { verifyClientToolEvidence } = require('./client-tool-evidence');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent'));
  const flag = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  const core = flag('--core-root') ? path.resolve(flag('--core-root')) : environment.runtimeRoots.shell;
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const { ProfileStore } = require(path.join(environment.runtimeRoots.workbench, 'packages/server/lib/profile-store'));
  const secrets = [new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model').apiKey].filter(Boolean);
  const auth = flag('--auth') || 'agent-owned';
  assert.ok(['agent-owned', 'profile-injected'].includes(auth));
  const agents = flag('--agent') && flag('--agent') !== 'all' ? [flag('--agent')] : ['claude-code', 'codex', 'opencode', 'zcode'];
  assert.ok(agents.every(id => ['claude-code', 'codex', 'opencode', 'zcode'].includes(id)));
  const api = async (route, body) => {
    const startup = Boolean(body) && /^\/api\/terminal\/sessions(?:\/[^/]+\/input)?$/.test(route);
    const response = await fetch(new URL(route, environment.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(startup ? 100000 : 20000) });
    const result = await response.json(); assert.ok(response.ok, `${route}: ${result.error?.code || (typeof result.error === 'string' ? result.error : response.status)}`); return result;
  };
  const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
  const run = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
  assert.ok(run?.commitSha);
  const discovery = (await api('/api/terminal/agents')).agents;
  const report = { at: new Date().toISOString(), auth, installationSource: environment.installationSource, core, cases: [] };
  const reportFile = path.join(environment.root, `real-client-knowledge-${auth}-${Date.now()}.json`);
  const save = () => AtomicFile.writeJsonAtomic(reportFile, redactValue(report, { secrets }));
  for (const agentId of agents) {
    const item = { agentId, auth, projectId: project.projectId, commitSha: run.commitSha, passed: false };
    report.cases.push(item); save();
    let sessionId;
    try {
      const detected = discovery.find(a => a.id === agentId);
      assert.ok(detected?.available, 'installed executable must pass actual version discovery');
      item.detectedVersion = detected.version || null;
      const created = await api('/api/terminal/sessions', { context: { contextId: project.modules.terminal.projectId, workspaceRef: project.modules.terminal.projectId }, agentId, aiProfileId: auth === 'agent-owned' ? null : 'acceptance-model', ...(flag('--model') ? { model: flag('--model') } : {}), permissionMode: 'bypassPermissions' });
      sessionId = created.session.sessionId; item.sessionId = sessionId;
      const cli = path.join(core, 'bin/project-knowledge-kb.js').replace(/\\/g, '/');
      const command = `node ${JSON.stringify(cli)} search --project ${project.projectId} --query ${run.commitSha} --scope project --json`;
      item.rawPrompt = `这是受控测试项目的只读接入验收。请实际调用终端工具执行以下命令，简要说明返回知识中的变更事实，并引用 entry_id 与完整 commitSha。仅依据实际返回内容，不要求其中包含特定规则。不要改文件、提交、调用其他服务或读取凭据；不可以凭记忆回答。\n${command}`;
      const inputStartedAt = Date.now();
      const accepted = await api(`/api/terminal/sessions/${sessionId}/input`, { text: item.rawPrompt });
      item.inputReceipt = { accepted: accepted.accepted, durationMs: Date.now() - inputStartedAt };
      assert.equal(accepted.accepted, true, 'the actual backend must acknowledge the input'); save();
      const deadline = Date.now() + 240000;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = await api(`/api/terminal/sessions/${sessionId}`);
        const events = snapshot.events;
        const failure = events.find(e => e.type === 'claude/error' || (e.type === 'claude/result' && e.isError));
        if (failure) throw new Error(String(failure.message || failure.result || 'client failed').slice(0, 1200));
        const last = events.at(-1);
        if (snapshot.session.state === 'idle' && events.some(e => e.type === 'claude/result' && e.isError === false) && (last?.type === 'claude/turn-end' || last?.type === 'claude/state' && last.state === 'idle')) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      assert.equal(snapshot.session.state, 'idle', 'client task must actually complete');
      const toolEvents = snapshot.events.filter(e => ['claude/tool-use', 'claude/tool-result'].includes(e.type));
      item.knowledgeToolEvidence = verifyClientToolEvidence(toolEvents, { projectId: project.projectId, commitSha: run.commitSha });
      const answer = snapshot.events.filter(e => e.type === 'claude/result' && e.isError === false).at(-1).result;
      assert.ok(answer.includes(run.commitSha));
      const context = await api(`/api/terminal/sessions/${sessionId}/knowledge`);
      assert.ok(context.references.some(r => r.commitSha === run.commitSha));
      item.answer = answer; item.references = context.references.map(r => ({ projectId: r.projectId, entryId: r.entryId, commitSha: r.commitSha }));
      item.toolEvidence = toolEvents;
      item.transportNotices = snapshot.events.filter(event => event.type === 'claude/stderr').map(event => event.text);
      item.passed = true;
      process.stdout.write(`REAL_CLIENT_KNOWLEDGE_PASSED ${agentId} ${auth}\n`);
    } catch (error) {
      item.failure = String(error.message).slice(0, 1400);
      if (sessionId) await api(`/api/terminal/sessions/${sessionId}/abort`, {}).catch(() => {});
      process.stdout.write(`REAL_CLIENT_KNOWLEDGE_FAILED ${agentId} ${auth}\n`);
    }
    save();
  }
  report.passed = report.cases.every(c => c.passed); save();
  process.stdout.write(`REAL_CLIENT_REPORT ${reportFile}\n`);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error.code || 'CLIENT_ACCEPTANCE_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
