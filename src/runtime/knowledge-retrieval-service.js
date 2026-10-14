const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DomainError, validateProjectId } = require('./contracts');
const { CHUNKER_VERSION, chunkMarkdown, listMarkdownFiles, inferEntryType, parseKnowledgeMetadata } = require('./markdown-knowledge-indexer');
const { sha256: documentSha256 } = require('./content-hash');

const DEFAULT_CONTEXT_BUDGET = 256 * 1024;
const DEFAULT_CANDIDATE_LIMIT = 50;

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex')}`;
}

function tokens(value) {
  const normalized = String(value || '').toLowerCase().replace(/\\/g, '/');
  const out = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let index = 0; index < segment.length - 1; index += 1) out.push(segment.slice(index, index + 2));
  }
  return [...new Set(out.filter(item => item.length > 1))];
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function titleFromMarkdown(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(String(markdown || ''));
  return match ? match[1].trim() : fallback;
}

function occurrences(text, terms, cap = 12) {
  const source = String(text || '').toLowerCase();
  let count = 0;
  for (const term of terms) {
    let offset = 0;
    let matches = 0;
    while (term && matches < cap && (offset = source.indexOf(term, offset)) >= 0) {
      matches += 1;
      count += 1;
      offset += term.length;
    }
  }
  return count;
}

function safeCurrentFile(layout, knowledgePath, entryId) {
  const root = path.resolve(knowledgePath);
  const target = path.resolve(root, ...String(entryId).split('/'));
  if (!layout.isPathInside(root, target, { realpath: true }) || !fs.existsSync(target)
    || !fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) return null;
  return target;
}

function manifestHash(manifest) {
  const { manifestHash: ignored, ...payload } = manifest;
  void ignored;
  return hash(JSON.stringify(payload));
}

class KnowledgeRetrievalService {
  constructor(options = {}) {
    this.layout = options.layout;
    this.registryStore = options.registryStore;
    this.projectStore = options.projectStore;
    this.databaseProvider = options.databaseProvider || (() => options.database || null);
    this.embedderProvider = options.embedderProvider || (() => options.embedder || null);
    this.logger = options.logger || null;
    this.candidateLimit = Number(options.candidateLimit || DEFAULT_CANDIDATE_LIMIT);
  }

  async log(level, event, message, context) {
    try { if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context); } catch {
      // Retrieval truth and logging availability are independent.
    }
  }

  project(input = {}) {
    if (input.project && input.project.projectId) return input.project;
    const projectId = validateProjectId(input.projectId);
    const config = this.projectStore.readConfig(projectId);
    const state = this.projectStore.readState(projectId);
    if (config.enabled === false) throw new DomainError('PROJECT_NOT_FOUND', 'The requested project is disabled.', { status: 404 });
    return {
      projectId,
      projectSlug: config.legacyExtensions && config.legacyExtensions.slug || projectId,
      primarySpaceId: `project:${projectId}`,
      knowledgePath: path.resolve(config.knowledgePath),
      relatedProjectIds: Array.isArray(config.relatedProjectIds) ? config.relatedProjectIds : [],
      index: state.index,
    };
  }

  scopes(project) {
    const scopes = [{ projectId: project.projectId, spaceId: project.primarySpaceId || `project:${project.projectId}`, knowledgePath: project.knowledgePath, weight: 1, reason: 'primary' }];
    for (const relatedId of project.relatedProjectIds || []) {
      if (!this.registryStore || !this.registryStore.readDisplaySnapshot(relatedId)) continue;
      const config = this.projectStore.readConfig(relatedId);
      if (config.enabled === false) continue;
      scopes.push({ projectId: relatedId, spaceId: `project:${relatedId}`, knowledgePath: path.resolve(config.knowledgePath), weight: 0.88, reason: 'related' });
    }
    return scopes;
  }

  sourceManifest(projectId) {
    const filePath = this.layout.getRuntimePath('index-sources', `${projectId}.json`);
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return value && value.schema === 'knowledge-index-source-manifest/v1' ? value : null;
    } catch { return null; }
  }

  scanCurrent(scopes) {
    const candidates = new Map();
    const sources = new Map();
    const scopeHealth = [];
    for (const scope of scopes) {
      const state = this.projectStore.readState(scope.projectId);
      const sourceManifest = this.sourceManifest(scope.projectId);
      const manifestEntries = sourceManifest && sourceManifest.entries || {};
      const files = listMarkdownFiles(scope.knowledgePath);
      let overlayEntries = 0;
      for (const filePath of files) {
        const entryId = path.relative(scope.knowledgePath, filePath).replace(/\\/g, '/');
        const markdown = fs.readFileSync(filePath, 'utf8');
        // Request-local only: the bodies stage of this same retrieval reuses
        // this exact read; nothing is cached across requests.
        sources.set(`${scope.spaceId}:${entryId}`, markdown);
        const documentHash = documentSha256(`chunker:${CHUNKER_VERSION}\n${markdown}`);
        const metadata = parseKnowledgeMetadata(markdown);
        const title = titleFromMarkdown(markdown, path.basename(entryId, '.md'));
        const rawChunks = chunkMarkdown(markdown);
        const fromOverlay = !sourceManifest || !manifestEntries[entryId] || manifestEntries[entryId].documentHash !== documentHash;
        if (fromOverlay) overlayEntries += 1;
        for (const chunk of rawChunks) {
          const chunkId = `${entryId}:${chunk.chunkOrder}`;
          candidates.set(`${scope.spaceId}:${chunkId}`, {
            recordId: `${scope.spaceId}:${chunkId}`,
            spaceId: scope.spaceId,
            projectId: scope.projectId,
            scopeReason: scope.reason,
            scopeWeight: scope.weight,
            knowledgePath: scope.knowledgePath,
            entryId,
            entryType: inferEntryType(entryId),
            chunkId,
            chunkOrder: chunk.chunkOrder,
            title,
            headingPath: chunk.headingPath,
            chunkText: chunk.chunkText,
            chunkStart: Number.isInteger(chunk.startPos) ? chunk.startPos : null,
            chunkEnd: Number.isInteger(chunk.endPos) ? chunk.endPos : null,
            documentHash,
            contentHash: documentSha256(chunk.chunkText),
            metadata,
            fromOverlay,
            indexScore: 0,
            indexChannels: [],
          });
        }
      }
      const deletedEntries = sourceManifest
        ? Object.keys(manifestEntries).filter(entryId => !safeCurrentFile(this.layout, scope.knowledgePath, entryId)).length
        : 0;
      scopeHealth.push({
        projectId: scope.projectId,
        generation: Number(state.index && state.index.generation || 0),
        dirty: state.index && state.index.dirty === true,
        sourceManifest: sourceManifest ? 'available' : 'missing',
        overlayEntries,
        deletedEntries,
      });
    }
    return { candidates, scopeHealth, sources };
  }

  async recallIndex(scopes, query, current, health) {
    if (!query || !fs.existsSync(this.layout.getIndexPath())) {
      health.index = 'missing';
      return;
    }
    const database = this.databaseProvider();
    const embedder = this.embedderProvider();
    if (!database || !embedder || typeof embedder.embedQuery !== 'function') {
      health.index = 'unavailable';
      return;
    }
    try {
      const vector = await embedder.embedQuery(query);
      const rows = await database.hybridSearch({
        text: query,
        vector,
        spaceIds: scopes.map(scope => scope.spaceId),
        limit: this.candidateLimit,
        candidates: Math.min(200, this.candidateLimit * 4),
      });
      for (const row of rows) {
        const key = `${row.space_id}:${row.chunk_id}`;
        const candidate = current.get(key);
        if (!candidate) continue;
        candidate.indexScore = Number(row.relevance_score || 0);
        candidate.indexChannels = Array.isArray(row.match_channels) ? row.match_channels : [];
      }
      health.index = 'ok';
    } catch (error) {
      health.index = 'degraded';
      health.reason = 'index-query-failed';
      health.errorCode = error && error.code || 'INDEX_UNAVAILABLE';
    }
  }

  score(candidate, signals) {
    const selectionSignals = [];
    let score = candidate.indexScore * 1000;
    if (candidate.indexScore) selectionSignals.push(...candidate.indexChannels.map(channel => `index:${channel}`));
    const primaryMatches = occurrences(`${candidate.title}\n${candidate.headingPath.join(' ')}\n${candidate.chunkText}`, signals.primaryTokens);
    if (primaryMatches) { score += Math.min(primaryMatches, 20) * 8; selectionSignals.push(`user-keyword:${primaryMatches}`); }
    const implementationMatches = occurrences(`${candidate.entryId}\n${candidate.title}\n${candidate.chunkText}`, signals.implementationTokens);
    if (implementationMatches) { score += Math.min(implementationMatches, 16) * 3; selectionSignals.push(`implementation:${implementationMatches}`); }
    const assistantMatches = occurrences(candidate.chunkText, signals.assistantTokens);
    if (assistantMatches) { score += Math.min(assistantMatches, 8); selectionSignals.push(`assistant-hint:${assistantMatches}`); }

    const changedPaths = signals.changedPaths;
    const metadataPaths = candidate.metadata.sourcePaths.map(normalizePath);
    const exactPaths = metadataPaths.filter(value => changedPaths.has(value));
    if (exactPaths.length) { score += 300 + exactPaths.length * 20; selectionSignals.push(`exact-source-path:${exactPaths.join(',')}`); }
    const changedBasenames = signals.changedBasenames;
    const basenameMatches = metadataPaths.filter(value => changedBasenames.has(path.posix.basename(value)));
    if (!exactPaths.length && basenameMatches.length) { score += 70; selectionSignals.push(`source-basename:${basenameMatches.join(',')}`); }

    const structured = [...candidate.metadata.symbols, ...candidate.metadata.tags, ...candidate.metadata.routes, ...candidate.metadata.affectedModules].map(value => value.toLowerCase());
    const structuredMatches = structured.filter(value => signals.allTerms.has(value)
      || signals.allTerms.has(normalizePath(value))
      || tokens(value).some(term => signals.allTerms.has(term)));
    if (structuredMatches.length) { score += 90 + structuredMatches.length * 10; selectionSignals.push(`structured:${structuredMatches.join(',')}`); }
    score *= candidate.scopeWeight;
    if (candidate.scopeReason === 'primary') selectionSignals.push('scope:primary');
    else selectionSignals.push('scope:related');
    if (candidate.fromOverlay) selectionSignals.push('markdown-delta-overlay');
    return { score, selectionSignals };
  }

  signalSet(input = {}) {
    const primaryTexts = input.primaryTexts || [];
    const implementationTexts = input.implementationTexts || [];
    const assistantTexts = input.assistantTexts || [];
    const changedPaths = new Set((input.changedPaths || []).map(normalizePath).filter(Boolean));
    const implementationTokens = tokens(implementationTexts.join(' '));
    for (const changedPath of changedPaths) {
      implementationTokens.push(...tokens(changedPath), ...tokens(path.posix.basename(changedPath)));
    }
    const primaryTokens = tokens(primaryTexts.join(' '));
    const assistantTokens = tokens(assistantTexts.join(' '));
    const allTerms = new Set([...primaryTokens, ...implementationTokens]);
    return {
      primaryTokens,
      implementationTokens: [...new Set(implementationTokens)],
      assistantTokens,
      changedPaths,
      changedBasenames: new Set([...changedPaths].map(value => path.posix.basename(value))),
      allTerms,
      indexQuery: [...primaryTexts, ...implementationTexts].join('\n').slice(0, 12_000),
      signalHash: hash(JSON.stringify({ primaryTexts, implementationTexts, changedPaths: [...changedPaths], assistantHintHashes: assistantTexts.map(hash) })),
    };
  }

  async retrieve(input = {}) {
    const project = this.project(input);
    const scopes = Array.isArray(input.scopes) && input.scopes.length ? input.scopes : this.scopes(project);
    const signals = this.signalSet(input.signals);
    const scanned = this.scanCurrent(scopes);
    const health = { index: 'unknown', scopes: scanned.scopeHealth };
    await this.recallIndex(scopes, signals.indexQuery, scanned.candidates, health);
    const ranked = [];
    for (const candidate of scanned.candidates.values()) {
      const scored = this.score(candidate, signals);
      if (scored.score <= 0) continue;
      ranked.push({ ...candidate, relevanceScore: scored.score, selectionSignals: scored.selectionSignals });
    }
    ranked.sort((left, right) => right.relevanceScore - left.relevanceScore || left.recordId.localeCompare(right.recordId));
    return { project, scopes, signals, health, candidates: ranked.slice(0, this.candidateLimit), totalCurrentChunks: scanned.candidates.size };
  }

  async search(input = {}) {
    const query = String(input.query || '').trim();
    if (!query) throw new DomainError('INVALID_ARGUMENT', 'query is required.');
    const limit = Math.max(1, Math.min(Number(input.limit || 8), 30));
    const retrieved = await this.retrieve({ ...input, signals: { primaryTexts: [query] } });
    const results = retrieved.candidates.slice(0, limit).map(candidate => ({
      record_id: candidate.recordId,
      space_id: candidate.spaceId,
      entry_id: candidate.entryId,
      chunk_id: candidate.chunkId,
      chunk_order: candidate.chunkOrder,
      title: candidate.title,
      heading_path: candidate.headingPath.join(' > '),
      chunk_text: candidate.chunkText,
      document_hash: candidate.documentHash,
      content_hash: candidate.contentHash,
      relevance_score: candidate.relevanceScore,
      match_channels: candidate.selectionSignals,
      scope_reason: candidate.scopeReason,
      scope_project_id: candidate.projectId,
      from_delta_overlay: candidate.fromOverlay,
    }));
    await this.log('info', 'retrieval.search_completed', 'Knowledge search completed against authoritative Markdown.', {
      projectId: retrieved.project.projectId,
      component: 'knowledge-retrieval',
      context: { queryHash: hash(query), resultCount: results.length, backend: retrieved.health.index, currentChunkCount: retrieved.totalCurrentChunks },
    });
    return {
      ok: true,
      projectId: retrieved.project.projectId,
      projectSlug: retrieved.project.projectSlug || retrieved.project.projectId,
      query,
      backend: retrieved.health.index === 'ok' ? 'hybrid+markdown-truth' : 'markdown-hybrid-fallback',
      source: 'knowledge-retrieval-service',
      health: retrieved.health,
      results,
    };
  }

  async retrieveForCommit(input = {}) {
    const snapshot = input.conversationSnapshot || { turns: [] };
    const evidence = input.commitEvidence || {};
    const userTexts = (snapshot.turns || []).flatMap(turn => (turn.userEvents || []).map(event => event.content));
    const assistantTexts = (snapshot.turns || []).flatMap(turn => (turn.assistantEvents || []).map(event => event.content));
    const changedPaths = (evidence.files || []).flatMap(file => [file.path, file.oldPath]).filter(Boolean);
    const retrieved = await this.retrieve({
      projectId: input.projectId,
      project: input.project,
      signals: {
        primaryTexts: userTexts,
        assistantTexts,
        implementationTexts: [evidence.subject || '', ...(evidence.files || []).map(file => `${file.status || ''} ${file.path || ''}`)],
        changedPaths,
      },
    });
    const budget = Math.max(8 * 1024, Number(input.contextBudget || DEFAULT_CONTEXT_BUDGET));
    const selected = [];
    let totalBytes = 0;
    for (const candidate of retrieved.candidates) {
      const bytes = Buffer.byteLength(candidate.chunkText, 'utf8');
      if (totalBytes + bytes > budget) continue;
      totalBytes += bytes;
      selected.push(candidate);
    }
    const manifest = {
      schema: 'knowledge-retrieval-manifest/v1',
      projectId: retrieved.project.projectId,
      commitSha: evidence.commitSha || null,
      signalHash: retrieved.signals.signalHash,
      backend: retrieved.health.index,
      health: retrieved.health,
      indexGeneration: Object.fromEntries(retrieved.health.scopes.map(scope => [scope.projectId, scope.generation])),
      candidateCount: retrieved.candidates.length,
      currentChunkCount: retrieved.totalCurrentChunks,
      selected: selected.map(candidate => ({
        projectId: candidate.projectId,
        spaceId: candidate.spaceId,
        entryId: candidate.entryId,
        chunkId: candidate.chunkId,
        chunkOrder: candidate.chunkOrder,
        headingPath: candidate.headingPath,
        documentHash: candidate.documentHash,
        contentHash: candidate.contentHash,
        selectionSignals: candidate.selectionSignals,
        relevanceScore: candidate.relevanceScore,
        fromDeltaOverlay: candidate.fromOverlay,
        bytes: Buffer.byteLength(candidate.chunkText, 'utf8'),
      })),
      totalBytes,
      tokenEstimate: Math.ceil(totalBytes / 4),
      contextBudget: budget,
      manifestHash: '',
    };
    manifest.manifestHash = manifestHash(manifest);
    const entries = selected.map(candidate => ({
      path: candidate.entryId,
      projectId: candidate.projectId,
      spaceId: candidate.spaceId,
      chunkId: candidate.chunkId,
      headingPath: candidate.headingPath,
      hash: candidate.contentHash,
      documentHash: candidate.documentHash,
      content: candidate.chunkText,
      selectionSignals: candidate.selectionSignals,
    }));
    await this.log('info', 'retrieval.commit_context_frozen', 'Commit knowledge context was selected from authoritative Markdown.', {
      projectId: retrieved.project.projectId,
      commitSha: evidence.commitSha,
      component: 'knowledge-retrieval',
      context: { manifestHash: manifest.manifestHash, selectedCount: entries.length, totalBytes, candidateCount: manifest.candidateCount, backend: manifest.backend },
    });
    return { entries, omitted: [], totalBytes, limitBytes: budget, manifest, manifestHash: manifest.manifestHash };
  }
}

module.exports = {
  KnowledgeRetrievalService,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CANDIDATE_LIMIT,
  hash,
  tokens,
  normalizePath,
  manifestHash,
};
