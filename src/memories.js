'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('./runtime/atomic-file');
const { RuntimeLayout } = require('./runtime/layout');
const { validateProjectId, DomainError } = require('./runtime/contracts');

const TYPES = ['global', 'domain', 'project'];
const normalized = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const fingerprint = (brainId, type, id, text) => crypto.createHash('sha256').update(`${brainId}:${type}:${id}:${normalized(text)}`).digest('hex');

class MemoryService {
  constructor(store, options = {}) {
    this.store = store; this.layout = new RuntimeLayout(store.dataDir); this.onMaterialized = options.onMaterialized;
    this.syncErrors = new Map(); this.closed = false; this.onSyncChange = options.onSyncChange; this.writes = new Set();
    this.getIndexStatus = options.getIndexStatus;
  }
  lock() { return this.layout.getRuntimePath('locks', 'memories.lock'); }
  scopeOf(memory) { return { type: memory.scopeType || 'global', id: memory.scopeId || memory.brainId || 'brain-default' }; }
  brainScope(brainId) { return this.store.state.sharedScopes.find(s => s.kind === 'brain' && s.brainId === brainId); }
  target(memory) {
    const scope = this.scopeOf(memory), brainId = memory.brainId || 'brain-default';
    const target = scope.type === 'global' ? this.brainScope(brainId) : scope.type === 'domain'
      ? this.store.state.sharedScopes.find(s => s.kind === 'domain' && s.id === scope.id && s.brainId === brainId)
      : this.store.listProjects().find(p => p.projectId === scope.id && p.brainId === brainId && p.enabled !== false);
    return { name: target?.name || scope.id, available: Boolean(target) };
  }
  validateScope(type, id, brainId) {
    if (!TYPES.includes(type)) throw new DomainError('INVALID_ARGUMENT', '适用范围无效。');
    validateProjectId(id);
    if (type === 'global' && id !== brainId || type !== 'global' && !this.target({ brainId, scopeType: type, scopeId: id }).available) throw new DomainError('INVALID_ARGUMENT', '所选记忆目标不存在或不属于当前智脑。');
  }
  entry(memory) {
    const scope = this.scopeOf(memory);
    if (scope.type === 'global') return 'memories/confirmed.md';
    validateProjectId(scope.id);
    return `memories/${scope.type === 'domain' ? 'domains' : 'projects'}/${scope.id}.md`;
  }
  descriptor(entry) {
    if (entry === 'memories/confirmed.md') return { type: 'global' };
    const match = /^memories\/(domains|projects)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/.exec(entry);
    if (!match) return null;
    try { validateProjectId(match[2]); } catch { return null; }
    return { type: match[1] === 'domains' ? 'domain' : 'project', id: match[2] };
  }
  file(scope, entry = 'memories/confirmed.md') { return path.join(scope.knowledgePath, ...entry.split('/')); }
  safeFile(scope, entry) {
    const file = this.file(scope, entry);
    if (!this.descriptor(entry) || !this.layout.isPathInside(scope.knowledgePath, file, { realpath: true }) || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new DomainError('PATH_OUTSIDE_ROOT', '记忆文件目录越界。', { status: 403 });
    return file;
  }
  confirmed(brainId, entry) { return this.store.state.memories.filter(m => m.status === 'confirmed' && (m.brainId || 'brain-default') === brainId && this.entry(m) === entry); }
  applicable(memory, project) {
    if (!project || memory.status !== 'confirmed' || (memory.brainId || 'brain-default') !== project.brainId || !this.target(memory).available) return false;
    const scope = this.scopeOf(memory);
    return scope.type === 'global' || scope.type === 'domain' && scope.id === project.domainId || scope.type === 'project' && scope.id === project.projectId;
  }
  readableEntry(scope, entry, project) {
    return scope.kind === 'brain' && !this.syncErrors.has(scope.id) && this.validFile(scope, entry) && this.confirmed(scope.brainId, entry).some(m => this.applicable(m, project));
  }
  memoryForChunk(scope, entry, heading) {
    return this.confirmed(scope.brainId, entry).find(m => (Array.isArray(heading) ? heading : String(heading).split(' > ')).includes(m.id));
  }
  project(memory) {
    const scope = this.scopeOf(memory), target = this.target(memory), brain = this.brainScope(memory.brainId || 'brain-default');
    return { ...memory, scopeType: scope.type, scopeId: scope.id, targetName: target.name, targetAvailable: target.available,
      syncStatus: memory.status !== 'confirmed' ? 'not-required' : brain && !this.syncErrors.has(brain.id) && this.validFile(brain, this.entry(memory)) ? 'ready' : 'pending',
      indexStatus: memory.status === 'confirmed' ? this.getIndexStatus?.(brain) || (brain?.index?.error ? 'failed' : brain?.index?.status || 'pending') : 'not-required',
      ...(brain && this.syncErrors.has(brain.id) ? { syncError: this.syncErrors.get(brain.id) } : {}) };
  }
  async configure(scopes) {
    if (!Array.isArray(scopes)) throw new DomainError('INVALID_ARGUMENT', '共享范围必须是数组。');
    const ids = new Set();
    const projected = scopes.map(scope => {
      validateProjectId(scope.id); validateProjectId(scope.brainId);
      if (scope.domainId) validateProjectId(scope.domainId);
      if (ids.has(scope.id) || !['brain', 'domain'].includes(scope.kind) || !path.isAbsolute(scope.knowledgePath || '')) throw new DomainError('INVALID_ARGUMENT', '共享范围绑定无效。');
      ids.add(scope.id);
      const index = this.store.state.sharedScopes.find(s => s.id === scope.id)?.index;
      return { id: scope.id, kind: scope.kind, brainId: scope.brainId, domainId: scope.domainId || null, name: String(scope.name || scope.id), knowledgePath: path.resolve(scope.knowledgePath), ...(index ? { index } : {}) };
    });
    const overlaps = (a, b) => this.layout.isPathInside(a, b, { realpath: true }) || this.layout.isPathInside(b, a, { realpath: true });
    for (const scope of projected) {
      if (this.store.listProjects().some(p => overlaps(p.knowledgePath, scope.knowledgePath) || overlaps(p.repoPath, scope.knowledgePath)) || projected.some(s => s.id !== scope.id && overlaps(s.knowledgePath, scope.knowledgePath))) throw new DomainError('PATH_OUTSIDE_ROOT', '共享目录与其他知识或代码目录冲突。', { status: 409 });
      const prior = this.store.state.sharedScopes.find(s => s.id === scope.id);
      if (prior && !this.layout.pathsEqual(prior.knowledgePath, scope.knowledgePath)) throw new DomainError('IMMUTABLE_FIELD', '共享目录已绑定，不能隐式移动知识。', { status: 409 });
    }
    // The shell remains the registry owner; this is a whitelisted projection.
    this.store.state.sharedScopes = projected; this.store.save();
    for (const scope of projected) fs.mkdirSync(scope.knowledgePath, { recursive: true });
    await this.recover();
    return projected;
  }
  list({ brainId, status, scopeType, scopeId } = {}) {
    if (scopeType && !TYPES.includes(scopeType)) throw new DomainError('INVALID_ARGUMENT', '记忆筛选范围无效。');
    return this.store.state.memories.filter(m => (!brainId || m.brainId === brainId) && (!status || m.status === status) && (!scopeType || this.scopeOf(m).type === scopeType) && (!scopeId || this.scopeOf(m).id === scopeId)).map(m => this.project(m));
  }
  capture(run) {
    const report = { accepted: 0, deduplicated: 0, rejected: [] };
    const project = this.store.getProject(run.projectId);
    if (!project || !run.promotedAt) return report;
    const candidates = Array.isArray(run.staging?.memoryCandidates) ? run.staging.memoryCandidates : [];
    const before = this.store.state.memories, next = [...before];
    for (const [index, raw] of candidates.slice(0, 20).entries()) {
      const reject = code => report.rejected.push({ index, code });
      if (!raw || typeof raw !== 'object') { reject('INVALID_CANDIDATE'); continue; }
      const text = String(raw.text || '').trim();
      const quote = String(raw.quote || '').trim();
      const entryId = String(raw.entryId || '');
      const file = path.resolve(project.knowledgePath, entryId);
      if (!text || text.length > 2000 || quote.length < 8) { reject('INVALID_TEXT_OR_QUOTE'); continue; }
      if (!run.staging.operations?.some(op => op.operation !== 'delete' && op.path === entryId)) { reject('ENTRY_NOT_PROMOTED'); continue; }
      if (!this.layout.isPathInside(project.knowledgePath, file, { realpath: true })) { reject('PATH_OUTSIDE_ROOT'); continue; }
      try { if (!fs.readFileSync(file, 'utf8').includes(quote)) { reject('QUOTE_MISMATCH'); continue; } }
      catch { reject('EVIDENCE_UNREADABLE'); continue; }
      const brainId = project.brainId || 'brain-default';
      const scopeType = raw.scopeType === 'global' ? 'global' : raw.scopeType === 'domain' && project.domainId ? 'domain' : 'project';
      const scopeId = scopeType === 'global' ? brainId : scopeType === 'domain' ? project.domainId : project.projectId;
      const key = fingerprint(brainId, scopeType, scopeId, text);
      if (next.some(m => m.captureFingerprint === key || fingerprint(m.brainId || 'brain-default', this.scopeOf(m).type, this.scopeOf(m).id, m.text) === key || !m.scopeType && m.evidence.projectId === project.projectId && normalized(m.originalText || m.text) === normalized(text))) { report.deduplicated++; continue; }
      next.push({ id: `memory-${crypto.randomUUID()}`, fingerprint: key, captureFingerprint: key, brainId, domainId: project.domainId || null, scopeType, scopeId, text, originalText: text, status: 'candidate', evidence: { projectId: project.projectId, commitSha: run.commitSha, runId: run.runId, entryId, quote }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      report.accepted++;
    }
    if (report.accepted) {
      this.store.state.memories = next;
      try { this.store.save(); } catch (error) { this.store.state.memories = before; throw error; }
    }
    return report;
  }
  async update(id, input) {
    if (this.closed) throw new DomainError('PROJECT_BUSY', '引擎正在关闭，请稍后重试。', { status: 409 });
    if (Object.keys(input).some(key => !['text', 'status', 'scopeType', 'scopeId'].includes(key))) throw new DomainError('INVALID_ARGUMENT', '来源证据和文件路径不能修改。');
    const job = AtomicFile.withFileLock(this.lock(), async () => {
      const memory = this.store.state.memories.find(m => m.id === id);
      if (!memory) throw new DomainError('PROJECT_NOT_FOUND', '记忆不存在。', { status: 404 });
      if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000)) throw new DomainError('INVALID_ARGUMENT', '记忆内容必须为 1–2000 个字符。');
      if (input.status !== undefined && !['confirmed', 'ignored'].includes(input.status)) throw new DomainError('INVALID_ARGUMENT', '记忆状态无效。');
      if (memory.status === 'ignored') throw new DomainError('INVALID_ARGUMENT', '该候选已忽略。', { status: 409 });
      const brainId = memory.brainId || 'brain-default', old = this.scopeOf(memory);
      const type = input.scopeType === undefined ? old.type : input.scopeType;
      const targetId = input.scopeId === undefined ? (type === 'global' ? brainId : type === old.type ? old.id : '') : input.scopeId;
      if (input.status !== 'ignored' || input.scopeType !== undefined || input.scopeId !== undefined) this.validateScope(type, targetId, brainId);
      if ((input.status || memory.status) === 'confirmed' && !this.brainScope(brainId)) throw new DomainError('INVALID_ARGUMENT', '请先绑定智脑共享目录。', { status: 409 });
      const text = input.text?.trim() || memory.text, key = fingerprint(brainId, type, targetId, text);
      if (this.store.state.memories.some(m => m.id !== id && fingerprint(m.brainId || 'brain-default', this.scopeOf(m).type, this.scopeOf(m).id, m.text) === key)) throw new DomainError('MEMORY_DUPLICATE', '该范围内已存在相同记忆。', { status: 409 });
      const next = { ...memory, originalText: memory.originalText || memory.text, captureFingerprint: memory.captureFingerprint || fingerprint(brainId, old.type, old.id, memory.originalText || memory.text), fingerprint: key, scopeType: type, scopeId: targetId, text, status: input.status || memory.status, updatedAt: new Date().toISOString() };
      const before = this.store.state.memories;
      this.store.state.memories = before.map(m => m.id === id ? next : m);
      try { this.store.save(); } catch (error) { this.store.state.memories = before; throw error; }
      await this.materialize(); return this.project(next);
    });
    this.writes.add(job);
    try { return await job; } finally { this.writes.delete(job); }
  }
  content(brainId, entry = 'memories/confirmed.md') {
    return '# 已确认的长期记忆\n\n' + this.confirmed(brainId, entry).map(m => {
      const scope = this.scopeOf(m);
      // Preserve legacy global bytes until the user actually edits that record.
      const scopeText = m.scopeType ? `适用范围：${{ global: '全局', domain: '领域', project: '项目' }[scope.type]} · ${scope.id}\n\n` : '';
      const text = m.scopeType ? m.text.replace(/^\s*(#{1,6})\s/gm, '\\$1 ') : m.text;
      return `## ${m.id}\n\n${scopeText}${text}\n\n来源：${m.evidence.projectId} · ${m.evidence.commitSha} · ${m.evidence.entryId}\n`;
    }).join('\n');
  }
  existingEntries(scope) {
    const entries = new Set(['memories/confirmed.md']);
    for (const group of ['domains', 'projects']) {
      const directory = path.join(scope.knowledgePath, 'memories', group);
      if (!fs.existsSync(directory)) continue;
      if (fs.lstatSync(directory).isSymbolicLink() || !this.layout.isPathInside(scope.knowledgePath, directory, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', '记忆目录越界。', { status: 403 });
      for (const name of fs.readdirSync(directory)) if (this.descriptor(`memories/${group}/${name}`)) entries.add(`memories/${group}/${name}`);
    }
    for (const memory of this.store.state.memories.filter(m => m.status === 'confirmed' && (m.brainId || 'brain-default') === scope.brainId)) entries.add(this.entry(memory));
    return entries;
  }
  async materialize() {
    clearTimeout(this.retryTimer);
    for (const scope of this.store.state.sharedScopes.filter(s => s.kind === 'brain')) {
      try {
        let changed = false;
        for (const entry of this.existingEntries(scope)) {
          const file = this.safeFile(scope, entry), content = this.content(scope.brainId, entry);
          if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) { AtomicFile.writeFileAtomic(file, content); changed = true; }
        }
        const recovered = this.syncErrors.delete(scope.id);
        if (recovered) this.onSyncChange?.(scope, null);
        if (changed) await this.onMaterialized?.(scope);
      } catch (error) {
        const code = error.code || 'MEMORY_WRITE_FAILED', prior = this.syncErrors.get(scope.id);
        this.syncErrors.set(scope.id, code);
        if (prior !== code) this.onSyncChange?.(scope, code);
      }
    }
    if (this.syncErrors.size && !this.closed) { this.retryTimer = setTimeout(() => this.recover().catch(() => {}), 5000); this.retryTimer.unref(); }
  }
  async recover() {
    if (this.recovery) return this.recovery;
    this.recovery = AtomicFile.withFileLock(this.lock(), () => this.materialize()).finally(() => { this.recovery = null; });
    return this.recovery;
  }
  validFile(scope, entry = 'memories/confirmed.md') {
    try { const file = this.safeFile(scope, entry); return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === this.content(scope.brainId, entry); } catch { return false; }
  }
  async close() { this.closed = true; clearTimeout(this.retryTimer); await Promise.allSettled([...this.writes, this.recovery].filter(Boolean)); }
}
module.exports = { MemoryService };
