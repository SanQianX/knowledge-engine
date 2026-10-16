'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EngineStore } = require('../src/store');
const { MemoryService } = require('../src/memories');
const { RuntimeLayout } = require('../src/runtime/layout');
const { ConversationStore, sha256: contentSha } = require('../src/runtime/conversation-store');
const { memoryCandidateContract } = require('../src/analysis-contract');
const { renderCommitPrompt } = require('../src/runtime/commit-prompt');

const PREFERENCE = '所有项目长期统一：错误文案一律使用中文。';
const PROMPT = `请记住：${PREFERENCE}以后不用再确认。`;
const PARAPHRASE = '错误文案统一用中文，不再逐次确认。';

function freezeConversation(conversations, { projectId, commitSha, events }) {
  return conversations.writeSnapshot(projectId, {
    commitSha,
    status: 'available',
    turns: events.map((event, index) => ({
      turnId: event.turnId || `turn-${index + 1}`,
      source: event.source || 'claude-code',
      sessionId: event.sessionId || 'session-frozen',
      bindingKind: event.bindingKind || 'direct',
      userEvents: [{
        eventId: event.eventId,
        capturedAt: event.capturedAt || new Date().toISOString(),
        content: event.content,
        contentHash: contentSha(event.content),
        ...(event.inputOrigin === undefined ? {} : { inputOrigin: event.inputOrigin }),
      }],
      assistantEvents: event.assistantEvents || [],
    })),
  });
}

async function fixture(t, { domainId = 'domain-one', events } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-eligibility-'));
  const store = new EngineStore(path.join(root, 'data'));
  const project = store.addProject({ projectId: 'project-a', domainId, repoPath: path.join(root, 'code'), knowledgePath: path.join(root, 'knowledge') }).project;
  fs.mkdirSync(project.knowledgePath, { recursive: true });
  fs.writeFileSync(path.join(project.knowledgePath, 'README.md'), `# 知识\n\n用户原话：${PREFERENCE}\n\n同义转述：${PARAPHRASE}\n`);
  const conversations = new ConversationStore({ layout: new RuntimeLayout(store.dataDir) });
  const service = new MemoryService(store, { readSnapshot: (projectId, commitSha) => conversations.readSnapshot(projectId, commitSha) });
  const commitSha = 'c'.repeat(40);
  const snapshot = freezeConversation(conversations, {
    projectId: project.projectId,
    commitSha,
    events: events || [{ eventId: 'evt-human-1', content: PROMPT, inputOrigin: 'human' }],
  });
  t.after(() => { service.close?.(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const run = (candidates, over = {}) => ({
    projectId: project.projectId,
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    commitSha,
    promotedAt: new Date().toISOString(),
    ...over,
    staging: {
      operations: [{ path: 'README.md', operation: 'create', evidenceReferences: [`conversation:${snapshot.snapshotHash}`] }],
      ...(over.staging || {}),
      memoryCandidates: candidates,
    },
  });
  const candidate = (over = {}) => ({
    text: PREFERENCE,
    entryId: 'README.md',
    quote: PREFERENCE,
    sourceEventId: 'evt-human-1',
    sourceHash: contentSha(PROMPT),
    scopeType: 'global',
    eligibility: { durable: true, crossProject: true, reason: '用户原话要求“所有项目长期统一”，非单次任务要求。', scopeReason: '原话明确覆盖所有项目。' },
    ...over,
  });
  return { root, store, project, service, conversations, snapshot, commitSha, run, candidate };
}

test('a fully attested candidate from a frozen human event becomes a candidate carrying provenance', async t => {
  const f = await fixture(t);
  const report = f.service.capture(f.run([f.candidate()]));
  assert.equal(report.accepted, 1); assert.deepEqual(report.rejected, []);
  const [memory] = f.service.list();
  assert.equal(memory.status, 'candidate');
  assert.equal(memory.sourceEventId, 'evt-human-1');
  assert.equal(memory.sourceHash, contentSha(PROMPT));
  assert.deepEqual(memory.eligibility, { durable: true, crossProject: true, reason: '用户原话要求“所有项目长期统一”，非单次任务要求。', scopeReason: '原话明确覆盖所有项目。' });
  assert.equal(memory.evidence.quote, PREFERENCE);
  assert.equal(f.service.capture(f.run([f.candidate()])).deduplicated, 1);
});

test('a valid quote cannot attest an invented memory summary', async t => {
  const f = await fixture(t);
  const report = f.service.capture(f.run([f.candidate({ text: '所有项目必须使用未经用户提出的数据库。' })]));
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.rejected.map(r => r.code), ['TEXT_NOT_IN_QUOTE']);
});

test('legacy records missing provenance do not crash capture or materialization', async t => {
  const f = await fixture(t);
  const old = { id: 'memory-no-evidence', text: '旧记录保留', status: 'confirmed', brainId: 'brain-default' };
  f.store.state.memories.push(old);
  assert.equal(f.service.capture(f.run([f.candidate()])).accepted, 1);
  assert.match(f.service.content('brain-default'), /历史记录（来源未记录）/);
  assert.deepEqual(f.store.state.memories[0], old);
});

test('agent delegations and unverifiable origins never become preferences regardless of self-reported labels', async t => {
  const f = await fixture(t, { events: [
    { eventId: 'evt-agent', content: PROMPT, inputOrigin: 'agent-delegation' },
    { eventId: 'evt-legacy', content: PROMPT },
    { eventId: 'evt-unknown', content: PROMPT, inputOrigin: 'unknown' },
  ] });
  const report = f.service.capture(f.run([
    f.candidate({ sourceEventId: 'evt-agent' }),
    f.candidate({ sourceEventId: 'evt-legacy' }),
    f.candidate({ sourceEventId: 'evt-unknown' }),
  ]));
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.rejected.map(r => r.code), ['SOURCE_NOT_HUMAN', 'SOURCE_NOT_HUMAN', 'SOURCE_NOT_HUMAN']);
  assert.equal(f.service.list().length, 0);
  assert.ok(fs.readFileSync(path.join(f.project.knowledgePath, 'README.md'), 'utf8').includes(PREFERENCE), 'rejection keeps promoted knowledge');
});

test('misattributed or paraphrased provenance is rejected against the frozen snapshot', async t => {
  const f = await fixture(t);
  const report = f.service.capture(f.run([
    f.candidate({ quote: PARAPHRASE }),
    f.candidate({ sourceHash: `sha256:${'0'.repeat(64)}` }),
    f.candidate({ sourceEventId: 'evt-missing' }),
    f.candidate({ sourceEventId: '' }),
  ]));
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.rejected.map(r => r.code), ['QUOTE_NOT_IN_SOURCE', 'SOURCE_HASH_MISMATCH', 'SOURCE_EVENT_NOT_FOUND', 'SOURCE_EVENT_MISSING']);
  assert.equal(f.service.list().length, 0);
});

test('explicitly one-time, project-local and unattested preferences stay out of the candidate box', async t => {
  const f = await fixture(t);
  const report = f.service.capture(f.run([
    f.candidate({ eligibility: { durable: false, crossProject: true, reason: '本次任务临时要求', scopeReason: '原话明确覆盖所有项目。' } }),
    f.candidate({ eligibility: { durable: true, crossProject: false, reason: '长期偏好', scopeReason: '仅本项目使用' } }),
    f.candidate({ eligibility: null }),
    f.candidate({ eligibility: { durable: true, crossProject: true, reason: '', scopeReason: '原话明确覆盖所有项目。' } }),
    f.candidate({ eligibility: { durable: true, crossProject: true, reason: '长期偏好', scopeReason: ' ' } }),
  ]));
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.rejected.map(r => r.code), ['ELIGIBILITY_NOT_DURABLE', 'ELIGIBILITY_NOT_CROSS_PROJECT', 'ELIGIBILITY_MISSING', 'ELIGIBILITY_REASON_MISSING', 'ELIGIBILITY_SCOPE_REASON_MISSING']);
  const scoped = f.service.capture(f.run([
    f.candidate({ scopeType: 'project' }),
    f.candidate({ scopeType: undefined }),
  ]));
  assert.equal(scoped.accepted, 0);
  assert.deepEqual(scoped.rejected.map(r => r.code), ['SCOPE_NOT_SHARED', 'SCOPE_NOT_SHARED']);
});

test('domain scope requires a domain binding; project-local facts remain knowledge, not memories', async t => {
  const f = await fixture(t, { domainId: null });
  const report = f.service.capture(f.run([f.candidate({ scopeType: 'domain' })]));
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.rejected.map(r => r.code), ['SCOPE_DOMAIN_UNBOUND']);
  const bound = await fixture(t, { domainId: 'domain-one' });
  assert.equal(bound.service.capture(bound.run([bound.candidate({ scopeType: 'domain' })])).accepted, 1);
  assert.equal(bound.service.list()[0].scopeType, 'domain');
  assert.equal(bound.service.list()[0].scopeId, 'domain-one');
});

test('runs without a bound frozen snapshot reject safely and never block promotion', async t => {
  const f = await fixture(t);
  const unbound = f.service.capture(f.run([f.candidate()], { staging: { operations: [{ path: 'README.md', operation: 'create', evidenceReferences: ['commit:c'.repeat(6)] }] } }));
  assert.equal(unbound.accepted, 0);
  assert.deepEqual(unbound.rejected.map(r => r.code), ['SNAPSHOT_UNAVAILABLE']);
  const foreign = freezeConversation(f.conversations, { projectId: f.project.projectId, commitSha: 'd'.repeat(40), events: [{ eventId: 'evt-human-2', content: PROMPT, inputOrigin: 'human' }] });
  const borrowed = f.service.capture(f.run([f.candidate({ sourceEventId: 'evt-human-2', sourceHash: contentSha(PROMPT) })], { commitSha: 'd'.repeat(40) }));
  assert.equal(borrowed.accepted, 0);
  assert.deepEqual(borrowed.rejected.map(r => r.code), ['SNAPSHOT_UNAVAILABLE']);
  assert.ok(foreign.snapshotHash);
  const snapshotFile = path.join(new RuntimeLayout(f.store.dataDir).getProjectCommitConversationPath(f.project.projectId, f.commitSha));
  fs.writeFileSync(snapshotFile, '{corrupt');
  const corrupted = f.service.capture(f.run([f.candidate()]));
  assert.equal(corrupted.accepted, 0);
  assert.deepEqual(corrupted.rejected.map(r => r.code), ['SNAPSHOT_UNAVAILABLE']);
  assert.ok(fs.existsSync(path.join(f.project.knowledgePath, 'README.md')));
  assert.equal(f.service.list().length, 0);
});

test('legacy memories and manual records survive the strict gate untouched', async t => {
  const f = await fixture(t);
  const legacy = { id: 'memory-legacy', fingerprint: 'legacy', brainId: 'brain-default', text: '历史全局规则', status: 'confirmed', evidence: { projectId: 'project-a', commitSha: 'b'.repeat(40), entryId: 'README.md', quote: PREFERENCE } };
  const oldCandidate = { id: 'memory-old-candidate', fingerprint: 'old', captureFingerprint: 'old', brainId: 'brain-default', scopeType: 'project', scopeId: 'project-a', text: '旧项目候选', originalText: '旧项目候选', status: 'candidate', evidence: { projectId: 'project-a', commitSha: 'b'.repeat(40), entryId: 'README.md', quote: PREFERENCE } };
  f.store.state.memories.push(legacy, oldCandidate); f.store.save();
  const report = f.service.capture(f.run([f.candidate({ scopeType: 'project' })]));
  assert.equal(report.accepted, 0); assert.equal(report.rejected.length, 1);
  await f.service.configure([{ id: 'brain-default', brainId: 'brain-default', kind: 'brain', knowledgePath: path.join(f.root, 'shared') }]);
  const rows = f.service.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(m => m.id === 'memory-legacy'), { ...legacy, scopeType: 'global', scopeId: 'brain-default', targetName: 'brain-default', targetAvailable: true, syncStatus: 'ready', indexStatus: 'pending' });
  assert.equal(rows.find(m => m.id === 'memory-old-candidate').text, '旧项目候选');
  const manual = await f.service.create({ text: '手动记忆保持可用', brainId: 'brain-default', scopeType: 'global', scopeId: 'brain-default' });
  assert.equal((await f.service.update(manual.id, { text: '手动编辑仍然自由', scopeType: 'project', scopeId: 'project-a' })).text, '手动编辑仍然自由');
});

test('the maintenance contract demands frozen human provenance and shared scopes only', () => {
  const contract = memoryCandidateContract('changes/abc123def456.md');
  assert.match(contract, /sourceEventId/);
  assert.match(contract, /sourceHash/);
  assert.match(contract, /eligibility/);
  assert.match(contract, /durable/);
  assert.match(contract, /crossProject/);
  assert.match(contract, /scopeReason/);
  assert.match(contract, /inputOrigin\s*"human"|inputOrigin.*human/);
  assert.match(contract, /agent-delegation/);
  assert.ok(!contract.includes('"scopeType":"project"'), 'automatic candidates have no project scope in the contract shape');
  assert.match(contract, /"domain" or "global"|"domain"|"global"/);
});

test('the frozen user truth surfaces inputOrigin so delegation prompts cannot pose as owner statements', () => {
  const snapshot = {
    schema: 'commit-conversation-snapshot/v1',
    projectId: 'project-a',
    commitSha: 'c'.repeat(40),
    status: 'available',
    turns: [{
      turnId: 'turn-1',
      source: 'claude-code',
      sessionId: 'session-frozen',
      bindingKind: 'direct',
      userEvents: [
        { eventId: 'evt-1', capturedAt: new Date().toISOString(), content: PROMPT, contentHash: contentSha(PROMPT), inputOrigin: 'human' },
        { eventId: 'evt-2', capturedAt: new Date().toISOString(), content: '帮我修复这次的一次性故障。', contentHash: contentSha('帮我修复这次的一次性故障。'), inputOrigin: 'agent-delegation' },
        { eventId: 'evt-3', capturedAt: new Date().toISOString(), content: '旧版本事件没有来源标记。', contentHash: contentSha('旧版本事件没有来源标记。') },
      ],
      assistantEvents: [],
    }],
    excludedFuturePromptCount: 0,
    finalizedAt: new Date().toISOString(),
  };
  const { prompt } = renderCommitPrompt({ conversationSnapshot: snapshot, evidence: {} });
  assert.match(prompt, /inputOrigin: human/);
  assert.match(prompt, /inputOrigin: agent-delegation/);
  assert.match(prompt, /inputOrigin: unknown/);
  assert.ok(prompt.includes('eventId: evt-1'));
});
