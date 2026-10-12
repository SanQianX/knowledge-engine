'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { RuntimeLayout, realpathWithMissingLeaf } = require('./runtime/layout');
const AtomicFile = require('./runtime/atomic-file');
const { ConversationStore } = require('./runtime/conversation-store');
const { CommitReconciler } = require('./runtime/commit-reconciler');
const { KnowledgePromotionService } = require('./runtime/knowledge-promotion');
const { EngineRetrieval } = require('./retrieval');
const { BridgeClient } = require('./bridge-client');
const { HeadlessAnalyzer } = require('./headless-analyzer');
const { MemoryService } = require('./memories');
const { execGit } = require('./runtime/git-runner');
const { createDiagnostics } = require('./diagnostics');
const { finalizeAnalysisOutput } = require('./analysis-output');
const { requestIndex } = require('./index-request');

class EngineCoordinator extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.layout = new RuntimeLayout(store.dataDir);
    this.vectorUrl = options.vectorUrl || 'http://127.0.0.1:8787';
    this.bridge = options.bridge || new BridgeClient(options.bridgeUrl);
    this.consume = options.consume === true;
    this.executionEnabled = options.managed !== true;
    this.concurrency = Math.max(1, Math.min(2, Number(options.concurrency) || 2));
    this.active = new Map();
    this.jobs = new Set();
    this.journalFailures = new Map();
    this.initializeHook = options.initializeHook;
    this.profiles = new Map();
    const diagnostics = createDiagnostics({ dataDir: store.dataDir, secrets: () => [...this.profiles.values()].flatMap(profile => [profile.apiKey, profile.authToken]) });
    this.diagnostics = options.logger || diagnostics;
    this.safeMessage = diagnostics.sanitize;
    this.closed = false;
    this.sharedIndexJobs = new Map();
    this.memoryIndexUpdates = new Set();
    this.sharedIndexDirty = new Set();
    this.sharedIndexQueue = Promise.resolve();
    this.memories = new MemoryService(store, {
      getIndexStatus: scope => scope && this.memoryIndexUpdates.has(scope.id) && this.sharedIndexJobs.has(scope.id) ? 'pending' : null,
      onMaterialized: scope => { this.memoryIndexUpdates.add(scope.id); this.indexSharedScope(scope).catch(() => {}); },
      onSyncChange: (scope, code) => {
        this.emit('progress', store.addEvent({ type: 'memory.sync', scopeId: scope.id, summary: code ? `记忆文件待恢复（${code}）` : '记忆文件已恢复同步' }));
        const log = code ? 'error' : 'info';
        Promise.resolve(this.diagnostics[log]('knowledge.memory.' + (code ? 'write_failed' : 'write_recovered'), code ? '记忆状态已保存，文件待恢复。' : '记忆文件已恢复同步。', { phase: 'memory-sync', context: { scopeId: scope.id, code: code || null } })).catch(() => {});
      },
    });
    this.projectStore = {
      readConfig: id => { const p = store.getProject(id); if (!p) throw Object.assign(new Error('项目未登记。'), { code: 'PROJECT_NOT_FOUND' }); return { ...p, displayName: p.name, automation: { enabled: true } }; },
      readState: id => store.readRuntime(id),
      updateState: (id, fn) => store.updateRuntime(id, fn),
      readRequirements: () => [],
    };
    const registryStore = { listIds: () => store.listProjects().map(p => p.projectId), readDisplaySnapshot: id => store.getProject(id) };
    this.retrieval = new EngineRetrieval({ layout: this.layout, projectStore: this.projectStore, registryStore, store, memories: this.memories, vectorUrl: this.vectorUrl });
    this.conversations = new ConversationStore({ layout: this.layout, projectStore: this.projectStore });
    this.analyzer = options.analyzer || new HeadlessAnalyzer({ resolveProfile: id => this.profiles.get(id) || this.profiles.get('default'), timeoutMs: options.timeoutMs });
    this.promotion = new KnowledgePromotionService({ layout: this.layout, logger: this.diagnostics, projectStore: this.projectStore, analyzer: { sourceReadMode: this.analyzer.sourceReadMode, runClaim: async input => {
      const run = this.currentRun(input.projectId);
      store.updateRun(run.runId, { analysisRunId: input.claim.runId, phase: 'analyzing' });
      this.notify(run, '正在分析冻结的提交证据');
      if (run.debugFailure) throw Object.assign(new Error('调试模式：模拟分析失败。'), { code: 'DEBUG_SIMULATED_FAILURE', retryable: true });
      await this.analyzer.runClaim(input);
      const normalized = finalizeAnalysisOutput(input);
      if (normalized.length) await this.diagnostics.info('knowledge.output.normalized', '已为非空知识文档补齐一级标题。', { projectId: run.projectId, runId: run.runId, commitSha: run.commitSha, phase: 'validating', context: { files: normalized } });
      store.updateRun(run.runId, { phase: 'promoting' });
      this.notify(run, '校验并晋升知识');
      return { ok: true };
    } } });
    this.reconciler = new CommitReconciler({ layout: this.layout, logger: this.diagnostics, projectStore: this.projectStore, registryStore, conversationStore: this.conversations, retrievalService: this.retrieval, claimProcessor: this.promotion });
    this.ready = this.initialize();
  }
  currentRun(id) { return this.store.getRun(this.active.get(id)); }
  setProfile(id, profile) { if (profile) this.profiles.set(id, profile); else this.profiles.delete(id); }
  notify(run, summary) {
    const event = this.store.addEvent({ type: 'knowledge.run', projectId: run.projectId, runId: run.runId, commitSha: run.commitSha, phase: run.phase, summary });
    this.emit('progress', event);
  }
  async initialize() {
    await this.initializeHook?.();
    if (this.executionEnabled) await this.promotion.recoverAll();
    await this.memories.recover();
    for (const run of this.store.state.runs) {
      if (run.state === 'running') this.store.updateRun(run.runId, { state: 'queued', phase: 'recovering' });
    }
    if (this.consume) {
      await this.drain().catch(() => {});
      this.poll = setInterval(() => this.drain().catch(() => {}), 2000);
      this.poll.unref();
    }
    this.pump();
    if (this.executionEnabled) for (const run of this.store.state.runs.filter(r => r.state === 'index-pending')) this.retry(run.runId);
  }
  async activate() {
    await this.ready;
    if (this.executionEnabled && this.consume) return;
    await this.promotion.recoverAll();
    this.executionEnabled = true;
    this.consume = true;
    await this.drain();
    if (!this.poll) { this.poll = setInterval(() => this.drain(), 2000); this.poll.unref(); }
    for (const run of this.store.state.runs.filter(r => r.state === 'index-pending')) this.retry(run.runId);
    this.pump();
  }
  enqueue(input) {
    const p = this.store.getProject(input.projectId);
    if (!p || p.enabled === false) throw Object.assign(new Error('项目未登记或已停用。'), { code: 'PROJECT_NOT_FOUND', status: 404 });
    const run = this.store.addRun(input);
    if (input.debugFailure) this.store.updateRun(run.runId, { debugFailure: true });
    this.emit('progress', { projectId: run.projectId, runId: run.runId, commitSha: run.commitSha, phase: run.phase });
    this.ready.then(() => this.pump());
    return run;
  }
  async removeProject(projectId) {
    await this.ready;
    // An indexing job can still hold a write lease even after its state changes.
    if (this.active.has(projectId)) throw Object.assign(new Error('此项目正在执行知识维护，请等待写入结束后再解绑。'), { status: 409, code: 'PROJECT_BUSY' });
    const result = this.store.removeProject(projectId);
    if (result.removed) this.emit('progress', this.store.addEvent({ type: 'project.unregister', projectId, summary: `已解绑项目，取消 ${result.cancelledRuns} 个未开始任务；知识与提交证据保留。` }));
    return result;
  }
  drain() {
    if (this.drainJob) return this.drainJob;
    if (this.closed) return Promise.resolve();
    const job = this.drainJournals().finally(() => { this.drainJob = null; });
    this.drainJob = job;
    return job;
  }
  async drainJournals() {
    this.draining = true;
    try {
      await this.bridge.registerConsumer('knowledge-engine', { journals: ['*'] });
      const journals = await this.bridge.listJournals();
      this.journalFailures.delete('connection');
      for (const journal of journals) {
        if (this.closed) break;
        try {
          await this.consumeJournal(journal);
          if (this.journalFailures.delete(journal.journalId)) await this.diagnostics.info('knowledge.journal.recovered', '项目事件消费已恢复。', { phase: 'consuming', context: { journalId: journal.journalId } });
        } catch (error) {
          // Never ACK invalid evidence; a project fault must not starve other journals.
          await this.recordJournalFailure(journal.journalId, error);
        }
      }
      for (const id of this.journalFailures.keys()) if (!journals.some(j => j.journalId === id)) this.journalFailures.delete(id);
    } catch (error) { await this.recordJournalFailure('connection', error); }
    finally {
      this.journalError = this.journalFailures.size ? '事件消费异常，未消费证据与游标已保留，请查看诊断日志。' : null;
      this.draining = false;
    }
  }
  async recordJournalFailure(journalId, error) {
    const context = error.journalContext || {};
    const failure = { journalId, sequence: context.sequence ?? null, projectId: context.projectId || null, code: error.code || 'JOURNAL_FAILED', message: this.safeMessage(error.message) };
    if (JSON.stringify(this.journalFailures.get(journalId)) !== JSON.stringify(failure)) {
      this.journalFailures.set(journalId, failure);
      await this.diagnostics.error('knowledge.journal.failed', '事件消费失败，已保留未确认的证据与游标。', { projectId: failure.projectId, phase: 'consuming', error, context: { ...failure, source: context.source || null } });
    }
  }
  async consumeJournal(journal) {
    const cursor = this.store.state.journalCursors[journal.journalId] || 0;
    const events = await this.bridge.readEvents({ journalId: journal.journalId, fromSequence: cursor + 1, limit: 100 });
    let through = cursor;
    for (const event of events) {
      if (this.closed) break;
      const p = this.store.listProjects().find(p => p.enabled !== false && ((journal.journalId !== 'global' && p.journalId === journal.journalId)
        || ((journal.journalId === 'global' || !p.journalId) && event.repoIdentity?.workspaceRoot && this.layout.pathsEqual(p.repoPath, event.repoIdentity.workspaceRoot))));
      try {
        if (p) {
          if (event.schema === 'ai-coding-event/v1' && ['user_prompt', 'assistant_response'].includes(event.eventType)) await this.conversations.appendBridgeEvent(p.projectId, { ...event, journalId: journal.journalId });
          if (event.schema === 'git-commit-boundary/v1' && /^[a-f0-9]{7,64}$/i.test(event.commitSha || '')) {
            if (!fs.existsSync(this.layout.getProjectCommitBoundaryPath(p.projectId, event.commitSha))) this.conversations.writeBoundary(p.projectId, { ...event, journalId: journal.journalId, parentShas: event.parents || [], bridgeCursorAtCommit: event.sequence, journalSequence: event.sequence, operationId: event.operationId || `bridge-${journal.journalId}-${event.sequence}`, committedAt: event.committedAt || event.capturedAt });
            const baseline = p.runtime.lastAnalyzedCommit || p.trackingStartCommit;
            const completed = this.reconciler.processingLedger.read(p.projectId, event.commitSha);
            const historical = baseline && (baseline === event.commitSha || (await execGit(p.repoPath, ['merge-base', '--is-ancestor', event.commitSha, baseline])).ok);
            if (!completed && !historical && this.store.getProject(p.projectId)?.enabled) this.enqueue({ projectId: p.projectId, commitSha: event.commitSha, trigger: 'git-hook', journalId: journal.journalId, journalSequence: event.sequence });
          }
        }
      } catch (error) { error.journalContext = { projectId: p?.projectId, sequence: event.sequence, source: event.source }; throw error; }
      through = event.sequence;
    }
    // All evidence projections and queued jobs are durable before ACK.
    if (through > cursor) this.store.setJournalCursor(journal.journalId, through);
    await this.bridge.ackConsumerCursor('knowledge-engine', through, { journalId: journal.journalId });
  }
  pump() {
    if (this.closed || !this.executionEnabled) return;
    const queued = this.store.state.runs.filter(r => r.state === 'queued').sort((a, b) => a.sequence - b.sequence);
    for (const run of queued) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(run.projectId)) continue;
      if (this.store.state.runs.some(previous => previous.projectId === run.projectId && previous.sequence < run.sequence && previous.state === 'failed' && !previous.promotedAt)) {
        if (run.phase !== 'waiting-previous') { this.store.updateRun(run.runId, { phase: 'waiting-previous' }); this.notify(run, '等待前一条失败提交恢复，其他项目继续运行'); }
        continue;
      }
      this.active.set(run.projectId, run.runId);
      const job = this.execute(run).catch(() => { this.closed = true; this.journalError = '持久化失败，已停止维护，请检查数据目录。'; }).finally(() => { this.active.delete(run.projectId); this.jobs.delete(job); this.pump(); });
      this.jobs.add(job);
    }
  }
  async execute(run) {
    if (run.promotedAt) { await this.index(run); return; }
    this.store.updateRun(run.runId, { state: 'running', phase: 'preparing' });
    this.notify(run, '准备提交证据');
    try {
      const project = this.store.getProject(run.projectId);
      const canonicalPath = realpathWithMissingLeaf(project.knowledgePath);
      const targetKey = crypto.createHash('sha256').update(process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath).digest('hex');
      const result = await AtomicFile.withFileLock(this.layout.getRuntimePath('locks', `${targetKey}.lock`), async () => {
        const state = this.store.readRuntime(run.projectId);
        if (state.lastAnalyzedCommit === run.commitSha) return { ok: true, recovered: true };
        return this.reconciler.processCommitEvent({ projectId: run.projectId, commitSha: run.commitSha, operationId: run.runId });
      }, { timeoutMs: 15 * 60 * 1000 });
      if (!result.ok) throw Object.assign(new Error(result.error?.message || '知识维护失败。'), result.error);
      const claimRunId = result.runId || run.analysisRunId;
      let staging = null;
      if (claimRunId && fs.existsSync(this.promotion.manifestPath(run.projectId, claimRunId))) staging = this.promotion.readManifest(run.projectId, claimRunId);
      this.store.updateRun(run.runId, { phase: 'promoted', promotedAt: new Date().toISOString(), staging });
      const memoryCapture = this.memories.capture(run);
      this.store.updateRun(run.runId, { memoryCapture });
      if (memoryCapture.rejected.length) await this.diagnostics.warn('knowledge.memory.candidate_rejected', '部分记忆候选依据无效，未放入候选箱；有效知识已保留。', { projectId: run.projectId, runId: run.runId, operationId: run.runId, commitSha: run.commitSha, phase: 'memory-capture', context: memoryCapture });
      this.notify(run, '知识已晋升，正在更新索引');
      await this.index(run);
    } catch (error) {
      const failedPhase = error.phase || this.store.getRun(run.runId).phase;
      const message = this.safeMessage(error.message || '知识维护失败，证据与原知识已保留。');
      await this.diagnostics.error('knowledge.maintenance.failed', '知识维护失败，证据与原知识已保留。', { projectId: run.projectId, runId: run.runId, operationId: run.runId, commitSha: run.commitSha, phase: failedPhase, error });
      this.store.updateRun(run.runId, { state: 'failed', phase: 'failed', finishedAt: new Date().toISOString(), error: { code: error.code || 'ANALYSIS_FAILED', message, phase: failedPhase, retryable: error.retryable === true } });
      this.notify(run, '知识维护失败');
    }
  }
  async index(run) {
    const project = this.store.getProject(run.projectId);
    const attempt = (run.indexAttempts || 0) + 1;
    const context = { projectId: run.projectId, runId: run.runId, operationId: run.runId, commitSha: run.commitSha, phase: 'indexing' };
    try {
      this.store.updateRun(run.runId, { phase: 'indexing', indexState: 'running', indexAttempts: attempt });
      await requestIndex({ baseUrl: this.vectorUrl, route: '/api/sync', body: { project: project.vectorProjectId || project.projectId, sourceDir: project.knowledgePath }, attempt, sanitize: this.safeMessage });
      await this.store.updateRuntime(run.projectId, state => { state.index.dirty = false; state.index.status = 'ready'; });
      this.store.updateRun(run.runId, { state: 'succeeded', phase: 'ready', indexState: 'succeeded', error: null, finishedAt: new Date().toISOString() });
      await this.diagnostics.info('knowledge.index.completed', '知识向量索引已更新。', { ...context, context: { attempt } });
      this.notify(run, '知识已更新并可检索');
    } catch (error) {
      const details = error.details || { failureKind: 'LOCAL_ERROR', upstreamCode: error.code || 'UNKNOWN', upstreamMessage: this.safeMessage(error.message), attempt };
      await this.diagnostics.error('knowledge.index.failed', '知识已更新，向量索引失败。', { ...context, error, context: details });
      this.store.updateRun(run.runId, { state: 'index-pending', phase: 'index-pending', indexState: 'failed', finishedAt: new Date().toISOString(), error: { code: 'INDEX_FAILED', message: '知识已更新，索引待修复。', retryable: true, details } });
      this.notify(run, '知识已更新，索引待修复');
    }
  }
  syncSharedIndexes() { for (const scope of this.store.state.sharedScopes) this.indexSharedScope(scope).catch(() => {}); }
  async indexSharedScope(scope) {
    if (this.closed) return;
    if (this.sharedIndexJobs.has(scope.id)) { this.sharedIndexDirty.add(scope.id); return this.sharedIndexJobs.get(scope.id); }
    // Shared updates are small but may be numerous; serialize imports rather
    // than burst model requests for every domain after startup.
    const job = this.sharedIndexQueue.catch(() => {}).then(async () => {
      if (this.closed || !this.store.state.sharedScopes.some(s => s.id === scope.id)) return;
      let index;
      const attempt = (this.store.state.sharedScopes.find(s => s.id === scope.id)?.index?.attempts || 0) + 1;
      try {
        const files = require('./runtime/markdown-knowledge-indexer').listMarkdownFiles(scope.knowledgePath);
        const digest = crypto.createHash('sha256');
        for (const file of files.sort()) {
          if (!this.layout.isPathInside(scope.knowledgePath, file, { realpath: true })) continue;
          digest.update(path.relative(scope.knowledgePath, file)).update('\0').update(fs.readFileSync(file));
        }
        const fingerprint = digest.digest('hex');
        const current = this.store.state.sharedScopes.find(s => s.id === scope.id);
        if (!current) return;
        if (current.index?.status === 'ready' && current.index.fingerprint === fingerprint) {
          const health = await fetch(new URL('/api/projects', this.vectorUrl), { signal: AbortSignal.timeout(8000) });
          const payload = await health.json();
          if (health.ok && payload.projects?.some(p => p.name === `scope-${scope.kind}-${scope.id}` && p.hasIndex && this.layout.pathsEqual(p.sourceDir || '', scope.knowledgePath))) { if (!this.sharedIndexDirty.has(scope.id)) this.memoryIndexUpdates.delete(scope.id); return; }
        }
        await requestIndex({ baseUrl: this.vectorUrl, route: '/api/import', body: { projectName: `scope-${scope.kind}-${scope.id}`, sourceDir: scope.knowledgePath, watch: false }, attempt, sanitize: this.safeMessage });
        index = { status: 'ready', fingerprint, attempts: attempt, updatedAt: new Date().toISOString() };
      } catch (error) {
        const details = error.details || { failureKind: 'LOCAL_ERROR', upstreamCode: error.code || 'UNKNOWN', upstreamMessage: this.safeMessage(error.message), attempt };
        index = { status: 'pending', message: '共享知识已保存，索引待恢复。', attempts: attempt, error: { code: 'INDEX_FAILED', details } };
        await this.diagnostics.error('knowledge.shared_index.failed', index.message, { phase: 'indexing', operationId: `scope-index-${scope.id}-${attempt}`, error, context: { scopeId: scope.id, ...details } });
      }
      // Configuration can replace projection objects while the import awaits.
      const current = this.store.state.sharedScopes.find(s => s.id === scope.id);
      if (!current) return;
      const changed = current.index?.status !== index.status || current.index?.fingerprint !== index.fingerprint;
      current.index = index;
      this.store.save();
      if (!this.sharedIndexDirty.has(scope.id)) this.memoryIndexUpdates.delete(scope.id);
      if (changed) this.emit('progress', this.store.addEvent({ type: 'scope.index', brainId: scope.brainId, scopeId: scope.id, summary: current.index.status === 'ready' ? '共享知识索引已更新' : current.index.message }));
    }).finally(() => { this.sharedIndexJobs.delete(scope.id); if (this.sharedIndexDirty.delete(scope.id) && !this.closed) this.indexSharedScope(scope).catch(() => {}); });
    this.sharedIndexQueue = job;
    this.sharedIndexJobs.set(scope.id, job); return job;
  }
  retry(id) {
    const run = this.store.getRun(id);
    if (!run || !['failed', 'index-pending'].includes(run.state)) throw Object.assign(new Error('只有失败或索引待修复的运行可以重试。'), { status: 409 });
    this.store.updateRun(id, { state: 'queued', phase: run.promotedAt ? 'index-pending' : 'queued', finishedAt: null, error: null, debugFailure: false });
    this.pump();
    return run;
  }
  async close() {
    await this.memories.close();
    this.closed = true; clearInterval(this.poll);
    this.bridge.close?.();
    await this.analyzer.close?.();
    // A consumer may still be persisting evidence or an ACK. Keep the writer
    // lease until that work settles; the next process must never overlap it.
    await Promise.all([this.drainJob, ...this.jobs, ...this.sharedIndexJobs.values()]);
    await this.diagnostics.close?.();
    this.removeAllListeners(); this.profiles.clear();
  }
}

module.exports = { EngineCoordinator };
