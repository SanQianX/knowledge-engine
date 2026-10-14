'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { KnowledgeRetrievalService } = require('./runtime/knowledge-retrieval-service');
const { listMarkdownFiles, isExcludedKnowledgePath, CHUNKER_VERSION, lineFenceState, headingOf } = require('./runtime/markdown-knowledge-indexer');
const { DomainError } = require('./runtime/contracts');
const { sha256 } = require('./runtime/content-hash');
const ranking = require('./retrieval-ranking');
const fileNames = query => [...new Set((String(query).match(/[\p{L}\p{N}_./\\-]+\.(?:cjs|mjs|js|jsx|ts|tsx|py|cs|cpp|c|h|hpp|rs|go|html|css|scss|json|ya?ml|toml|md|txt|sh|ps1)\b/giu) || []).map(value => path.posix.basename(value.replace(/\\/g, '/')).toLowerCase()))].slice(0, 20);
const mentionsFile = (candidate, name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_.-])`, 'iu').test([candidate.entryId, candidate.title, candidate.chunkText, ...(candidate.metadata?.sourcePaths || [])].join('\n'));

const headingPathAt = (body, pos) => {
  const headings = [];
  let fence = null;
  let offset = 0;
  for (const line of String(body).split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart > pos) break;
    fence = lineFenceState(line, fence);
    if (fence) continue;
    const heading = headingOf(line);
    if (heading) { headings.length = heading.level - 1; headings[heading.level - 1] = heading.text; }
  }
  return headings.filter(Boolean);
};
const overlapOf = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

class EngineRetrieval extends KnowledgeRetrievalService {
  constructor(options) { super(options); this.store = options.store; this.memories = options.memories; this.vectorUrl = options.vectorUrl || 'http://127.0.0.1:8787'; this.retrievalPolicy = options.retrievalPolicy || require('./retrieval-policy.json'); }
  async retrieve(input = {}) {
    const project = this.project(input), scopes = input.scopes || this.scopes(project), signals = this.signalSet(input.signals);
    const registrationBefore = this.store.getProject(project.projectId);
    const scopeStamp = p => JSON.stringify(p && [p.repoPath, p.knowledgePath, p.brainId, p.domainId, p.enabled]);
    const stamp = scopeStamp(registrationBefore);
    const stamps = new Map(scopes.map(scope => [scope.projectId, scopeStamp(this.store.getProject(scope.projectId) || this.store.state.sharedScopes.find(s => s.id === scope.projectId))]));
    const scanned = this.scanCurrent(scopes), health = { index: 'unknown', scopes: scanned.scopeHealth };
    const bodies = new Map();
    for (const [id, c] of scanned.candidates) {
      const key = `${c.spaceId}:${c.entryId}`;
      try {
        if (!bodies.has(key)) bodies.set(key, ranking.bodyText(fs.readFileSync(path.join(c.knowledgePath, c.entryId), 'utf8')));
      } catch { scanned.candidates.delete(id); }
    }
    // The canonical chunker emits authoritative half-open offsets into the same
    // body coordinate system. A position is accepted only when the current
    // body still slices to the exact chunk text; anything else degrades to
    // unpositioned instead of guessing by search.
    for (const c of scanned.candidates.values()) {
      const body = bodies.get(`${c.spaceId}:${c.entryId}`);
      const positioned = Boolean(body) && Number.isInteger(c.chunkStart) && Number.isInteger(c.chunkEnd)
        && c.chunkStart >= 0 && c.chunkEnd > c.chunkStart && c.chunkEnd <= body.length && body.slice(c.chunkStart, c.chunkEnd) === c.chunkText;
      c.bodyHash = body ? ranking.bodyHash(body) : null;
      c.bodyLength = body ? body.length : 0;
      c.startPos = positioned ? c.chunkStart : -1;
      c.endPos = positioned ? c.chunkEnd : -1;
    }
    const lexicalChunkCount = scanned.candidates.size;
    if (!['greeting', 'followup'].includes(ranking.intent(signals.indexQuery))) await this.recallIndex(scopes, signals.indexQuery, scanned.candidates, health, bodies);
    else health.index = 'not-requested';
    if (stamp !== scopeStamp(this.store.getProject(project.projectId))) throw new DomainError('PROJECT_SCOPE_CHANGED', '项目归属或绑定已变化，请重新检索。', { status: 409 });
    for (const [id, c] of scanned.candidates) {
      if (stamps.get(c.projectId) !== scopeStamp(this.store.getProject(c.projectId) || this.store.state.sharedScopes.find(s => s.id === c.projectId))) { scanned.candidates.delete(id); continue; }
      if (c.entryId.startsWith('memories/')) {
        const shared = this.store.state.sharedScopes.find(s => s.id === c.projectId);
        if (!this.memories?.readableEntry(shared, c.entryId, registrationBefore) || !this.memories.memoryForChunk(shared, c.entryId, c.headingPath)) scanned.candidates.delete(id);
      }
    }
    const ranked = ['greeting', 'followup'].includes(ranking.intent(signals.indexQuery)) ? [] : ranking.rank([...scanned.candidates.values()], signals.indexQuery, c => {
      const scored = this.score(c, signals);
      return { ...scored, excluded: Boolean(signals.commitPrefixes?.length || c.knownFileQuery) && scored.score <= 0 };
    });
    const ordered = input.policy === 'project-first' ? [...ranked.filter(c => c.scopeReason === 'primary'), ...ranked.filter(c => c.scopeReason !== 'primary')] : ranked;
    const checked = new Map(), candidates = [];
    // Revalidate every returned document after the asynchronous vector call,
    // not every unrelated file a second time. Changed/deleted/escaped facts
    // are discarded before leaving this service, then the next rank is tried.
    for (const c of ordered) {
      const key = `${c.spaceId}:${c.entryId}`;
      if (!checked.has(key)) {
        try {
          const file = path.join(c.knowledgePath, c.entryId);
          checked.set(key, this.layout.isPathInside(c.knowledgePath, file, { realpath: true }) && !fs.lstatSync(file).isSymbolicLink()
            && crypto.createHash('sha256').update(`chunker:${CHUNKER_VERSION}\n${fs.readFileSync(file, 'utf8')}`).digest('hex') === c.documentHash);
        } catch { checked.set(key, false); }
      }
      if (checked.get(key)) candidates.push(c);
      if (candidates.length >= this.candidateLimit) break;
    }
    return { project, scopes, signals, health, candidates, totalCurrentChunks: lexicalChunkCount, intent: ranking.intent(signals.indexQuery) };
  }
  signalSet(input = {}) {
    const signals = super.signalSet(input);
    const query = signals.indexQuery.trim().toLowerCase();
    const promoted = this.store.listRuns().filter(run => run.promotedAt && run.commitSha);
    const identifiers = [...query.matchAll(/(?:^|[^a-z0-9])([a-f0-9]{7,64})(?=$|[^a-z0-9])/g)].map(match => match[1]);
    signals.commitPrefixes = [...new Set(identifiers.filter(id => promoted.some(run => run.commitSha.startsWith(id))))];
    return signals;
  }
  score(candidate, signals) {
    if (signals.commitPrefixes?.length) {
      // A known commit is an identifier, not a semantic topic. Unrelated
      // vector hits must not crowd its current, provenance-checked files out.
      const source = this.store.listRuns(candidate.projectId).find(run => run.promotedAt && run.staging?.operations?.some(operation => operation.path === candidate.entryId));
      if (!signals.commitPrefixes.some(prefix => source?.commitSha?.startsWith(prefix))) return { score: 0, selectionSignals: [] };
      const result = super.score(candidate, signals);
      return { score: Math.max(1, result.score), selectionSignals: [...result.selectionSignals, 'exact-commit'] };
    }
    if (candidate.knownFileQuery && !candidate.fileReferences.length) return { score: 0, selectionSignals: [] };
    const result = super.score(candidate, signals);
    if (candidate.fileReferences?.length) return { score: Math.max(1, result.score), selectionSignals: [...result.selectionSignals, ...candidate.fileReferences.map(name => `exact-source-file:${name}`)] };
    return result;
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
    return this.store.state.sharedScopes.filter(s => s.brainId === registration.brainId && (s.kind === 'brain' || range === 'brain' || registration.domainId && s.domainId === registration.domainId)).map(s => ({ projectId: s.id, spaceId: `${s.kind}:${s.id}`, knowledgePath: s.knowledgePath, weight: s.kind === 'brain' ? 0.6 : 0.75, reason: s.kind }));
  }
  scanCurrent(scopes) {
    const registration = this.store.getProject(scopes.find(s => s.reason === 'primary')?.projectId);
    const ordinary = scopes.filter(s => this.store.getProject(s.projectId));
    const shared = scopes.filter(s => !this.store.getProject(s.projectId));
    const result = super.scanCurrent(ordinary);
    for (const [id, candidate] of result.candidates) if (candidate.entryId.startsWith('memories/')) result.candidates.delete(id);
    if (!shared.length) return result;
    const scanner = new KnowledgeRetrievalService({ layout: this.layout, projectStore: { readState: () => ({ index: {} }) } });
    const extra = scanner.scanCurrent(shared);
    for (const [id, candidate] of extra.candidates) {
      const scope = this.store.state.sharedScopes.find(s => s.id === candidate.projectId);
      if (candidate.entryId.startsWith('memories/')) {
        if (!this.memories?.readableEntry(scope, candidate.entryId, registration) || !this.memories.memoryForChunk(scope, candidate.entryId, candidate.headingPath)) continue;
        const memory = this.memories.memoryForChunk(scope, candidate.entryId, candidate.headingPath), type = this.memories.scopeOf(memory).type;
        candidate.scopeWeight = { project: 1, domain: 0.75, global: 0.6 }[type];
        candidate.title = `${{ project: '项目记忆', domain: '领域记忆', global: '全局记忆' }[type]} · ${this.memories.target(memory).name}`;
      } else if (scopes.find(s => s.projectId === candidate.projectId)?.memoryOnly) continue;
      result.candidates.set(id, candidate);
    }
    result.scopeHealth.push(...extra.scopeHealth);
    return result;
  }
  async recallIndex(scopes, query, current, health, bodies) {
    if (!query) { health.index = 'unavailable'; return; }
    // File identifiers, like commit IDs, select current facts before semantic
    // ranking. A not-yet-known filename still permits analogous background.
    const named = fileNames(query), known = named.filter(name => [...current.values()].some(candidate => mentionsFile(candidate, name)));
    for (const candidate of current.values()) { candidate.knownFileQuery = known.length > 0; candidate.fileReferences = known.filter(name => mentionsFile(candidate, name)); }
    const mappings = scopes.map(s => ({ scope: s, registration: this.store.getProject(s.projectId) || (() => { const shared = this.store.state.sharedScopes.find(p => p.id === s.projectId); return shared ? { vectorProjectId: `scope-${shared.kind}-${shared.id}` } : null; })() })).filter(m => m.registration);
    const recall = { rows: 0, merges: 0, slices: 0, rejected: {} };
    const reject = reason => { recall.rejected[reason] = (recall.rejected[reason] || 0) + 1; };
    const anchors = new Map();
    for (const candidate of current.values()) {
      const key = `${candidate.spaceId}:${candidate.entryId}`;
      if (!anchors.has(key)) anchors.set(key, candidate);
    }
    const pending = [];
    try {
      const url = new URL('/api/search', this.vectorUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('projects', mappings.map(m => m.registration.vectorProjectId || m.scope.projectId).join(','));
      url.searchParams.set('maxResults', String(this.candidateLimit));
      url.searchParams.set('resultLevel', 'chunk');
      url.searchParams.set('perProjectLimit', '30');
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('VECTOR_UNAVAILABLE');
      const payload = await response.json();
      if (payload.errors && payload.errors.length) throw new Error('VECTOR_QUERY_FAILED');
      const calibrated = this.retrievalPolicy.rankingVersion === ranking.VERSION && this.retrievalPolicy.models?.find(p => p.model === payload.model && p.dimensions === payload.dimensions && Number.isFinite(p.minScore));
      health.calibration = calibrated ? 'validated' : 'lexical-support-required';
      // Vectors only contribute a rank. Displayed text/hash always comes from
      // current canonical files, so deleted or stale index bodies cannot leak.
      for (const row of payload.results || []) {
        recall.rows += 1;
        const mapping = mappings.find(m => (m.registration.vectorProjectId || m.scope.projectId) === row.project);
        if (!mapping) { reject('unknown-project'); continue; }
        const uri = row.uri || row.documentUri || '';
        const entry = path.isAbsolute(uri) ? path.relative(mapping.scope.knowledgePath, uri).replace(/\\/g, '/') : String(uri).replace(/\\/g, '/');
        const key = `${mapping.scope.spaceId}:${entry}`;
        const anchor = anchors.get(key);
        if (!anchor || !bodies || !bodies.has(key)) { reject('no-current-document'); continue; }
        const valid = row.scoreType === 'cosine' && row.bodyHash === anchor.bodyHash && Number.isInteger(row.startPos) && Number.isInteger(row.endPos)
          && row.startPos >= 0 && row.endPos > row.startPos && row.endPos <= anchor.bodyLength;
        if (!valid) { reject(row.bodyHash === anchor.bodyHash ? 'invalid-range' : 'body-hash-mismatch'); continue; }
        const value = Number(row.score);
        if (!Number.isFinite(value) || value < -1 || value > 1) { reject('invalid-score'); continue; }
        for (const candidate of current.values()) {
          if (candidate.fromVectorRange || candidate.spaceId !== mapping.scope.spaceId || candidate.entryId !== entry || candidate.startPos < 0) continue;
          const overlap = Math.max(0, Math.min(candidate.endPos, row.endPos) - Math.max(candidate.startPos, row.startPos));
          if (!overlap) continue;
          recall.merges += 1;
          candidate.indexScore = Math.max(candidate.indexScore || 0, Math.max(0, value));
          candidate.vectorRanges ||= [];
          candidate.vectorRanges.push([Math.max(candidate.startPos, row.startPos), Math.min(candidate.endPos, row.endPos)]);
          const ranges = [...candidate.vectorRanges].sort((a, b) => a[0] - b[0]);
          let covered = 0, end = -1;
          for (const range of ranges) { covered += Math.max(0, range[1] - Math.max(end, range[0])); end = Math.max(end, range[1]); }
          if (covered >= candidate.chunkText.length * 0.5) { candidate.indexChannels = ['vector-hub']; candidate.vectorVerified = true; }
          if (calibrated) { candidate.vectorCalibrated = true; candidate.vectorMinScore = calibrated.minScore; }
        }
        const sliceText = bodies.get(key).slice(row.startPos, row.endPos);
        if (!sliceText.trim()) { reject('empty-slice'); continue; }
        let duplicate = false;
        for (const candidate of current.values()) {
          if (!candidate.fromVectorRange || candidate.spaceId !== mapping.scope.spaceId || candidate.entryId !== entry) continue;
          if (overlapOf(candidate.startPos, candidate.endPos, row.startPos, row.endPos) * 2 >= Math.min(candidate.endPos - candidate.startPos, row.endPos - row.startPos)) { duplicate = true; break; }
        }
        for (const prior of pending) {
          if (prior.scope.spaceId !== mapping.scope.spaceId || prior.entry !== entry) continue;
          if (overlapOf(prior.row.startPos, prior.row.endPos, row.startPos, row.endPos) * 2 >= Math.min(prior.row.endPos - prior.row.startPos, row.endPos - row.startPos)) { duplicate = true; break; }
        }
        if (duplicate) continue;
        pending.push({ scope: mapping.scope, key, entry, anchor, row, sliceText, value, calibrated });
      }
      for (const p of pending) {
        recall.slices += 1;
        const recordId = `${p.scope.spaceId}:${p.entry}:vector:${p.row.startPos}-${p.row.endPos}`;
        current.set(recordId, {
          recordId,
          spaceId: p.scope.spaceId,
          projectId: p.scope.projectId,
          scopeReason: p.scope.reason,
          // A slice inherits the anchor candidate's own scope weight: a project
          // memory keeps project weight even inside a lower-weight shared scope.
          scopeWeight: p.anchor.scopeWeight,
          fromVectorRange: true,
          knowledgePath: p.scope.knowledgePath,
          entryId: p.entry,
          entryType: p.anchor.entryType,
          chunkId: `${p.entry}:vector:${p.row.startPos}-${p.row.endPos}`,
          chunkOrder: null,
          title: p.anchor.title,
          headingPath: headingPathAt(bodies.get(p.key), p.row.startPos),
          chunkText: p.sliceText,
          documentHash: p.anchor.documentHash,
          contentHash: sha256(p.sliceText),
          metadata: p.anchor.metadata,
          fromOverlay: p.anchor.fromOverlay,
          bodyHash: p.anchor.bodyHash,
          bodyLength: p.anchor.bodyLength,
          startPos: p.row.startPos,
          endPos: p.row.endPos,
          indexScore: Math.min(1, Math.max(0, p.value)),
          indexChannels: ['vector-hub'],
          vectorRanges: [[p.row.startPos, p.row.endPos]],
          vectorVerified: true,
          knownFileQuery: known.length > 0,
          fileReferences: known.filter(name => mentionsFile({ entryId: p.entry, title: p.anchor.title, chunkText: p.sliceText, metadata: p.anchor.metadata }, name)),
          ...(p.calibrated ? { vectorCalibrated: true, vectorMinScore: p.calibrated.minScore } : {}),
        });
      }
      health.index = payload.projectsSkipped?.length ? 'partial' : 'ok';
      health.verifiedVectorChunks = [...current.values()].filter(c => c.vectorVerified && !c.fromVectorRange).length;
      health.vectorMode = payload.resultLevel === 'chunk' ? 'verified-chunks' : 'legacy-document-results';
    } catch { health.index = 'degraded'; health.reason = 'vector-hub-unavailable'; }
    health.vectorRecall = recall;
    health.verifiedVectorSlices = recall.slices;
  }
  async search(input = {}) {
    const registration = this.resolve(input);
    const selectedIntent = input.intent && input.intent !== 'auto' ? input.intent : ranking.intent(input.query);
    if (input.intent !== undefined && !['auto', 'search', 'recent'].includes(input.intent)) throw new DomainError('INVALID_ARGUMENT', '检索意图无效。');
    if (input.scope !== undefined && !['project', 'domain', 'brain'].includes(input.scope)) throw new DomainError('INVALID_ARGUMENT', '知识范围无效。');
    const knownCommits = this.signalSet({ primaryTexts: [String(input.query || '')] }).commitPrefixes;
    if (selectedIntent === 'recent' && !knownCommits?.length) {
      const history = await this.history(input);
      const hasKnowledge = listMarkdownFiles(registration.knowledgePath).length > 0;
      const currentProjectStatus = { hasKnowledge, matchedCount: history.results.length, note: history.results.length ? '已匹配当前项目的维护变更。' : hasKnowledge ? '本次没有匹配到当前项目的维护变更；已有知识仍然保留，不代表知识为空。' : '当前项目尚无可读取的已维护知识。' };
      return { ...history, query: input.query, intent: 'recent', rankingVersion: ranking.VERSION, currentProjectStatus,
        matchStatus: history.results.length ? 'matched' : hasKnowledge ? 'no-reliable-match' : 'knowledge-empty',
        health: { index: 'not-requested' }, results: history.results.slice(0, Math.max(1, Math.min(30, Number(input.limit) || 8))).map((r, i) => ({ ...r,
          record_id: `project:${registration.projectId}:${r.entry_id}:history`, space_id: `project:${registration.projectId}`, chunk_id: `${r.entry_id}:history`,
          scope_project_id: registration.projectId, scope_reason: 'primary', projectId: registration.projectId, projectName: registration.name, path: r.entry_id,
          snippet: r.chunk_text, relevance_score: 1 / (i + 1), score: 1 / (i + 1), match_channels: ['intent:recent', 'scope:primary'], matchReason: '当前项目已维护变更，按依据时间排序' })) };
    }
    const project = this.project({ projectId: registration.projectId });
    let scopes = [{ projectId: project.projectId, spaceId: project.primarySpaceId, knowledgePath: project.knowledgePath, weight: 1, reason: 'primary' }];
    if (input.scope === 'domain' || input.scope === 'brain') {
      scopes = this.store.listProjects().filter(p => p.enabled !== false && p.brainId === registration.brainId
        && (input.scope === 'brain' || p.projectId === registration.projectId || registration.domainId && p.domainId === registration.domainId)).map(p => ({ projectId: p.projectId, spaceId: `project:${p.projectId}`, knowledgePath: p.knowledgePath, weight: p.projectId === registration.projectId ? 1 : 0.88, reason: p.projectId === registration.projectId ? 'primary' : input.scope }));
      scopes.push(...this.sharedScopes(registration, input.scope));
    }
    if (!scopes.some(s => s.spaceId === `brain:${registration.brainId}`)) {
      scopes.push(...this.sharedScopes(registration, 'domain').filter(s => s.reason === 'brain').map(s => ({ ...s, memoryOnly: true })));
    }
    const result = await super.search({ ...input, project, scopes });
    const vectorUsed = result.results.some(row => row.match_channels.includes('index:vector-hub'));
    result.retrievalModes = vectorUsed ? ['lexical', 'vector'] : ['lexical'];
    result.backend = vectorUsed ? 'hybrid+markdown-truth' : 'markdown-hybrid-fallback';
    result.intent = selectedIntent; result.rankingVersion = ranking.VERSION;
    result.matchStatus = result.results.length ? 'matched' : ranking.intent(input.query) === 'greeting' ? 'not-needed' : 'no-reliable-match';
    const primaryCount = result.results.filter(r => r.scope_project_id === registration.projectId && !r.entry_id.startsWith('memories/')).length;
    const hasKnowledge = listMarkdownFiles(registration.knowledgePath).length > 0;
    result.currentProjectStatus = { hasKnowledge, matchedCount: primaryCount,
      note: primaryCount ? '已匹配当前项目知识。' : hasKnowledge ? '当前项目已有知识，本次问题未可靠命中；不代表知识为空。' : '当前项目尚无可读取的已维护知识。' };
    result.results = result.results.map(row => {
      const run = this.store.listRuns(row.scope_project_id).find(r => r.promotedAt && r.staging?.operations?.some(op => op.path === row.entry_id));
      const source = this.store.getProject(row.scope_project_id) || this.store.state.sharedScopes.find(s => s.id === row.scope_project_id);
      const memory = source?.kind === 'brain' && row.entry_id.startsWith('memories/') ? this.memories.memoryForChunk(source, row.entry_id, row.heading_path) : null;
      const commitSha = memory ? memory.evidence?.commitSha || null : run?.commitSha || null;
      return { ...row, projectName: source?.name || row.scope_project_id, path: row.entry_id, snippet: row.chunk_text, score: row.relevance_score, projectId: row.scope_project_id, commitSha,
        matchReason: row.match_channels.includes('exact-commit') ? '提交标识匹配' : row.match_channels.some(c => c.startsWith('exact-source-file:')) ? '源文件匹配' : row.match_channels.includes('index:vector-hub') ? row.match_channels.includes('lexical:bm25') ? '正文关键词与向量片段融合' : '已校验向量片段匹配' : '当前正文词法匹配',
        ...(memory ? { memoryScopeType: this.memories.scopeOf(memory).type, memoryScopeId: this.memories.scopeOf(memory).id, memoryId: memory.id, ...(memory.sourceType === 'manual' ? { memorySourceType: 'manual' } : {}) } : {}) };
    });
    const slots = result.results.map((r, i) => r.memoryId ? i : -1).filter(i => i >= 0);
    const ordered = slots.map(i => result.results[i]).sort((a, b) => ({ project: 0, domain: 1, global: 2 }[a.memoryScopeType] - { project: 0, domain: 1, global: 2 }[b.memoryScopeType]) || b.score - a.score);
    slots.forEach((slot, i) => { result.results[slot] = ordered[i]; });
    return result;
  }
  async ask(input) {
    const result = await this.search(input);
    const citations = result.results.slice(0, 5).map((r, i) => ({ index: i + 1, ref: i + 1, projectId: r.scope_project_id, projectName: r.projectName, spaceId: r.space_id, commitSha: r.commitSha, score: r.relevance_score, entryId: r.entry_id, path: r.entry_id, title: r.title, text: r.chunk_text }));
    return { ...result, answer: citations.length ? citations.map(r => `${r.index}. ${r.title}: ${r.text}`).join('\n') : result.matchStatus === 'not-needed' ? '本次输入无需知识检索。' : result.currentProjectStatus?.note || '没有可靠匹配；这不代表知识库为空。', citations };
  }
  async get(input) {
    const registration = this.resolve(input);
    const scope = input.spaceId && this.store.state.sharedScopes.find(s => `${s.kind}:${s.id}` === input.spaceId && s.brainId === registration.brainId);
    if (input.spaceId && !scope && input.spaceId !== `project:${registration.projectId}`) throw new DomainError('PROJECT_NOT_FOUND', '知识范围与项目归属不匹配。', { status: 404 });
    const project = scope ? { projectId: scope.id, knowledgePath: scope.knowledgePath } : registration;
    const entryId = String(input.entryId || input.entry || '').replace(/\\/g, '/');
    if (isExcludedKnowledgePath(entryId)) throw new DomainError('PATH_OUTSIDE_ROOT', '会话证据与内部数据不能作为正式知识读取。', { status: 403 });
    const target = path.resolve(project.knowledgePath, entryId);
    if (!entryId || !/\.md$/i.test(target) || !this.layout.isPathInside(project.knowledgePath, target, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', '知识文件越界。', { status: 403 });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new DomainError('PROJECT_NOT_FOUND', '知识文件不存在。', { status: 404 });
    if (entryId.startsWith('memories/') && (!scope || !this.memories?.readableEntry(scope, entryId, registration))) throw new DomainError('PROJECT_NOT_FOUND', '记忆尚未同步或不适用于当前项目。', { status: 404 });
    return { ok: true, projectId: project.projectId, projectSlug: project.projectId, entryId, source: 'markdown', chunks: [{ chunk_text: fs.readFileSync(target, 'utf8'), entry_id: entryId, space_id: scope ? `${scope.kind}:${scope.id}` : `project:${project.projectId}` }] };
  }
  async history(input) {
    const project = this.resolve(input);
    const namedFiles = fileNames(input.query || '');
    const results = listMarkdownFiles(project.knowledgePath).filter(file => this.layout.isPathInside(path.join(project.knowledgePath, 'changes'), file, { realpath: true })).map(file => {
      const content = fs.readFileSync(file, 'utf8');
      const entry = path.relative(project.knowledgePath, file).replace(/\\/g, '/');
      const run = this.store.listRuns(project.projectId).find(r => r.promotedAt && r.staging?.operations?.some(op => op.path === entry));
      const declared = /(?:^|\n)(?:-\s*)?(?:date|日期|时间):\s*([0-9T:+.Z-]+)/i.exec(content)?.[1];
      const timestamp = run?.evidence?.commitDate || run?.commitDate || declared || run?.promotedAt;
      const valid = timestamp && Number.isFinite(Date.parse(timestamp));
      const excerpt = content.slice(0, 1200);
      return { entry_id: entry, title: (/^#\s+(.+)$/m.exec(content) || [null, path.basename(file)])[1], chunk_text: excerpt, sourceText: content,
        content_hash: crypto.createHash('sha256').update(excerpt).digest('hex'), history_excerpt_length: excerpt.length,
        document_hash: crypto.createHash('sha256').update(content).digest('hex'),
        commitSha: run?.commitSha || /(?:^|\n)(?:-\s*)?commit:\s*`?([a-f0-9]{40})/i.exec(content)?.[1] || null,
        updated_at: valid ? new Date(timestamp).toISOString() : fs.statSync(file).mtime.toISOString(), dateSource: valid ? run?.promotedAt === timestamp ? 'promotion' : 'commit-evidence' : 'mtime-fallback' };
    }).filter(row => !namedFiles.length || namedFiles.some(name => mentionsFile({ entryId: row.entry_id, title: row.title, chunkText: row.sourceText }, name)))
      .sort((a, b) => (a.dateSource === 'mtime-fallback' ? 1 : 0) - (b.dateSource === 'mtime-fallback' ? 1 : 0) || b.updated_at.localeCompare(a.updated_at))
      .slice(0, Math.min(100, Math.max(1, Number(input.limit) || 20))).map(({ sourceText, ...row }) => row);
    return { ok: true, projectId: project.projectId, projectSlug: project.projectId, backend: 'markdown', source: 'markdown', results };
  }
}

module.exports = { EngineRetrieval };
