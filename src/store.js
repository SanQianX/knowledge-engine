'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateProjectId } = require('./runtime/contracts');
const { RuntimeLayout } = require('./runtime/layout');
const AtomicFile = require('./runtime/atomic-file');

/**
 * 单文件 JSON 状态层（<data>/engine-state.json）：注册项目、分析运行、事件流。
 * 任务、消费游标与受控写入元数据一起原子落盘，运行期凭据不进入本层。
 */
class EngineStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'engine-state.json');
    this.state = { schemaVersion: 3, projects: [], runs: [], events: [], cursor: 0, journalCursors: {}, memories: [], sharedScopes: [] };
    if (!options.deferLoad) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.schemaVersion !== 3) throw Object.assign(new Error('不再读取旧版引擎数据，请使用新的空数据目录重新导入项目。'), { code: 'SCHEMA_UNSUPPORTED' });
      if (!raw || !Array.isArray(raw.projects) || !Array.isArray(raw.runs) || !Array.isArray(raw.events) || !Number.isSafeInteger(raw.cursor) || raw.cursor < 0) throw new Error('Invalid engine state');
      if (raw.memories && !Array.isArray(raw.memories) || raw.sharedScopes && !Array.isArray(raw.sharedScopes) || raw.journalCursors && (typeof raw.journalCursors !== 'object' || Array.isArray(raw.journalCursors))) throw new Error('Invalid engine projections');
      const ids = new Set();
      for (const project of raw.projects) {
        validateProjectId(project.projectId);
        if (ids.has(project.projectId) || !path.isAbsolute(project.repoPath || '') || !path.isAbsolute(project.knowledgePath || '') || !project.runtime?.analysis || !project.runtime?.index) throw new Error('Invalid project runtime');
        ids.add(project.projectId);
      }
      const runIds = new Set();
      for (const run of raw.runs) {
        validateProjectId(run.projectId);
        if (!/^run-[a-f0-9-]{36}$/.test(run.runId || '') || runIds.has(run.runId) || !/^[a-f0-9]{40}$/.test(run.commitSha || '') || !['queued', 'running', 'failed', 'succeeded', 'index-pending', 'cancelled'].includes(run.state) || !Number.isSafeInteger(run.sequence) || run.sequence < 1) throw new Error('Invalid queued run');
        runIds.add(run.runId);
      }
      for (const [journalId, sequence] of Object.entries(raw.journalCursors || {})) if (!/^(global|sha256:[a-f0-9]{64})$/.test(journalId) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid journal cursor');
      for (const scope of raw.sharedScopes || []) if (!scope || !['brain', 'domain'].includes(scope.kind) || !path.isAbsolute(scope.knowledgePath || '')) throw new Error('Invalid shared scope');
      for (const memory of raw.memories || []) {
        if (!memory || !['candidate', 'confirmed', 'ignored'].includes(memory.status) || typeof memory.text !== 'string' || memory.sourceType !== undefined && !['manual', 'agent'].includes(memory.sourceType)) throw new Error('Invalid memory record');
        if (memory.sourceType === 'manual') {
          validateProjectId(memory.brainId);
          if (memory.status === 'candidate' || !memory.text.trim() || memory.text.length > 2000 || !memory.scopeType || memory.evidence !== null || !Number.isFinite(Date.parse(memory.createdAt)) || !Number.isFinite(Date.parse(memory.updatedAt))) throw new Error('Invalid manual memory record');
        } else if (!memory.evidence?.projectId || !/^[a-f0-9]{40}$/.test(memory.evidence.commitSha || '')) throw new Error('Invalid memory evidence');
      }
      for (const memory of raw.memories || []) if (memory.scopeType !== undefined || memory.scopeId !== undefined) {
        if (!['global', 'domain', 'project'].includes(memory.scopeType)) throw new Error('Invalid memory scope');
        validateProjectId(memory.scopeId);
        if (memory.scopeType === 'global' && memory.scopeId !== (memory.brainId || 'brain-default')) throw new Error('Invalid global memory target');
      }
      this.state = { ...this.state, ...raw };
    } catch (error) {
      if (error.code === 'SCHEMA_UNSUPPORTED') throw error;
      if (error.code !== 'ENOENT') throw Object.assign(new Error('引擎状态损坏，已保留原文件；请从备份恢复。'), { code: 'DATA_CORRUPT', cause: error });
    }
  }

  isEmpty() {
    return this.state.projects.length === 0 && this.state.runs.length === 0;
  }

  replace(next) {
    this.state = next;
    this.save();
  }

  save() {
    // Windows scanners/readers may briefly hold the destination; never unlink
    // durable state to force a replace, or share a fixed temp name with writers.
    AtomicFile.writeJsonAtomic(this.file, this.state);
  }

  listProjects() {
    return this.state.projects.slice();
  }

  getProject(projectId) {
    return this.state.projects.find(p => p.projectId === projectId) || null;
  }

  addProject(input) {
    validateProjectId(input.projectId);
    const layout = new RuntimeLayout(this.dataDir);
    if (!path.isAbsolute(input.repoPath || '') || !path.isAbsolute(input.knowledgePath || '')) throw Object.assign(new Error('代码目录和知识目录必须为绝对路径。'), { status: 400, code: 'INVALID_ARGUMENT' });
    const existing = this.getProject(input.projectId);
    if (input.knowledgeLanguage !== undefined && !['zh-CN', 'en-US'].includes(input.knowledgeLanguage)) throw Object.assign(new Error('知识语言无效。'), { status: 400, code: 'INVALID_ARGUMENT' });
    if (this.state.runs.some(r => r.projectId === input.projectId && ['queued', 'running'].includes(r.state)) && existing
      && (!layout.pathsEqual(existing.repoPath, input.repoPath) || !layout.pathsEqual(existing.knowledgePath, input.knowledgePath))) throw Object.assign(new Error('运行中不能改变目录绑定。'), { status: 409, code: 'PROJECT_BUSY' });
    for (const project of this.state.projects) {
      if (project.projectId !== input.projectId && (layout.isPathInside(project.knowledgePath, input.knowledgePath, { realpath: true }) || layout.isPathInside(input.knowledgePath, project.knowledgePath, { realpath: true }))) throw Object.assign(new Error('知识目录与已登记项目冲突。'), { status: 409, code: 'KNOWLEDGE_PATH_CONFLICT' });
    }
    for (const scope of this.state.sharedScopes) {
      if (layout.isPathInside(scope.knowledgePath, input.knowledgePath, { realpath: true }) || layout.isPathInside(input.knowledgePath, scope.knowledgePath, { realpath: true })) throw Object.assign(new Error('项目目录不能占用共享知识目录。'), { status: 409, code: 'KNOWLEDGE_PATH_CONFLICT' });
    }
    // Registration is a projection, not a second settings/credential store.
    const fields = { projectId: input.projectId, name: input.name || input.projectId, repoPath: path.resolve(input.repoPath), knowledgePath: path.resolve(input.knowledgePath), brainId: input.brainId || existing?.brainId || 'brain-default', knowledgeLanguage: input.knowledgeLanguage || existing?.knowledgeLanguage || 'zh-CN', enabled: input.enabled !== false };
    for (const key of ['brainId', 'domainId', 'journalId', 'vectorProjectId', 'profileId', 'trackingStartCommit']) {
      if (input[key] !== undefined) fields[key] = input[key] === null ? null : String(input[key]);
    }
    if (input.relatedProjectIds) fields.relatedProjectIds = input.relatedProjectIds.map(validateProjectId);
    if (Number.isSafeInteger(input.conversationBaselineCursor)) fields.conversationBaselineCursor = input.conversationBaselineCursor;
    if (input.conversationBaselineCursors) fields.conversationBaselineCursors = Object.fromEntries(Object.entries(input.conversationBaselineCursors).map(([id, cursor]) => {
      if (!/^(global|sha256:[a-f0-9]{64})$/.test(id) || !Number.isSafeInteger(cursor) || cursor < 0) throw Object.assign(new Error('会话跟踪基线无效。'), { status: 400, code: 'INVALID_ARGUMENT' });
      return [id, cursor];
    }));
    if (input.repoIdentity) fields.repoIdentity = Object.fromEntries(['schema', 'workspaceId', 'workspaceRoot', 'commonDir', 'remote'].map(key => [key, input.repoIdentity[key] == null ? null : String(input.repoIdentity[key])]));
    if (existing) {
      const priorBaselines = { ...(existing.runtime.conversationBaselineCursors || {}) };
      if (!Object.hasOwn(priorBaselines, 'global')) priorBaselines.global = existing.runtime.conversationBaselineCursor ?? 0;
      for (const [journalId, cursor] of Object.entries(fields.conversationBaselineCursors || {})) if (!Object.hasOwn(priorBaselines, journalId)) priorBaselines[journalId] = cursor;
      existing.runtime.conversationBaselineCursors = priorBaselines;
      delete fields.conversationBaselineCursor;
      delete fields.conversationBaselineCursors;
      Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
      this.save();
      return { project: existing, reused: true };
    }
    const project = {
      ...fields,
      runtime: initialRuntime(input),
      lastCommitSha: null,
      lastRunAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state.projects.push(project);
    this.save();
    return { project, reused: false };
  }

  removeProject(projectId) {
    if (this.state.runs.some(r => r.projectId === projectId && r.state === 'running')) throw Object.assign(new Error('此项目正在执行知识维护，请等待写入结束后再解绑。'), { status: 409, code: 'PROJECT_BUSY' });
    const before = this.state.projects.length;
    const now = new Date().toISOString();
    const cancelled = this.state.runs.filter(r => r.projectId === projectId && r.state === 'queued');
    for (const run of cancelled) Object.assign(run, { state: 'cancelled', phase: 'cancelled', finishedAt: now, cancellationReason: 'project-unbound' });
    this.state.projects = this.state.projects.filter(p => p.projectId !== projectId);
    this.save();
    return { removed: this.state.projects.length < before, cancelledRuns: cancelled.length };
  }

  listRuns(projectId) {
    const runs = projectId
      ? this.state.runs.filter(r => r.projectId === projectId)
      : this.state.runs;
    return runs.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  getRun(runId) {
    return this.state.runs.find(r => r.runId === runId) || null;
  }

  listRunPage({ projectId, limit = 50, before } = {}) {
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before != null && !/^[1-9]\d*$/.test(String(before))) throw Object.assign(new Error('运行分页参数无效。'), { status: 400, code: 'INVALID_ARGUMENT' });
    const all = this.state.runs.filter(run => !projectId || run.projectId === projectId);
    const rows = all.filter(run => before == null || run.sequence < Number(before)).sort((a, b) => b.sequence - a.sequence);
    const page = rows.slice(0, limit);
    return { runs: page.map(summaryRun), nextCursor: rows.length > limit ? String(page.at(-1).sequence) : null, total: all.length };
  }

  addRun(input) {
    if (!/^[a-f0-9]{40}$/i.test(input.commitSha || '')) throw Object.assign(new Error('必须提供完整的真实提交 SHA。'), { status: 400, code: 'INVALID_ARGUMENT' });
    const prior = this.state.runs.find(r => r.projectId === input.projectId && r.commitSha === input.commitSha.toLowerCase());
    if (prior) return prior;
    const run = {
      runId: 'run-' + crypto.randomUUID(),
      projectId: input.projectId,
      commitSha: input.commitSha.toLowerCase(),
      trigger: input.trigger || 'manual',
      note: input.note || '',
      state: 'queued',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      staging: null,
      phase: 'queued',
      sequence: this.state.runs.length + 1,
      indexState: 'pending',
      journalId: input.journalId || null,
      journalSequence: input.journalSequence || null,
    };
    this.state.runs.push(run);
    const project = this.getProject(input.projectId);
    if (project) {
      project.lastCommitSha = run.commitSha;
      project.lastRunAt = run.startedAt;
    }
    this.save();
    return run;
  }

  updateRun(runId, patch) {
    const run = this.getRun(runId);
    if (!run) return null;
    Object.assign(run, patch);
    if (run.finishedAt && run.state !== 'queued') {
      run.durationMs = Math.max(0, new Date(run.finishedAt) - new Date(run.startedAt));
    }
    this.save();
    return run;
  }

  addEvent(input) {
    const event = {
      seq: ++this.state.cursor,
      type: input.type,
      projectId: input.projectId || null,
      summary: input.summary || '',
      at: new Date().toISOString(),
      runId: input.runId || null,
      commitSha: input.commitSha || null,
      phase: input.phase || null,
    };
    this.state.events.push(event);
    if (this.state.events.length > 500) this.state.events = this.state.events.slice(-500);
    this.save();
    return event;
  }

  listEvents(limit) {
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    return this.state.events.slice(-cap).reverse();
  }

  readRuntime(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw Object.assign(new Error('项目未登记。'), { code: 'PROJECT_NOT_FOUND', status: 404 });
    return structuredClone(project.runtime || initialRuntime(project));
  }

  async updateRuntime(projectId, fn) {
    const project = this.getProject(projectId);
    const draft = this.readRuntime(projectId);
    const result = fn(draft);
    if (result && typeof result.then === 'function') throw new Error('Runtime mutations must be synchronous');
    project.runtime = draft;
    this.save();
    return structuredClone(draft);
  }

  setJournalCursor(journalId, sequence) {
    this.state.journalCursors[journalId] = Math.max(this.state.journalCursors[journalId] || 0, sequence);
    this.save();
  }
}

function initialRuntime(project = {}) { return { lastAnalyzedCommit: project.trackingStartCommit || null, conversationBaselineCursor: project.conversationBaselineCursor ?? null, conversationBaselineCursors: project.conversationBaselineCursors || {}, consumedRequirements: [], analysis: { status: 'idle', activeClaim: null, lastError: null }, index: { generation: 0, dirty: false, status: 'pending' } }; }

function summaryRun(run) {
  return Object.fromEntries(['runId', 'projectId', 'commitSha', 'sequence', 'state', 'phase', 'trigger', 'startedAt', 'finishedAt', 'promotedAt', 'indexState', 'error', 'memoryCapture'].filter(key => run[key] !== undefined).map(key => [key, run[key]]));
}
module.exports = { EngineStore, initialRuntime, summaryRun };
