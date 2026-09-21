'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 单文件 JSON 状态层（<data>/engine-state.json）：注册项目、分析运行、事件流。
 * 脚手架阶段整文件读写即可；接真管道后（reconciler 认领 / journal 消费游标）
 * 各自落盘，本类只保留同形 API 作兼容层。
 */
class EngineStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'engine-state.json');
    this.state = { projects: [], runs: [], events: [], cursor: 0 };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...raw };
    } catch {
      // 首次启动或文件缺失：保持空状态，由 server 决定是否灌入 seed。
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
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  listProjects() {
    return this.state.projects.slice();
  }

  getProject(projectId) {
    return this.state.projects.find(p => p.projectId === projectId) || null;
  }

  addProject(input) {
    const existing = this.getProject(input.projectId);
    if (existing) {
      Object.assign(existing, input, { updatedAt: new Date().toISOString() });
      this.save();
      return { project: existing, reused: true };
    }
    const project = {
      projectId: input.projectId,
      name: input.name || input.projectId,
      repoPath: input.repoPath || '',
      knowledgePath: input.knowledgePath || '',
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
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter(p => p.projectId !== projectId);
    this.save();
    return this.state.projects.length < before;
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

  addRun(input) {
    const run = {
      runId: 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      projectId: input.projectId,
      commitSha: input.commitSha || fakeSha(),
      trigger: input.trigger || 'manual',
      note: input.note || '',
      state: 'queued',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      staging: null,
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
}

function fakeSha() {
  let hex = '';
  for (let i = 0; i < 40; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

module.exports = { EngineStore, fakeSha };
