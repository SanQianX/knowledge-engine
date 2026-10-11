'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent'));
  const root = environment.repositories[0];
  assert.equal(path.dirname(root), environment.root);
  const proofFile = path.join(environment.root, `real-secondary-development-${Date.now()}.json`);
  const { redactValue } = require(path.join(environment.runtimeRoots.shell, '_site/lib/structured-logger'));
  const { ProfileStore } = require(path.join(environment.runtimeRoots.workbench, 'packages/server/lib/profile-store'));
  const secrets = [new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model').apiKey].filter(Boolean);
  const proof = { at: new Date().toISOString(), installedCore: environment.runtimeRoots.shell, passed: false, stages: [] };
  const save = () => AtomicFile.writeJsonAtomic(proofFile, redactValue(proof, { secrets }));
  const api = async (route, body) => {
    const response = await fetch(new URL(route, environment.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, route); return response.json();
  };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  let sessionId;
  try {
    assert.equal(git(['status', '--porcelain']), '', 'secondary development requires a clean controlled repository');
    const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
    const prior = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
    assert.ok(prior?.commitSha);
    proof.sourceCommit = prior.commitSha; proof.projectId = project.projectId;
    const files = ['secondary-policy.js', 'secondary-policy.test.js'];
    assert.ok(files.every(file => !fs.existsSync(path.join(root, file))), 'do not overwrite an earlier acceptance result');
    const created = await api('/api/terminal/sessions', { context: { contextId: project.modules.terminal.projectId, workspaceRef: project.modules.terminal.projectId }, agentId: 'claude-code', aiProfileId: 'acceptance-model', permissionMode: 'bypassPermissions' });
    sessionId = created.session.sessionId; proof.sessionId = sessionId;
    const cli = path.join(environment.runtimeRoots.shell, 'bin/project-knowledge-kb.js').replace(/\\/g, '/');
    proof.rawPrompt = `在当前受控测试仓库完成一次真实二次开发。先实际调用终端工具执行 node ${JSON.stringify(cli)} search --project ${project.projectId} --query ${prior.commitSha} --scope project --json，读取生成的知识，不能仅凭此提示猜测知识。基于检索到的单写者约束，仅新增 secondary-policy.js 和 secondary-policy.test.js：CommonJS 导出 isKnowledgeWriter(owner)，只有 owner 为 engine-promotion 时返回 true，其他值返回 false；源文件注释引用实际知识 entry_id 和完整 commitSha。测试使用 Node 内置 assert，检查真/假两种情况，运行 node secondary-policy.test.js 并输出 SECONDARY_POLICY_OK。不要修改其他文件、安装依赖、读取凭据或自行提交。最终回答引用实际检索依据和测试结果。`;
    save(); await api(`/api/terminal/sessions/${sessionId}/input`, { text: proof.rawPrompt });
    const taskDeadline = Date.now() + 240000;
    let snapshot;
    while (Date.now() < taskDeadline) {
      snapshot = await api(`/api/terminal/sessions/${sessionId}`);
      const error = snapshot.events.find(e => e.type === 'claude/error' || e.type === 'claude/result' && e.isError);
      assert.ok(!error, error?.message || error?.result);
      if (snapshot.session.state === 'idle' && snapshot.events.at(-1)?.type === 'claude/turn-end') break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    assert.equal(snapshot.session.state, 'idle');
    const tools = snapshot.events.filter(e => ['claude/tool-use', 'claude/tool-result'].includes(e.type));
    const readAt = tools.findIndex(e => e.type === 'claude/tool-use' && JSON.stringify(e).includes('project-knowledge-kb.js'));
    const evidenceAt = tools.findIndex(e => e.type === 'claude/tool-result' && JSON.stringify(e).includes('hybrid+markdown-truth') && JSON.stringify(e).includes(prior.commitSha));
    const writeAt = tools.findIndex(e => e.type === 'claude/tool-use' && JSON.stringify(e).includes('secondary-policy.js') && !JSON.stringify(e).includes('project-knowledge-kb.js'));
    assert.ok(readAt >= 0 && evidenceAt > readAt && writeAt > evidenceAt, 'actual retrieval must precede code changes');
    assert.deepEqual(git(['status', '--porcelain']).split('\n').map(line => line.slice(3)).sort(), files.slice().sort());
    const policy = require(path.join(root, files[0]));
    assert.equal(policy.isKnowledgeWriter('engine-promotion'), true); assert.equal(policy.isKnowledgeWriter('shell'), false); assert.equal(policy.isKnowledgeWriter(null), false);
    const source = fs.readFileSync(path.join(root, files[0]), 'utf8');
    assert.ok(source.includes(prior.commitSha) && /changes\/|modules\//.test(source));
    const tested = execFileSync(process.execPath, [files[1]], { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.ok(tested.includes('SECONDARY_POLICY_OK'));
    proof.stages.push({ stage: 'Agent retrieval before edits and actual test', passed: true, sourceCommit: prior.commitSha, files: files.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })), toolEvidence: tools }); save();
    const captureDeadline = Date.now() + 10000;
    while ((await api('/api/terminal/health')).conversationCapture.pending && Date.now() < captureDeadline) await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await api('/api/terminal/health')).conversationCapture.pending, 0);
    git(['add', '--', ...files]); git(['commit', '-qm', 'acceptance: develop from retrieved knowledge']);
    proof.commitSha = git(['rev-parse', 'HEAD']); save();
    const maintenanceDeadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < maintenanceDeadline) {
      const run = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.commitSha === proof.commitSha);
      assert.ok(!run || !['failed', 'index-pending'].includes(run.state), run?.error?.code);
      if (run?.state === 'succeeded') {
        assert.ok(run.promotedAt && run.indexState === 'succeeded');
        const found = await api('/api/engine/search', { projectId: project.projectId, query: proof.commitSha });
        assert.equal(found.health.index, 'ok'); assert.ok(found.results.some(r => r.commitSha === proof.commitSha));
        const conversation = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', project.projectId, 'commit-conversations', `${proof.commitSha}.json`)));
        const turn = conversation.turns.find(t => t.sessionId === sessionId && t.userEvents.some(e => e.content === proof.rawPrompt));
        assert.ok(turn?.assistantEvents.some(e => e.content.includes('SECONDARY_POLICY_OK')), 'actual prompt and final reply must enter commit evidence');
        proof.stages.push({ stage: 'Git Hook → frozen conversation → promotion → real index → retrieval', passed: true, runId: run.runId, promotedAt: run.promotedAt, files: run.staging.operations.map(op => op.path), citations: found.results.map(r => ({ entryId: r.entry_id, commitSha: r.commitSha })), frozenSnapshotHash: conversation.snapshotHash });
        proof.passed = true; proof.finishedAt = new Date().toISOString(); save();
        process.stdout.write(`REAL_SECONDARY_DEVELOPMENT_PASSED ${proofFile}\n`); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('secondary commit maintenance timed out');
  } catch (error) {
    proof.failure = String(error.message).slice(0, 1200); save();
    if (sessionId) await api(`/api/terminal/sessions/${sessionId}/abort`, {}).catch(() => {});
    throw error;
  }
}
main().catch(error => { process.stderr.write(`${error.code || 'SECONDARY_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
