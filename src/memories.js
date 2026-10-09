'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('./runtime/atomic-file');
const { RuntimeLayout } = require('./runtime/layout');
const { validateProjectId, DomainError } = require('./runtime/contracts');

class MemoryService {
  constructor(store, options = {}) { this.store = store; this.layout = new RuntimeLayout(store.dataDir); this.onMaterialized = options.onMaterialized; }
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
  list({ brainId, status } = {}) { return this.store.state.memories.filter(m => (!brainId || m.brainId === brainId) && (!status || m.status === status)); }
  capture(run) {
    const project = this.store.getProject(run.projectId);
    if (!project || !run.promotedAt) return;
    const candidates = Array.isArray(run.staging?.memoryCandidates) ? run.staging.memoryCandidates : [];
    for (const raw of candidates.slice(0, 20)) {
      if (!raw || typeof raw !== 'object') continue;
      const text = String(raw.text || '').trim();
      const quote = String(raw.quote || '').trim();
      const entryId = String(raw.entryId || '');
      const file = path.resolve(project.knowledgePath, entryId);
      if (!text || text.length > 2000 || quote.length < 8 || !run.staging.operations?.some(op => op.operation !== 'delete' && op.path === entryId) || !this.layout.isPathInside(project.knowledgePath, file, { realpath: true }) || !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(quote)) continue;
      const fingerprint = crypto.createHash('sha256').update(`${project.brainId || 'brain-default'}:${text.toLowerCase().replace(/\s+/g, ' ')}`).digest('hex');
      if (this.store.state.memories.some(m => m.fingerprint === fingerprint)) continue;
      this.store.state.memories.push({ id: `memory-${crypto.randomUUID()}`, fingerprint, brainId: project.brainId || 'brain-default', domainId: project.domainId || null, text, status: 'candidate', evidence: { projectId: project.projectId, commitSha: run.commitSha, runId: run.runId, entryId, quote }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.store.save();
  }
  async update(id, input) {
    return AtomicFile.withFileLock(this.layout.getRuntimePath('locks', 'memories.lock'), async () => {
      const memory = this.store.state.memories.find(m => m.id === id);
      if (!memory) throw new DomainError('PROJECT_NOT_FOUND', '记忆不存在。', { status: 404 });
      if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000)) throw new DomainError('INVALID_ARGUMENT', '记忆内容必须为 1–2000 个字符。');
      if (input.status !== undefined && !['confirmed', 'ignored'].includes(input.status)) throw new DomainError('INVALID_ARGUMENT', '记忆状态无效。');
      if (memory.status === 'ignored') throw new DomainError('INVALID_ARGUMENT', '该候选已忽略。', { status: 409 });
      if (input.status === 'confirmed' && !this.store.state.sharedScopes.some(s => s.kind === 'brain' && s.brainId === memory.brainId)) throw new DomainError('INVALID_ARGUMENT', '请先绑定智脑共享目录。', { status: 409 });
      Object.assign(memory, { text: input.text?.trim() || memory.text, status: input.status || memory.status, updatedAt: new Date().toISOString() });
      // Persist confirmation before writing. Retrieval verifies the materialized
      // file against this state, so a crash cannot inject unconfirmed content.
      this.store.save();
      await this.recover();
      return memory;
    });
  }
  content(brainId) {
    return '# 已确认的长期记忆\n\n' + this.list({ brainId, status: 'confirmed' }).map(m => `## ${m.id}\n\n${m.text}\n\n来源：${m.evidence.projectId} · ${m.evidence.commitSha} · ${m.evidence.entryId}\n`).join('\n');
  }
  file(scope) { return path.join(scope.knowledgePath, 'memories', 'confirmed.md'); }
  async recover() {
    for (const scope of this.store.state.sharedScopes.filter(s => s.kind === 'brain')) {
      const file = this.file(scope);
      if (!this.layout.isPathInside(scope.knowledgePath, file, { realpath: true }) || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new DomainError('PATH_OUTSIDE_ROOT', '记忆文件目录越界。', { status: 403 });
      const content = this.content(scope.brainId);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
        AtomicFile.writeFileAtomic(file, content);
        await this.onMaterialized?.(scope);
      }
    }
  }
  validFile(scope) { const file = this.file(scope); return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === this.content(scope.brainId); }
}
module.exports = { MemoryService };
