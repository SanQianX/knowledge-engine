'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent'));
  const report = JSON.parse(fs.readFileSync(path.join(environment.root, 'real-agent-full-runtime-acceptance.json')));
  assert.ok(report.concurrency?.passed && report.commits.every(c => c.state === 'succeeded'));
  const read = async route => { const response = await fetch(new URL(route, environment.url)); assert.ok(response.ok, route); return response; };
  const projects = (await (await read('/api/projects/aggregated')).json()).projects;
  const expectedPrompt = '本轮用于真实端到端验收。仅依据发送前检索到的知识，用三句话说明知识写入单写者规则与项目目录隔离，并引用知识文件和完整 commit。不要调用工具、修改文件或执行命令。';
  const matched = report.commits.map(commit => ({ commit, conversation: JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/runtime/projects', commit.projectId, 'commit-conversations', `${commit.commitSha}.json`))) }))
    .filter(record => record.conversation.turns.some(t => t.userEvents.some(e => e.content === expectedPrompt)));
  assert.equal(matched.length, 1, 'a captured turn must belong to exactly one submitted commit');
  const { commit, conversation } = matched[0];
  const project = projects.find(p => p.projectId === commit.projectId);
  const turn = conversation.turns.find(t => t.userEvents.some(e => e.content === expectedPrompt));
  assert.ok(turn && turn.assistantEvents.length === 1, 'actual user and actual final answer must enter the frozen commit evidence');
  const answer = turn.assistantEvents[0].content;
  assert.ok(answer.includes('32f655e019db49fdb9b2a51ecbca50c4d0069564') && answer.includes('e1d5f1e9d9f95b10a2dec466937d0d6a42a887a7'));
  assert.ok(!turn.userEvents[0].content.includes('KNOWLEDGE CONTEXT'), 'capture must preserve the raw prompt, not injected knowledge or system instructions');
  const session = await (await read(`/api/terminal/sessions/${encodeURIComponent(turn.sessionId)}`)).json();
  assert.equal(session.session.state, 'idle');
  assert.equal(session.session.contextId, project.modules.terminal.projectId);
  const final = session.events.find(e => e.type === 'claude/result' && e.result === answer && e.isError === false);
  assert.ok(final, 'bridge evidence must equal the real SDK final answer');
  const archive = await (await read(`/api/eventbridge/commits/${commit.commitSha}.md?project=${encodeURIComponent(project.modules.eventBridge.projectId)}`)).text();
  assert.ok(archive.includes(expectedPrompt) && archive.includes(answer));
  const health = await (await read('/api/terminal/health')).json();
  assert.equal(health.conversationCapture.pending, 0);
  assert.equal(health.conversationCapture.enabled, true);
  const context = await (await read(`/api/terminal/sessions/${encodeURIComponent(turn.sessionId)}/knowledge`)).json();
  assert.ok(context.references.length && context.references.every(r => r.projectId !== 'project-real-b'));
  AtomicFile.writeJsonAtomic(path.join(environment.root, 'real-capture-acceptance.json'), {
    passed: true, verifiedAt: new Date().toISOString(), mode: 'real native Workbench answer → authenticated bridge → frozen commit evidence → real Agent promotion and real embeddings',
    projectId: commit.projectId, commitSha: commit.commitSha, sessionId: turn.sessionId, turnId: turn.turnId,
    rawPromptPreserved: true, finalAnswerMatched: true, archiveMatched: true, pendingCapture: 0,
    frozenEvidenceHash: conversation.snapshotHash, references: context.references.map(r => ({ projectId: r.projectId, entryId: r.entryId, commitSha: r.commitSha })),
    uiEvidence: ['real-workbench-commit-evidence.jpg', 'real-maintenance-recovered.jpg'],
  });
  process.stdout.write('REAL_NATIVE_CAPTURE_ACCEPTANCE_PASSED\n');
}
main().catch(error => { process.stderr.write(`${error.code || 'ACCEPTANCE_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
