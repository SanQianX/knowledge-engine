'use strict';

// P-ENGINE-ORDER-SAFETY-R6 behavioural regression (rewritten from the rejected
// R4 candidate's file; the R4 bytes are snapshotted by the lane before rework).
//
// The R4 candidate auto-compensated a boundary event that arrived after the
// analysed head had moved past its commit. The Leader rejected it: promoting
// the old commit advanced lastAnalyzedCommit BACKWARDS (head B -> old A),
// violating "single-project order, no skipping, no regression", and a late old
// commit writing the current knowledge tree can overwrite the newer knowledge
// the head already promoted at the same path.
//
// R6 semantics under test (safety and existing commit order win):
//   * a captured commit BEHIND the analysed head is never auto-analysed:
//     no run, no ledger entry, no claim, no analyzer invocation, the pointer
//     stays at the head, and the head's knowledge tree/index never regress;
//   * the late commit is flagged as an explicit late/out-of-order diagnostic
//     (reconcile.late_commit_flagged) and recorded in a durable per-project
//     registry awaiting CONTROLLED handling - no fake success, no silent drop;
//   * redelivery flags exactly once; restart neither loses the registry nor
//     triggers analysis; new descendant commits keep flowing (no stall);
//   * unchanged guards: pre-baseline history is never analysed, a completed
//     SHA is never analysed twice, a previously attempted commit keeps its
//     claim for explicit retry only;
//   * unchanged ordering semantics: a failed commit still blocks newer commits
//     until an explicit retry completes it, and the explicit retry reuses the
//     SAME run record and frozen claim (each SHA analysed at most once per
//     attempt, no re-run of completed heads to mask anything).
//
// The same file is RED against the pinned bytes (a late commit behind the head
// is silently dropped: no flag, no registry) and RED against the rejected R4
// candidate (a late commit is auto-analysed: the head regresses and the shared
// knowledge doc is overwritten with older content). KB_ENGINE_SOURCE_ROOT
// selects the engine tree under test (default: this module's own src/). No
// sibling repository, no network and no paid model call - the analyzer is a
// deterministic stand-in and the vector index is a local stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const sourceRoot = path.resolve(process.env.KB_ENGINE_SOURCE_ROOT || path.join(__dirname, '..'));
const { createEngineServer } = require(path.join(sourceRoot, 'src', 'server'));
const AtomicFile = require(path.join(sourceRoot, 'src', 'runtime', 'atomic-file'));

const PROJECT_ID = 'project-reconcile-gap-fill';
// Journal ids must be sha256:<hex> to survive the engine state's restart
// validation (store.load rejects any other cursor key).
const JOURNAL_ID = `sha256:${crypto.createHash('sha256').update('engine-order-r6-reconcile-gap-fill').digest('hex')}`;
const SHARED_DOC = 'modules/guide.md';

function isolatedGitEnv(root) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'does-not-exist.gitconfig'),
    GIT_CONFIG_SYSTEM: path.join(root, 'does-not-exist.gitconfig'),
  };
}

function git(repoPath, args, root) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', windowsHide: true, env: isolatedGitEnv(root) }).trim();
}

// old -> baseline (tracking start) -> late (captured after the head moved on)
//      -> head (analysed first) -> next (arrives after the late flag)
function createFixtureRepo(root) {
  const repoPath = path.join(root, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q'], root);
  git(repoPath, ['config', 'user.email', 'reconcile@test.invalid'], root);
  git(repoPath, ['config', 'user.name', 'P-ENGINE-ORDER-SAFETY-R6'], root);
  const commit = (name, body) => {
    fs.writeFileSync(path.join(repoPath, `${name}.txt`), `${body}\n${name.repeat(64)}\n`);
    git(repoPath, ['add', '.'], root);
    git(repoPath, ['commit', '-qm', `feature ${name}`], root);
    return git(repoPath, ['rev-parse', 'HEAD'], root);
  };
  const old = commit('old', 'pre-baseline history');
  const baseline = commit('baseline', 'tracking baseline');
  const late = commit('late', 'captured but delivered after the head');
  const head = commit('head', 'delivered and analysed first');
  const next = commit('next', 'arrives after the late flag');
  return { repoPath, old, baseline, late, head, next };
}

// In-memory journal: the engine sees exactly the events this test publishes.
function createFakeBridge() {
  const events = [];
  return {
    events,
    emitBoundary(commitSha, parents) {
      events.push({
        journalId: JOURNAL_ID,
        sequence: events.length + 1,
        schema: 'git-commit-boundary/v1',
        commitSha,
        parents: parents || [],
        operationId: `op-${commitSha.slice(0, 8)}-${events.length + 1}`,
        committedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
        source: 'post-commit-hook',
      });
    },
    async registerConsumer() { return { ok: true }; },
    async listJournals() { return [{ journalId: JOURNAL_ID }]; },
    async readEvents({ journalId, fromSequence, limit }) {
      // The bridge journal is inclusive on fromSequence (see the pinned
      // ai-coding-event-bridge journal.readEvents).
      return events.filter(event => event.journalId === journalId && event.sequence >= fromSequence).slice(0, limit || 100);
    },
    async ackConsumerCursor() { return { ok: true }; },
    close() {},
  };
}

// Local vector-index stub: the paid embedding API is not exercised.
function createIndexServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  })));
}

// Deterministic stand-in: real staged Markdown bytes and a real staging
// manifest through the engine's real promotion path. No model output.
//   replacePlan: commitSha -> newer/older content for the SAME existing doc,
//                so a wrongly promoted late commit visibly overwrites the
//                head's newer knowledge (the R4 defect);
//   failOnce:    commitShas whose FIRST attempt fails with a transient fault
//                (exercises the failed-run blocking + explicit retry path).
function createStandinAnalyzer(invocations, { replacePlan = new Map(), failOnce = new Set() } = {}) {
  const attempts = new Map();
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      const claim = input.claim;
      invocations.push(claim.commitSha);
      if (failOnce.has(claim.commitSha)) {
        const seen = (attempts.get(claim.commitSha) || 0) + 1;
        attempts.set(claim.commitSha, seen);
        if (seen === 1) throw Object.assign(new Error('确定性替身首次分析失败（瞬态故障）。'), { code: 'STANDIN_ANALYZER_FAILURE', retryable: true });
      }
      const replacement = replacePlan.get(claim.commitSha);
      const relativePath = replacement ? SHARED_DOC : `changes/${claim.commitSha.slice(0, 12)}.md`;
      const markdown = replacement ? replacement.content : [
        '---',
        `commit: ${claim.commitSha}`,
        '---',
        `# Fixture knowledge ${input.projectId}`,
        '',
        `Commit ${claim.commitSha} promoted by the deterministic stand-in analyzer.`,
        '',
      ].join('\n');
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', ...relativePath.split('/')), markdown);
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: claim.runId,
        commitSha: claim.commitSha,
        operations: [{
          operation: replacement ? 'replace' : 'create',
          path: relativePath,
          reason: 'Deterministic stand-in knowledge for reconciliation coverage',
          sha256: `sha256:${crypto.createHash('sha256').update(markdown).digest('hex')}`,
          evidenceReferences: [
            `commit:${claim.commitSha}`,
            `patch:${claim.patchHash}`,
            `conversation:${claim.conversationSnapshotHash}`,
            `retrieval:${claim.retrievalManifestHash}`,
          ],
        }],
        memoryCandidates: [],
      });
      return { ok: true };
    },
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readDiagnostics(dataDir, projectId) {
  const directory = path.join(dataDir, 'logs', 'projects', projectId);
  if (!fs.existsSync(directory)) return [];
  const records = [];
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split('\n').filter(Boolean)) records.push(JSON.parse(line));
  }
  return records;
}

async function waitFor(predicate, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startEngine(root, invocations, options = {}) {
  const knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledgePath, 'modules'), { recursive: true });
  const bridge = options.bridge || createFakeBridge();
  const index = options.index || await createIndexServer();
  const dataDir = options.dataDir || path.join(root, 'engine-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = createEngineServer({
    dataDir,
    consume: true,
    analyzer: createStandinAnalyzer(invocations, options.analyzer || {}),
    bridge,
    vectorUrl: index.url,
  });
  await runtime.ready;
  return { runtime, bridge, index, knowledgePath, dataDir, invocations };
}

function registerProject(engine, fixture) {
  engine.runtime.store.addProject({
    projectId: PROJECT_ID,
    repoPath: fixture.repoPath,
    knowledgePath: engine.knowledgePath,
    trackingStartCommit: fixture.baseline,
    journalId: JOURNAL_ID,
    conversationBaselineCursor: 0,
  });
}

test('a late captured commit behind the analysed head is flagged for controlled handling, never auto-analysed, and never regresses the head, the tree or the index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-order-r6-'));
  const fixture = createFixtureRepo(root);
  const invocations = [];
  const engine = await startEngine(root, invocations, {
    analyzer: {
      replacePlan: new Map([
        [fixture.head, { content: `# 共享指南\n\n由最新提交 ${fixture.head} 更新的事实（B 时代内容）。\n` }],
        [fixture.late, { content: `# 共享指南\n\n由旧提交 ${fixture.late} 更新的过时内容（A 时代，晚到）。\n` }],
      ]),
    },
  });
  try {
    registerProject(engine, fixture);
    fs.writeFileSync(path.join(engine.knowledgePath, SHARED_DOC), `# 共享指南\n\n初始版本（基线时代内容）。\n`);

    // The head commit is captured and analysed first; its promotion REPLACES
    // the shared doc with the newest facts.
    engine.bridge.emitBoundary(fixture.head, [fixture.late]);
    await engine.runtime.coordinator.drain();
    const headRun = await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.head && run.state === 'succeeded'),
      60000,
      'the head commit to be analysed',
    );
    const headPointer = engine.runtime.store.readRuntime(PROJECT_ID).lastAnalyzedCommit;
    const docHashAtHead = sha256(path.join(engine.knowledgePath, SHARED_DOC));
    const generationAtHead = engine.runtime.store.readRuntime(PROJECT_ID).index.generation;
    assert.equal(headPointer, fixture.head, 'precondition: the head is analysed');
    assert.ok(fs.readFileSync(path.join(engine.knowledgePath, SHARED_DOC), 'utf8').includes('B 时代内容'), 'precondition: the shared doc holds the head\'s newest facts');

    // The late commit's boundary arrives afterwards: the evidence WAS captured,
    // but the analysed head already moved past its commit.
    engine.bridge.emitBoundary(fixture.late, [fixture.baseline]);
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 800));

    const runtimeAfterLate = engine.runtime.store.readRuntime(PROJECT_ID);
    assert.equal(runtimeAfterLate.lastAnalyzedCommit, fixture.head, 'the analysed head must NOT regress to the late commit');
    assert.equal(sha256(path.join(engine.knowledgePath, SHARED_DOC)), docHashAtHead, 'the head\'s newer knowledge at the shared path must not be overwritten by the late commit');
    assert.equal(
      engine.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.late).length,
      0,
      'the late commit must not be auto-analysed (no run)',
    );
    assert.equal(engine.runtime.coordinator.reconciler.processingLedger.read(PROJECT_ID, fixture.late), null, 'no ledger entry for the late commit');
    assert.equal(fs.existsSync(engine.runtime.coordinator.reconciler.claimStore.filePath(PROJECT_ID, fixture.late)), false, 'no claim snapshot for the late commit');
    assert.equal(fs.existsSync(path.join(engine.knowledgePath, 'changes', `${fixture.late.slice(0, 12)}.md`)), false, 'the late commit does not reach the knowledge tree');
    assert.equal(invocations.filter(sha => sha === fixture.late).length, 0, 'the analyzer never runs for the late commit');
    assert.equal(invocations.filter(sha => sha === fixture.head).length, 1, 'the completed head is never re-analysed to mask anything');
    assert.equal(runtimeAfterLate.index.generation, generationAtHead, 'no promotion happened behind the flag');

    // The explicit late/out-of-order state: a durable registry entry plus a
    // warn diagnostic - not a fake success, not a silent drop.
    const registry = runtimeAfterLate.lateCommits || [];
    assert.equal(registry.length, 1, 'exactly one late-commit registry entry');
    assert.equal(registry[0].commitSha, fixture.late);
    assert.equal(registry[0].analysedHeadAtCapture, fixture.head);
    assert.equal(typeof registry[0].journalSequence, 'number');
    const diagnostics = readDiagnostics(engine.dataDir, PROJECT_ID);
    const flagged = diagnostics.find(record => record.event === 'reconcile.late_commit_flagged' && record.commitSha === fixture.late);
    assert.ok(flagged, 'an explicit late/out-of-order diagnostic is recorded');
    assert.equal(flagged.level, 'warn');
    assert.ok(
      engine.runtime.store.listEvents(200).some(event => event.commitSha === fixture.late && /晚到/.test(event.summary || '')),
      'the late commit is surfaced in the engine event log',
    );

    // Redelivery of the same boundary flags exactly once and still runs nothing.
    engine.bridge.emitBoundary(fixture.late, [fixture.baseline]);
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || []).length, 1, 'redelivery does not duplicate the registry entry');
    assert.equal(engine.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.late).length, 0);
    assert.equal(invocations.filter(sha => sha === fixture.late).length, 0);

    // The flag does not stall the project: a NEW descendant commit flows normally.
    engine.bridge.emitBoundary(fixture.next, [fixture.head]);
    await engine.runtime.coordinator.drain();
    await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.next && run.state === 'succeeded'),
      60000,
      'the new descendant commit to be analysed',
    );
    assert.equal(engine.runtime.store.readRuntime(PROJECT_ID).lastAnalyzedCommit, fixture.next, 'the head advances forward only');
    assert.equal(invocations.filter(sha => sha === fixture.head).length, 1, 'the head is still never re-analysed');
    assert.equal((engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || []).length, 1, 'the unresolved late flag survives forward progress');

    // Restart on the same data dir: the registry persists and nothing is
    // auto-analysed for the late commit.
    const invocationsAfterRestart = [];
    await engine.runtime.close();
    const restarted = await startEngine(root, invocationsAfterRestart, { dataDir: engine.dataDir, index: engine.index, bridge: createFakeBridge() });
    try {
      await restarted.runtime.coordinator.drain();
      await new Promise(resolve => setTimeout(resolve, 500));
      const runtimeAfterRestart = restarted.runtime.store.readRuntime(PROJECT_ID);
      assert.equal(runtimeAfterRestart.lastAnalyzedCommit, fixture.next, 'restart keeps the forward head');
      assert.equal(runtimeAfterRestart.lateCommits.length, 1, 'restart keeps the late-commit registry entry');
      assert.equal(runtimeAfterRestart.lateCommits[0].commitSha, fixture.late);
      assert.equal(restarted.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.late).length, 0, 'restart does not analyse the late commit');
      assert.equal(invocationsAfterRestart.length, 0, 'restart analyses nothing');
      assert.equal(sha256(path.join(restarted.knowledgePath, SHARED_DOC)), docHashAtHead, 'the shared doc keeps the head\'s newest facts across the restart');
    } finally {
      await restarted.runtime.close();
    }
    void headRun;
  } finally {
    try { await engine.runtime.close(); } catch {}
    await engine.index.close();
  }
});

test('a failed commit still blocks newer commits until an explicit retry completes it, and the retry reuses the same run and frozen claim', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-order-r6-'));
  const fixture = createFixtureRepo(root);
  const invocations = [];
  const engine = await startEngine(root, invocations, { analyzer: { failOnce: new Set([fixture.late]) } });
  try {
    registerProject(engine, fixture);

    // The older commit fails its first attempt (transient stand-in fault).
    engine.bridge.emitBoundary(fixture.late, [fixture.baseline]);
    await engine.runtime.coordinator.drain();
    const failedRun = await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.late && run.state === 'failed'),
      60000,
      'the first attempt to fail',
    );
    assert.equal(failedRun.error.code, 'STANDIN_ANALYZER_FAILURE');
    const activeClaim = engine.runtime.store.readRuntime(PROJECT_ID).analysis.activeClaim;
    assert.equal(activeClaim && activeClaim.commitSha, fixture.late, 'the failed commit keeps its claim (旧claim) for explicit retry');

    // A newer commit is enqueued but BLOCKED behind the failure: no skipping.
    engine.bridge.emitBoundary(fixture.head, [fixture.late]);
    await engine.runtime.coordinator.drain();
    const blockedRun = await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.head && run.phase === 'waiting-previous'),
      20000,
      'the newer commit to be parked behind the failure',
    );
    assert.equal(blockedRun.state, 'queued');
    assert.equal(invocations.filter(sha => sha === fixture.head).length, 0, 'the newer commit is never analysed while the older one failed');

    // Explicit retry: the SAME run record is re-queued and the frozen claim is
    // reused (attempt 2) instead of collecting fresh evidence.
    engine.runtime.coordinator.retry(failedRun.runId);
    const recovered = await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.runId === failedRun.runId && run.state === 'succeeded'),
      60000,
      'the explicitly retried run to succeed',
    );
    assert.equal(recovered.runId, failedRun.runId, 'retry reuses the same run record - no duplicate run for the same commit');
    assert.equal(invocations.filter(sha => sha === fixture.late).length, 2, 'the failed commit was analysed exactly twice (first attempt + explicit retry)');

    // Once unblocked the newer commit proceeds and the order is preserved.
    const nextRun = await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.head && run.state === 'succeeded'),
      60000,
      'the blocked newer commit to finish after the retry',
    );
    assert.equal(invocations.filter(sha => sha === fixture.head).length, 1, 'the newer commit is analysed exactly once');
    assert.ok(engine.runtime.coordinator.reconciler.processingLedger.read(PROJECT_ID, fixture.late), 'the retried commit reaches the ledger');
    assert.ok(engine.runtime.coordinator.reconciler.processingLedger.read(PROJECT_ID, fixture.head), 'the newer commit reaches the ledger');
    assert.equal(engine.runtime.store.readRuntime(PROJECT_ID).lastAnalyzedCommit, fixture.head, 'the head ends at the newest commit - forward order only');
    assert.equal(fs.existsSync(engine.runtime.coordinator.reconciler.claimStore.filePath(PROJECT_ID, fixture.late)), false, 'the claim snapshot is released after success');
    void nextRun;
  } finally {
    await engine.runtime.close();
    await engine.index.close();
  }
});

test('the historical guards survive: pre-baseline history, a completed SHA and a previously attempted commit are never analysed and never flagged late', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-order-r6-'));
  const fixture = createFixtureRepo(root);
  const invocations = [];
  const engine = await startEngine(root, invocations);
  try {
    registerProject(engine, fixture);

    engine.bridge.emitBoundary(fixture.head, [fixture.late]);
    await engine.runtime.coordinator.drain();
    await waitFor(
      () => engine.runtime.store.listRuns(PROJECT_ID).find(run => run.commitSha === fixture.head && run.state === 'succeeded'),
      60000,
      'the head commit to be analysed',
    );
    assert.deepEqual(engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || [], [], 'a normal capture is never flagged');

    // Pre-baseline history is never analysed and never flagged.
    engine.bridge.emitBoundary(fixture.old, []);
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(engine.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.old).length, 0, 'a commit at or before the tracking baseline is never analysed');
    assert.equal(invocations.filter(sha => sha === fixture.old).length, 0);
    assert.deepEqual(engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || [], [], 'pre-baseline history is not flagged late');

    // A completed SHA is not analysed again.
    engine.bridge.emitBoundary(fixture.head, [fixture.late]);
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(invocations.filter(sha => sha === fixture.head).length, 1, 'a completed SHA is not analysed twice');
    assert.equal(engine.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.head).length, 1, 'a completed SHA does not create a second run');
    assert.deepEqual(engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || [], [], 'a completed SHA is not flagged late');

    // A commit that was attempted before (failed or interrupted) keeps its
    // claim snapshot and stays on the explicit-retry path - it is neither
    // re-run nor flagged late when its event arrives behind the head.
    engine.runtime.coordinator.reconciler.claimStore.write(PROJECT_ID, fixture.late, {
      projectId: PROJECT_ID,
      commitSha: fixture.late,
      claimFingerprint: 'fixture-attempted',
    });
    engine.bridge.emitBoundary(fixture.late, [fixture.baseline]);
    await engine.runtime.coordinator.drain();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(engine.runtime.store.listRuns(PROJECT_ID).filter(run => run.commitSha === fixture.late).length, 0, 'a previously attempted commit is not silently re-run when its event arrives late');
    assert.equal(invocations.filter(sha => sha === fixture.late).length, 0);
    assert.deepEqual(engine.runtime.store.readRuntime(PROJECT_ID).lateCommits || [], [], 'an attempted commit stays on the claim/retry path and is not flagged late');
    assert.ok(fs.existsSync(engine.runtime.coordinator.reconciler.claimStore.filePath(PROJECT_ID, fixture.late)), 'the claim snapshot is preserved');
  } finally {
    await engine.runtime.close();
    await engine.index.close();
  }
});
