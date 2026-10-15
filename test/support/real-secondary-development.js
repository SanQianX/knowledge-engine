'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { citedEntry, verifySecondaryEvidence } = require('./secondary-evidence');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent'));
  const root = environment.repositories[0];
  assert.equal(path.dirname(root), environment.root);
  const roundAt = process.argv.indexOf('--round');
  const round = roundAt < 0 ? '' : process.argv[roundAt + 1];
  if (roundAt >= 0 && !/^[a-z][a-z0-9-]{0,40}$/.test(round || '')) throw new Error('INVALID_ACCEPTANCE_ROUND');
  const stem = `secondary-policy${round ? `-${round}` : ''}`;
  const resumeAt = process.argv.indexOf('--resume-task');
  const priorFile = resumeAt < 0 ? null : path.resolve(process.argv[resumeAt + 1]);
  if (priorFile) { assert.equal(path.dirname(priorFile), environment.root); assert.match(path.basename(priorFile), /^real-secondary-development-\d+\.json$/); }
  const priorTask = priorFile && JSON.parse(fs.readFileSync(priorFile));
  const repairCitation = process.argv.includes('--repair-citation');
  assert.ok(!repairCitation || priorTask, 'citation correction requires the original failed acceptance receipt');
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
  const initialStatus = git(['status', '--porcelain']);
  const retainedProbes = process.argv.includes('--retain-probes') && initialStatus ? initialStatus.split('\n').map(line => {
    assert.match(line, /^\?\? export(?:-zcode)?-[a-f0-9-]{36}\.cjs$/, 'only prior owned native probes may remain untracked');
    const file = line.slice(3);
    return { file, hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') };
  }) : [];
  let sessionId;
  try {
    if (!priorTask && !retainedProbes.length) assert.equal(initialStatus, '', 'secondary development requires a clean controlled repository');
    const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
    const prior = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded' && (!priorTask || r.commitSha === priorTask.sourceCommit));
    assert.ok(prior?.commitSha);
    proof.sourceCommit = prior.commitSha; proof.projectId = project.projectId;
    const files = [`${stem}.js`, `${stem}.test.js`];
    if (priorTask) {
      assert.equal(priorTask.projectId, project.projectId); assert.equal(priorTask.installedCore, environment.runtimeRoots.shell); assert.ok(!priorTask.commitSha && priorTask.sessionId);
      assert.ok(files.every(file => fs.existsSync(path.join(root, file))), 'resume validates existing files without overwriting them');
      sessionId = priorTask.sessionId; proof.priorFailedAcceptance = priorFile;
    } else {
      assert.ok(files.every(file => !fs.existsSync(path.join(root, file))), 'do not overwrite an earlier acceptance result');
      const created = await api('/api/terminal/sessions', { context: { contextId: project.modules.terminal.projectId, workspaceRef: project.modules.terminal.projectId }, agentId: 'claude-code', aiProfileId: 'acceptance-model', permissionMode: 'bypassPermissions' });
      sessionId = created.session.sessionId;
    }
    proof.sessionId = sessionId;
    const cli = path.join(environment.runtimeRoots.shell, 'bin/project-knowledge-kb.js').replace(/\\/g, '/');
    proof.rawPrompt = `在当前受控测试仓库完成一次真实二次开发。先实际调用终端工具执行 node ${JSON.stringify(cli)} search --project ${project.projectId} --query ${prior.commitSha} --scope project --json，完整保留 CLI 输出，不要用管道裁剪检索证据。最新提交不一定包含所需规则；请再实际检索 single-writer / engine promotion，并 get 读取包含单写者原文的真实条目，不能凭此提示猜测或引用无关条目。基于实际读取的单写者约束，仅新增 ${files[0]} 和 ${files[1]}：CommonJS 导出 isKnowledgeWriter(owner)，只有 owner 为 engine-promotion 时返回 true，其他值返回 false；源文件注释引用实际知识 entry_id 和该事实的完整 commitSha。测试使用 Node 内置 assert，检查真/假两种情况，运行 node ${files[1]} 并输出 SECONDARY_POLICY_OK。不要修改其他文件、安装依赖、读取凭据或自行提交。最终回答引用实际检索依据和测试结果。`;
    if (priorTask) {
      const existing = await api(`/api/terminal/sessions/${sessionId}`);
      proof.rawPrompt = existing.events.findLast(event => event.type === 'claude/user-prompt' && event.text?.includes(prior.commitSha) && files.every(file => event.text.includes(file)))?.text;
      assert.ok(proof.rawPrompt?.includes(prior.commitSha) && files.every(file => proof.rawPrompt.includes(file)));
      if (repairCitation) {
        proof.beforeCorrection = files.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
        proof.rawPrompt = `核验并修正上一轮二次开发的知识引用。${prior.commitSha} 对应的新增草稿记录没有单写者事实，不能把它当作该规则的依据。先实际执行 node ${JSON.stringify(cli)} search --project ${project.projectId} --query ${prior.commitSha} --scope project --json，再用同一知识 CLI 检索 single-writer / engine promotion 规则，get 读取真实条目并核对原文及完整提交 SHA。完整保留这些 CLI 的 JSON 输出，不能通过管道裁剪，因为需要验证后端及知识原文的证据。仅允许修改 ${files[0]} 和 ${files[1]}：保留既有 isKnowledgeWriter 实现，以实际读取的包含单写者规则的知识 entry_id 和 commitSha 修正源文件注释；如果引用已经正确，也请再次保存源文件并在注释补充“引用已经通过实际知识检索核对”。不得伪造规则或借用无关条目的 SHA。运行 node ${files[1]} 输出 SECONDARY_POLICY_OK，最终回答引用实际依据和测试结果。不得修改其他文件、安装依赖、读取凭据或自行提交。`;
        save(); await api(`/api/terminal/sessions/${sessionId}/input`, { text: proof.rawPrompt });
      }
    } else { save(); await api(`/api/terminal/sessions/${sessionId}/input`, { text: proof.rawPrompt }); }
    const taskDeadline = Date.now() + 240000;
    let snapshot;
    while (Date.now() < taskDeadline) {
      snapshot = await api(`/api/terminal/sessions/${sessionId}`);
      if (repairCitation || priorTask?.beforeCorrection) {
        const turnAt = snapshot.events.findLastIndex(event => event.type === 'claude/user-prompt' && event.text === proof.rawPrompt);
        assert.ok(turnAt >= 0, 'correction must be a real Agent turn, not manual file edits');
        snapshot = { ...snapshot, events: snapshot.events.slice(turnAt) };
      }
      const error = snapshot.events.find(e => e.type === 'claude/error' || e.type === 'claude/result' && e.isError);
      assert.ok(!error, error?.message || error?.result);
      if (snapshot.session.state === 'idle' && snapshot.events.at(-1)?.type === 'claude/turn-end') break;
      if (priorTask && !repairCitation && snapshot.session.state === 'aborted') {
        const states = snapshot.events.filter(event => event.type === 'claude/state');
        assert.equal(states.at(-1)?.reason, 'no-active-subprocess'); assert.equal(states.at(-2)?.state, 'idle');
        proof.sessionTeardown = 'original harness aborted an already completed turn'; break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    assert.ok(snapshot.session.state === 'idle' || priorTask && snapshot.session.state === 'aborted');
    const tools = snapshot.events.filter(e => ['claude/tool-use', 'claude/tool-result'].includes(e.type));
    // verifySecondaryEvidence below checks matching successful tool IDs and
    // actual Write/Edit ordering. A valid exact-commit fact need not have
    // a vector hit; independent vector gates remain mandatory.
    assert.deepEqual(git(['status', '--porcelain']).split('\n').map(line => line.slice(3)).sort(), [...files, ...retainedProbes.map(p => p.file)].sort());
    for (const probe of retainedProbes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, probe.file))).digest('hex'), probe.hash, 'prior failed probes must remain byte-identical');
    proof.retainedPriorProbes = retainedProbes;
    const policy = require(path.join(root, files[0]));
    assert.equal(policy.isKnowledgeWriter('engine-promotion'), true); assert.equal(policy.isKnowledgeWriter('shell'), false); assert.equal(policy.isKnowledgeWriter(null), false);
    const source = fs.readFileSync(path.join(root, files[0]), 'utf8');
    const entry = await api('/api/engine/get', { projectId: project.projectId, entryId: citedEntry(source).entryId });
    const knowledgeEvidence = verifySecondaryEvidence({ events: snapshot.events, source, projectId: project.projectId, latestCommit: prior.commitSha, file: files[0], entry });
    const tested = execFileSync(process.execPath, [files[1]], { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.ok(tested.includes('SECONDARY_POLICY_OK'));
    proof.stages.push({ stage: 'Agent retrieval before edits and actual test', passed: true, sourceCommit: prior.commitSha, knowledgeEvidence, files: files.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })), toolEvidence: tools }); save();
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
