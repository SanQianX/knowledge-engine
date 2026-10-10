'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeRetrievalService } = require('./runtime/knowledge-retrieval-service');
const { listMarkdownFiles } = require('./runtime/markdown-knowledge-indexer');
const { DomainError } = require('./runtime/contracts');

class EngineRetrieval extends KnowledgeRetrievalService {
  constructor(options) { super(options); this.store = options.store; this.memories = options.memories; this.vectorUrl = options.vectorUrl || 'http://127.0.0.1:8787'; }
  signalSet(input = {}) {
    const signals = super.signalSet(input);
    const query = signals.indexQuery.trim().toLowerCase();
    if (/^[a-f0-9]{7,64}$/.test(query) && this.store.listRuns().some(run => run.promotedAt && run.commitSha?.startsWith(query))) signals.commitPrefix = query;
    return signals;
  }
  score(candidate, signals) {
    if (signals.commitPrefix) {
      // A known commit is an identifier, not a semantic topic. Unrelated
      // vector hits must not crowd its current, provenance-checked files out.
      const source = this.store.listRuns(candidate.projectId).find(run => run.promotedAt && run.staging?.operations?.some(operation => operation.path === candidate.entryId));
      if (!source?.commitSha?.startsWith(signals.commitPrefix)) return { score: 0, selectionSignals: [] };
      const result = super.score(candidate, signals);
      return { score: Math.max(1, result.score), selectionSignals: [...result.selectionSignals, 'exact-commit'] };
    }
    return super.score(candidate, signals);
  }
  resolve(input = {}) {
    let project = this.store.getProject(input.projectId || input.projectSlug || input.project);
    if (!project && (input.repoPath || input.path)) project = this.store.listProjects().find(p => this.layout.pathsEqual(p.repoPath, input.repoPath || input.path));
    if (!project || project.enabled === false) throw new DomainError('PROJECT_NOT_FOUND', '项目尚未登记。', { status: 404 });
    return project;
  }
  project(input = {}) {
    if (input.project && input.project.projectId) return input.project;
    const p = this.resolve(input);
    return { projectId: p.projectId, projectSlug: p.projectId, primarySpaceId: `project:${p.projectId}`, knowledgePath: p.knowledgePath, relatedProjectIds: p.relatedProjectIds || [], index: this.store.readRuntime(p.projectId).index };
  }
  scopes(project) {
    const registration = this.store.getProject(project.projectId);
    return [...super.scopes(project), ...this.sharedScopes(registration, 'domain')];
  }
  sharedScopes(registration, range) {
    return this.store.state.sharedScopes.filter(s => s.brainId === registration.brainId && (s.kind === 'brain' || range === 'brain' || s.domainId === registration.domainId)).map(s => ({ projectId: s.id, spaceId: `${s.kind}:${s.id}`, knowledgePath: s.knowledgePath, weight: s.kind === 'brain' ? 0.6 : 0.75, reason: s.kind }));
  }
  scanCurrent(scopes) {
    const ordinary = scopes.filter(s => this.store.getProject(s.projectId));
    const shared = scopes.filter(s => !this.store.getProject(s.projectId));
    const result = super.scanCurrent(ordinary);
    if (!shared.length) return result;
    const scanner = new KnowledgeRetrievalService({ layout: this.layout, projectStore: { readState: () => ({ index: {} }) } });
    const extra = scanner.scanCurrent(shared);
    for (const [id, candidate] of extra.candidates) {
      const scope = this.store.state.sharedScopes.find(s => s.id === candidate.projectId);
      if (candidate.entryId.startsWith('memories/') && (scope.kind !== 'brain' || candidate.entryId !== 'memories/confirmed.md' || !this.memories?.validFile(scope))) continue;
      result.candidates.set(id, candidate);
    }
    result.scopeHealth.push(...extra.scopeHealth);
    return result;
  }
  async recallIndex(scopes, query, current, health) {
    if (!query) { health.index = 'unavailable'; return; }
    const mappings = scopes.map(s => ({ scope: s, registration: this.store.getProject(s.projectId) || (() => { const shared = this.store.state.sharedScopes.find(p => p.id === s.projectId); return shared ? { vectorProjectId: `scope-${shared.kind}-${shared.id}` } : null; })() })).filter(m => m.registration);
    try {
      const url = new URL('/api/search', this.vectorUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('projects', mappings.map(m => m.registration.vectorProjectId || m.scope.projectId).join(','));
      url.searchParams.set('maxResults', String(this.candidateLimit));
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('VECTOR_UNAVAILABLE');
      const payload = await response.json();
      if (payload.errors && payload.errors.length) throw new Error('VECTOR_QUERY_FAILED');
      // Vectors only contribute a rank. Displayed text/hash always comes from
      // current canonical files, so deleted or stale index bodies cannot leak.
      for (const row of payload.results || []) {
        const mapping = mappings.find(m => (m.registration.vectorProjectId || m.scope.projectId) === row.project);
        if (!mapping) continue;
        const uri = row.uri || row.documentUri || '';
        const entry = path.isAbsolute(uri) ? path.relative(mapping.scope.knowledgePath, uri).replace(/\\/g, '/') : String(uri).replace(/\\/g, '/');
        for (const candidate of current.values()) {
          if (candidate.spaceId === mapping.scope.spaceId && candidate.entryId === entry) {
            candidate.indexScore = Math.max(candidate.indexScore || 0, Math.max(0, Number(row.score) || 0));
            candidate.indexChannels = ['vector-hub'];
          }
        }
      }
      health.index = payload.projectsSkipped?.length ? 'partial' : 'ok';
    } catch { health.index = 'degraded'; health.reason = 'vector-hub-unavailable'; }
  }
  async search(input = {}) {
    const registration = this.resolve(input);
    const project = this.project({ projectId: registration.projectId });
    let scopes = [{ projectId: project.projectId, spaceId: project.primarySpaceId, knowledgePath: project.knowledgePath, weight: 1, reason: 'primary' }];
    if (input.scope === 'domain' || input.scope === 'brain') {
      scopes = this.store.listProjects().filter(p => p.enabled !== false && p.brainId === registration.brainId
        && (input.scope === 'brain' || p.domainId === registration.domainId)).map(p => ({ projectId: p.projectId, spaceId: `project:${p.projectId}`, knowledgePath: p.knowledgePath, weight: p.projectId === registration.projectId ? 1 : 0.88, reason: p.projectId === registration.projectId ? 'primary' : input.scope }));
      scopes.push(...this.sharedScopes(registration, input.scope));
    }
    const result = await super.search({ ...input, project, scopes });
    result.results = result.results.map(row => {
      const run = this.store.listRuns(row.scope_project_id).find(r => r.promotedAt && r.staging?.operations?.some(op => op.path === row.entry_id));
      const source = this.store.getProject(row.scope_project_id) || this.store.state.sharedScopes.find(s => s.id === row.scope_project_id);
      return { ...row, projectName: source?.name || row.scope_project_id, path: row.entry_id, snippet: row.chunk_text, score: row.relevance_score, projectId: row.scope_project_id, commitSha: run?.commitSha || null };
    });
    return result;
  }
  async ask(input) {
    const result = await this.search(input);
    const citations = result.results.slice(0, 5).map((r, i) => ({ index: i + 1, ref: i + 1, projectId: r.scope_project_id, projectName: r.projectName, spaceId: r.space_id, commitSha: r.commitSha, score: r.relevance_score, entryId: r.entry_id, path: r.entry_id, title: r.title, text: r.chunk_text }));
    return { ...result, answer: citations.length ? citations.map(r => `${r.index}. ${r.title}: ${r.text}`).join('\n') : '知识库中没有找到相关内容。', citations };
  }
  async get(input) {
    const registration = this.resolve(input);
    const scope = input.spaceId && this.store.state.sharedScopes.find(s => `${s.kind}:${s.id}` === input.spaceId && s.brainId === registration.brainId);
    if (input.spaceId && !scope && input.spaceId !== `project:${registration.projectId}`) throw new DomainError('PROJECT_NOT_FOUND', '知识范围与项目归属不匹配。', { status: 404 });
    const project = scope ? { projectId: scope.id, knowledgePath: scope.knowledgePath } : registration;
    const entryId = String(input.entryId || input.entry || '').replace(/\\/g, '/');
    const target = path.resolve(project.knowledgePath, entryId);
    if (!entryId || !/\.md$/i.test(target) || !this.layout.isPathInside(project.knowledgePath, target, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', '知识文件越界。', { status: 403 });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new DomainError('PROJECT_NOT_FOUND', '知识文件不存在。', { status: 404 });
    if (scope && entryId.startsWith('memories/') && (entryId !== 'memories/confirmed.md' || !this.memories?.validFile(scope))) throw new DomainError('PROJECT_NOT_FOUND', '记忆尚未完成确认写入。', { status: 404 });
    return { ok: true, projectId: project.projectId, projectSlug: project.projectId, entryId, source: 'markdown', chunks: [{ chunk_text: fs.readFileSync(target, 'utf8'), entry_id: entryId, space_id: scope ? `${scope.kind}:${scope.id}` : `project:${project.projectId}` }] };
  }
  async history(input) {
    const project = this.resolve(input);
    const results = listMarkdownFiles(project.knowledgePath).filter(file => this.layout.isPathInside(path.join(project.knowledgePath, 'changes'), file, { realpath: true })).map(file => {
      const content = fs.readFileSync(file, 'utf8');
      return { entry_id: path.relative(project.knowledgePath, file).replace(/\\/g, '/'), title: (/^#\s+(.+)$/m.exec(content) || [null, path.basename(file)])[1], chunk_text: content.slice(0, 900), updated_at: fs.statSync(file).mtime.toISOString() };
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(100, Math.max(1, Number(input.limit) || 20)));
    return { ok: true, projectId: project.projectId, projectSlug: project.projectId, backend: 'markdown', source: 'markdown', results };
  }
}

module.exports = { EngineRetrieval };
