'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  const proofFile = path.join(environment.root, `real-memory-preference-${Date.now()}.json`);
  const proof = { installationReport: environment.installationReport, passed: false, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(proofFile, proof);
  const api = async (route, body) => { const response = await fetch(new URL(route, environment.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100000) }); assert.ok(response.ok, route); return response.json(); };
  const repo = environment.repositories[0];
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(git(['status', '--porcelain']), '');
  const filename = 'explicit-owner-preferences.txt'; assert.equal(fs.existsSync(path.join(repo, filename)), false);
  const project = (await api('/api/projects/aggregated')).projects.find(item => item.projectId === 'project-real-a');
  const { session } = await api('/api/terminal/sessions', { context: { contextId: project.modules.terminal.projectId, workspaceRef: project.modules.terminal.projectId }, agentId: 'claude-code', aiProfileId: 'acceptance-model', permissionMode: 'bypassPermissions' });
  proof.sessionId = session.sessionId; save();
  const preferences = '这是受控测试项目的所有者明确提出的两条长期偏好（不是从代码风格推断）：一、软件只保留主要功能，避免无必要实体；二、项目知识文档默认用简体中文。今后的任务可以参考这两条偏好，但必须在知识维护提出候选后由我手动确认，未确认时不能注入长期记忆。';
  const destination = path.join(repo, filename);
  const prompt = `这是代码仓库中的文件新增任务，不是让你保存 Claude 原生自动记忆。唯一允许新增的文件是绝对路径 ${JSON.stringify(destination)}。必须把文件写在该代码仓库中，不要写入 .claude/projects/*/memory 或其他目录。\n文件内容必须原样为：\n${preferences}\n请实际使用文件工具写入该绝对路径，再回读核对。不得修改其他文件、读取凭据或自行提交。写入并核对完成后回答 MEMORY_PREFERENCE_OK。`;
  await api(`/api/terminal/sessions/${session.sessionId}/input`, { text: prompt });
  let snapshot;
  const deadline = Date.now() + 240000;
  do { snapshot = await api(`/api/terminal/sessions/${session.sessionId}`); assert.ok(!snapshot.events.some(event => event.type === 'claude/error' || event.type === 'claude/result' && event.isError)); if (snapshot.session.state === 'idle' && snapshot.events.at(-1)?.type === 'claude/turn-end') break; await new Promise(resolve => setTimeout(resolve, 1500)); } while (Date.now() < deadline);
  assert.equal(snapshot.session.state, 'idle');
  assert.ok(fs.readFileSync(path.join(repo, filename), 'utf8').includes(preferences));
  assert.equal(git(['status', '--porcelain']), `?? ${filename}`);
  assert.ok(snapshot.events.some(event => event.type === 'claude/result' && !event.isError && event.result.includes('MEMORY_PREFERENCE_OK')));
  while ((await api('/api/terminal/health')).conversationCapture.pending) await new Promise(resolve => setTimeout(resolve, 200));
  git(['add', '--', filename]); git(['commit', '-qm', 'acceptance: explicitly evidence owner long-term preferences']);
  proof.commitSha = git(['rev-parse', 'HEAD']); save();
  const maintenanceDeadline = Date.now() + 15 * 60 * 1000;
  let run;
  do { run = (await api('/api/engine/runs')).runs.find(item => item.commitSha === proof.commitSha && item.projectId === project.projectId); assert.ok(!['failed', 'index-pending'].includes(run?.state), run?.error?.code); if (run?.state === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 1500)); } while (Date.now() < maintenanceDeadline);
  assert.equal(run?.state, 'succeeded');
  const candidates = (await api('/api/engine/memories')).memories.filter(memory => memory.evidence?.commitSha === proof.commitSha);
  assert.ok(candidates.length, 'real analyzer must produce an evidenced durable preference candidate');
  assert.ok(candidates.every(memory => memory.status === 'candidate'));
  const conversation = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', project.projectId, 'commit-conversations', `${proof.commitSha}.json`)));
  assert.ok(conversation.turns.some(turn => turn.sessionId === session.sessionId && turn.userEvents.some(event => event.content === prompt)));
  for (const candidate of candidates) {
    const source = fs.readFileSync(path.join(project.knowledgePath, candidate.evidence.entryId), 'utf8');
    assert.ok(source.includes(candidate.evidence.quote));
  }
  Object.assign(proof, { passed: true, runId: run.runId, promotedAt: run.promotedAt, candidates, frozenSnapshotHash: conversation.snapshotHash, finishedAt: new Date().toISOString() }); save();
  console.log(`REAL_MEMORY_PREFERENCE_PASSED ${proofFile}`);
}
main().catch(error => { console.error(`${error.code || 'REAL_MEMORY_FAILED'}: ${error.message}`); process.exitCode = 1; });
