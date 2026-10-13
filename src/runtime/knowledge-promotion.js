const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const AtomicFile = require('./atomic-file');
const { DomainError, createId, validateProjectId } = require('./contracts');
const { buildAutomationToolPolicy } = require('./automation-config');
const { execGit } = require('./git-runner');

const MANIFEST_SCHEMA = 'knowledge-staging-manifest/v1';
const JOURNAL_SCHEMA = 'promotion-journal/v1';
const MAX_KNOWLEDGE_FILE_BYTES = 1024 * 1024;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fileHash(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? hashBuffer(fs.readFileSync(filePath))
    : null;
}

function canonicalRelativePath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\\') || raw.includes('\u0000') || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new DomainError('PATH_OUTSIDE_ROOT', 'Manifest path must be a canonical relative POSIX path.');
  }
  const segments = raw.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':') || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment))) {
    throw new DomainError('PATH_OUTSIDE_ROOT', 'Manifest path contains an unsafe segment.');
  }
  if (!raw.toLowerCase().endsWith('.md') || segments.some(segment => segment.toLowerCase() === '00-index.md')) {
    throw new DomainError('INVALID_ARGUMENT', 'Knowledge operations may target non-derived Markdown files only.');
  }
  const topLevel = segments.length === 1 && ['README.md', 'GOAL.md', 'ARCHITECTURE.md'].includes(segments[0]);
  const collection = segments.length >= 2 && ['modules', 'changes'].includes(segments[0]);
  if (!topLevel && !collection) throw new DomainError('PATH_OUTSIDE_ROOT', 'Manifest path is outside the allowed knowledge structure.');
  return raw;
}

function decodeUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (error) { throw new DomainError('INVALID_ARGUMENT', 'Staged Markdown must be valid UTF-8.', { cause: error }); }
}

function validateMarkdown(content, relativePath) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new DomainError('INVALID_ARGUMENT', `Staged Markdown contains disallowed control characters: ${relativePath}.`);
  }
  if (!content.trim() || !/^#\s+\S+/m.test(content)) throw new DomainError('INVALID_ARGUMENT', `Staged Markdown must contain a title: ${relativePath}.`);
  // UI attributes and quoted source examples describe real changes; they are
  // not unfinished prose. Still reject a document containing only a quoted
  // unfinished marker, so fencing a placeholder cannot make it valid knowledge.
  const marker = /(?:\[TODO:|\bTODO:\s|\bTBD\b|\bPLACEHOLDER\b(?!\s*=))/i;
  const prose = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?:\n|$)/gm, '')
    .replace(/(`+)[^\n]*?\1/g, '');
  if (marker.test(prose) || !prose.replace(/^#{1,6}[ \t]+.*$/gm, '').trim() && marker.test(content)) {
    throw new DomainError('INVALID_ARGUMENT', `Placeholder knowledge is not allowed: ${relativePath}.`);
  }
  const fences = content.match(/^```/gm) || [];
  if (fences.length % 2 !== 0) throw new DomainError('INVALID_ARGUMENT', `Markdown code fences are unbalanced: ${relativePath}.`);
  if (content.startsWith('---\n') && !/^---\n[\s\S]*?\n---\n/.test(content)) {
    throw new DomainError('INVALID_ARGUMENT', `Markdown frontmatter is incomplete: ${relativePath}.`);
  }
  return true;
}

async function gitStatus(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return null;
  const result = await execGit(repoPath, ['status', '--porcelain=v1', '-z'], 15_000);
  return result && result.ok ? String(result.stdout || '') : null;
}

class KnowledgePromotionService {
  constructor(options = {}) {
    this.layout = options.layout;
    this.projectStore = options.projectStore;
    this.analyzer = options.analyzer || null;
    this.indexService = options.indexService || null;
    this.atomic = options.atomic || AtomicFile;
    this.logger = options.logger || null;
    this.maxFileBytes = Number(options.maxFileBytes || MAX_KNOWLEDGE_FILE_BYTES);
    this.fault = options.fault || (() => {});
  }

  runRoot(projectId, runId) { return this.layout.getRuntimePath('runs', validateProjectId(projectId), String(runId)); }
  stagingPath(projectId, runId) { return path.join(this.runRoot(projectId, runId), 'output'); }
  evidenceRoot(projectId, runId) { return path.join(this.runRoot(projectId, runId), 'input', 'evidence'); }

  manifestPath(projectId, runId) { return path.join(this.stagingPath(projectId, runId), 'manifest.json'); }
  journalPath(projectId, runId) { return this.layout.getRuntimePath('promotions', validateProjectId(projectId), `${runId}.json`); }
  backupRoot(projectId, runId) { return this.layout.getRecoveryPath('promotions', validateProjectId(projectId), String(runId)); }

  async log(level, event, message, context) {
    if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
  }

  prepareStaging(projectId, runId) {
    const staging = this.stagingPath(projectId, runId);
    const discardStaging = () => {
      if (!this.layout.isPathInside(this.runRoot(projectId, runId), staging, { realpath: true }) || fs.lstatSync(staging).isSymbolicLink()) throw new DomainError('PATH_OUTSIDE_ROOT', 'Unsafe staging cleanup.');
      const remove = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) remove(target); else fs.unlinkSync(target);
        }
        fs.rmdirSync(directory);
      };
      remove(staging);
    };
    if (fs.existsSync(staging)) {
      const entries = fs.readdirSync(staging);
      if (entries.length) {
        const journalFile = this.journalPath(projectId, runId);
        if (!fs.existsSync(journalFile)) {
          discardStaging();
        } else {
          const journal = this.atomic.readJsonStrict(journalFile, { category: 'promotion-journal' });
          if (journal.phase === 'rolled-back') discardStaging();
          else throw new DomainError('MIGRATION_TARGET_CONFLICT', 'Run staging is owned by an unfinished promotion journal.', { status: 409 });
        }
      }
    }
    fs.mkdirSync(path.join(staging, 'files'), { recursive: true });
    return staging;
  }

  readManifest(projectId, runId) {
    return this.atomic.readJsonStrict(this.manifestPath(projectId, runId), {
      category: 'knowledge-staging-manifest',
      validate: manifest => {
        if (!manifest || manifest.schema !== MANIFEST_SCHEMA || manifest.projectId !== projectId || manifest.runId !== runId || !Array.isArray(manifest.operations)) {
          throw new DomainError('DATA_CORRUPT', 'Knowledge staging manifest is invalid.', { status: 500 });
        }
        return manifest;
      },
    });
  }

  validateManifest(input) {
    const { projectId, config, claim } = input;
    const manifest = this.readManifest(projectId, claim.runId);
    if (manifest.commitSha !== claim.commitSha || manifest.operations.length === 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Manifest must contain operations for the active commit.');
    }
    const seen = new Set();
    const operations = [];
    for (const [index, raw] of manifest.operations.entries()) {
      const relativePath = canonicalRelativePath(raw.path);
      if (seen.has(relativePath.toLowerCase())) throw new DomainError('INVALID_ARGUMENT', `Duplicate manifest path: ${relativePath}.`);
      seen.add(relativePath.toLowerCase());
      const operation = String(raw.operation || '');
      if (!['create', 'replace', 'delete'].includes(operation)) throw new DomainError('INVALID_ARGUMENT', `Invalid manifest operation: ${operation}.`);
      if (!String(raw.reason || '').trim() || !Array.isArray(raw.evidenceReferences) || raw.evidenceReferences.length === 0) {
        throw new DomainError('INVALID_ARGUMENT', `Manifest operation lacks reason/evidence: ${relativePath}.`);
      }
      const evidenceReferences = raw.evidenceReferences.map(String);
      const requiredEvidence = [
        `commit:${claim.commitSha}`,
        claim.patchHash && `patch:${claim.patchHash}`,
        claim.conversationSnapshotHash && `conversation:${claim.conversationSnapshotHash}`,
        claim.retrievalManifestHash && `retrieval:${claim.retrievalManifestHash}`,
      ].filter(Boolean);
      const missingEvidence = requiredEvidence.filter(reference => !evidenceReferences.includes(reference));
      if (missingEvidence.length) {
        throw new DomainError('INVALID_ARGUMENT', `Manifest operation lacks frozen claim evidence: ${relativePath}.`, {
          details: { missingEvidence },
        });
      }
      const target = path.resolve(config.knowledgePath, ...relativePath.split('/'));
      if (!this.layout.isPathInside(config.knowledgePath, target, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', `Final knowledge path escapes its project: ${relativePath}.`);
      const targetExists = fs.existsSync(target);
      if (targetExists && fs.lstatSync(target).isSymbolicLink()) throw new DomainError('PATH_OUTSIDE_ROOT', `Final knowledge target is a symlink: ${relativePath}.`);
      if (operation === 'create' && targetExists) throw new DomainError('MIGRATION_TARGET_CONFLICT', `Create target already exists: ${relativePath}.`, { status: 409 });
      if ((operation === 'replace' || operation === 'delete') && (!targetExists || !fs.statSync(target).isFile())) {
        throw new DomainError('INVALID_ARGUMENT', `${operation} target is not an owned project knowledge file: ${relativePath}.`);
      }
      let stagedPath = null;
      let newHash = null;
      if (operation !== 'delete') {
        stagedPath = path.join(this.stagingPath(projectId, claim.runId), 'files', ...relativePath.split('/'));
        if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile() || fs.lstatSync(stagedPath).isSymbolicLink()) {
          throw new DomainError('INVALID_ARGUMENT', `Staged Markdown is missing or unsafe: ${relativePath}.`);
        }
        const realStaged = fs.realpathSync(stagedPath);
        if (!this.layout.isPathInside(this.stagingPath(projectId, claim.runId), realStaged, { realpath: true })) {
          throw new DomainError('PATH_OUTSIDE_ROOT', `Staged file escapes run staging: ${relativePath}.`);
        }
        const buffer = fs.readFileSync(stagedPath);
        if (buffer.length > this.maxFileBytes) throw new DomainError('INVALID_ARGUMENT', `Staged Markdown exceeds size limit: ${relativePath}.`);
        const content = decodeUtf8(buffer);
        validateMarkdown(content, relativePath);
        newHash = hashBuffer(buffer);
        if (raw.sha256 !== newHash) throw new DomainError('DATA_CORRUPT', `Staged Markdown hash mismatch: ${relativePath}.`, { status: 409 });
      } else if (raw.sha256 != null) {
        throw new DomainError('INVALID_ARGUMENT', `Delete operation must not declare a new hash: ${relativePath}.`);
      }
      operations.push({
        index,
        path: relativePath,
        operation,
        reason: String(raw.reason),
        evidenceReferences,
        target,
        stagedPath,
        originalExists: targetExists,
        originalHash: targetExists ? fileHash(target) : null,
        newHash,
      });
    }
    return { manifest, operations: operations.sort((left, right) => left.path.localeCompare(right.path)) };
  }

  writeJournal(journal) {
    journal.updatedAt = new Date().toISOString();
    this.atomic.writeJsonAtomic(this.journalPath(journal.projectId, journal.runId), journal);
  }

  prepareJournal(projectId, config, claim, validated) {
    const backupRoot = this.backupRoot(projectId, claim.runId);
    const journal = {
      schema: JOURNAL_SCHEMA,
      projectId,
      runId: claim.runId,
      commitSha: claim.commitSha,
      claimFingerprint: claim.fingerprint,
      evidence: {
        promptHash: claim.promptHash || null,
        patchHash: claim.patchHash || null,
        evidenceManifestHash: claim.evidenceManifestHash || null,
        conversationSnapshotHash: claim.conversationSnapshotHash || null,
        retrievalManifestHash: claim.retrievalManifestHash || null,
      },
      knowledgePath: config.knowledgePath,
      phase: 'preparing',
      createdAt: new Date().toISOString(),
      operations: validated.operations.map((operation, index) => ({
        ...operation,
        backupPath: operation.originalExists ? path.join(backupRoot, `${String(index).padStart(4, '0')}.backup`) : null,
        applied: false,
      })),
    };
    this.writeJournal(journal);
    for (const operation of journal.operations) {
      if (!operation.originalExists) continue;
      const currentHash = fileHash(operation.target);
      if (currentHash !== operation.originalHash) throw new DomainError('PROJECT_BUSY', `Knowledge changed before backup: ${operation.path}.`, { status: 409, retryable: true });
      this.atomic.writeFileAtomic(operation.backupPath, fs.readFileSync(operation.target));
      if (fileHash(operation.backupPath) !== operation.originalHash) throw new DomainError('DATA_CORRUPT', `Knowledge backup verification failed: ${operation.path}.`, { status: 500 });
    }
    journal.phase = 'prepared';
    this.writeJournal(journal);
    this.fault('journal-prepared', journal);
    return journal;
  }

  applyJournal(journal) {
    journal.phase = 'applying';
    this.writeJournal(journal);
    for (let index = 0; index < journal.operations.length; index += 1) {
      const operation = journal.operations[index];
      const currentHash = fileHash(operation.target);
      if (currentHash !== operation.originalHash) {
        throw new DomainError('PROJECT_BUSY', `Knowledge changed before promotion: ${operation.path}.`, { status: 409, retryable: true });
      }
      if (operation.operation === 'delete') fs.unlinkSync(operation.target);
      else this.atomic.writeFileAtomic(operation.target, fs.readFileSync(operation.stagedPath));
      operation.applied = true;
      this.writeJournal(journal);
      this.fault(`operation-applied:${index}`, journal);
    }
    this.verifyPromoted(journal);
    journal.phase = 'awaiting-state-advance';
    this.writeJournal(journal);
    this.fault('promotion-verified', journal);
    return journal;
  }

  verifyPromoted(journal) {
    for (const operation of journal.operations) {
      const actual = fileHash(operation.target);
      if (operation.operation === 'delete' ? actual !== null : actual !== operation.newHash) {
        throw new DomainError('DATA_CORRUPT', `Promoted knowledge verification failed: ${operation.path}.`, { status: 500 });
      }
    }
    return true;
  }

  async advanceState(journal) {
    const current = this.projectStore.readState(journal.projectId);
    if (current.lastAnalyzedCommit === journal.commitSha && !current.analysis.activeClaim) return current;
    const advanced = await this.projectStore.updateState(journal.projectId, state => {
      const active = state.analysis.activeClaim;
      if (!active || active.runId !== journal.runId || active.commitSha !== journal.commitSha || active.fingerprint !== journal.claimFingerprint) {
        throw new DomainError('PROJECT_BUSY', 'Promotion journal no longer matches the active claim.', { status: 409, retryable: true });
      }
      state.lastAnalyzedCommit = journal.commitSha;
      state.analysis.consumedRequirementIds = [...new Set([
        ...(state.analysis.consumedRequirementIds || []),
        ...(active.requirementIds || []),
      ])];
      state.analysis.activeClaim = null;
      state.analysis.status = 'state.advanced';
      state.analysis.lastError = null;
      state.index.dirty = true;
      state.index.sinceCommit = state.index.sinceCommit || journal.commitSha;
      state.index.generation = Number(state.index.generation || 0) + 1;
      state.index.lastError = null;
    });
    this.fault('state-advanced', journal);
    return advanced;
  }

  async processClaim(input = {}) {
    const projectId = validateProjectId(input.projectId);
    const config = input.config || this.projectStore.readConfig(projectId);
    const claim = input.claim;
    if (!claim || claim.projectId !== projectId || !claim.runId || !claim.commitSha) throw new DomainError('INVALID_ARGUMENT', 'Active claim is required for knowledge promotion.');
    const operationId = input.operationId || claim.operationId || createId('op');
    const stagingPath = this.prepareStaging(projectId, claim.runId);
    // The isolated worker cannot read or write the live repository. A user may
    // keep developing while it consumes frozen evidence; live status is neither
    // its input nor proof of worker writes. Keep the guard for other analyzers.
    const verifyLiveSource = this.analyzer?.sourceReadMode !== 'isolated-frozen-evidence';
    const beforeSource = verifyLiveSource ? await gitStatus(config.repoPath) : null;
    try {
      if (!this.analyzer || typeof this.analyzer.runClaim !== 'function') throw new DomainError('INVALID_ARGUMENT', 'Knowledge analyzer is unavailable.', { status: 503, retryable: true });
      const analyzerResult = await this.analyzer.runClaim({
        ...input,
        projectId,
        config,
        claim,
        stagingPath,
        manifestPath: this.manifestPath(projectId, claim.runId),
        evidenceRoot: this.evidenceRoot(projectId, claim.runId),
        safetyPolicy: buildAutomationToolPolicy({
          stagingPath,
          evidenceRoot: this.evidenceRoot(projectId, claim.runId),
        }),
      });
      if (analyzerResult && analyzerResult.ok === false) throw new DomainError('INVALID_ARGUMENT', analyzerResult.error || 'Knowledge analyzer failed.', { status: 500, retryable: true });
      const afterSource = verifyLiveSource ? await gitStatus(config.repoPath) : null;
      if (beforeSource != null && afterSource != null && beforeSource !== afterSource) {
        throw new DomainError('PROJECT_BUSY', 'Source repository changed during knowledge analysis.', { status: 409, retryable: true });
      }
      this.fault('analysis-completed', { projectId, claim, stagingPath });
      const validated = this.validateManifest({ projectId, config, claim });
      this.fault('manifest-validated', validated);
      const journal = this.prepareJournal(projectId, config, claim, validated);
      this.applyJournal(journal);
      await this.advanceState(journal);
      journal.phase = 'completed';
      journal.completedAt = new Date().toISOString();
      this.writeJournal(journal);
      await this.log('info', 'knowledge.promotion_completed', 'Validated knowledge was promoted and state advanced.', {
        projectId,
        operationId,
        runId: claim.runId,
        commitSha: claim.commitSha,
        phase: 'state.advanced',
        operationCount: journal.operations.length,
      });
      if (this.indexService && typeof this.indexService.enqueue === 'function') this.indexService.enqueue(projectId).catch(() => {});
      return { ok: true, stateAdvanced: true, projectId, runId: claim.runId, commitSha: claim.commitSha, operations: journal.operations.length };
    } catch (error) {
      await this.log('error', 'knowledge.promotion_failed', 'Knowledge analysis/promotion failed without advancing state.', {
        projectId,
        operationId,
        runId: claim.runId,
        commitSha: claim.commitSha,
        phase: 'promotion',
        error,
      });
      throw error;
    }
  }

  rollbackJournal(journal) {
    let conflict = null;
    for (const operation of [...journal.operations].reverse()) {
      if (!operation.applied) continue;
      const currentHash = fileHash(operation.target);
      const expectedApplied = operation.operation === 'delete' ? null : operation.newHash;
      if (currentHash !== expectedApplied) {
        conflict = operation.path;
        break;
      }
      if (operation.originalExists) this.atomic.writeFileAtomic(operation.target, fs.readFileSync(operation.backupPath));
      else if (fs.existsSync(operation.target)) fs.unlinkSync(operation.target);
    }
    if (conflict) {
      journal.phase = 'recovery-conflict';
      journal.error = `User-visible knowledge changed after crash: ${conflict}`;
    } else {
      journal.phase = 'rolled-back';
      journal.rolledBackAt = new Date().toISOString();
    }
    this.writeJournal(journal);
    return { ok: !conflict, phase: journal.phase, conflict };
  }

  async recoverJournal(journal) {
    if (journal.phase === 'completed' || journal.phase === 'rolled-back') return { ok: true, phase: journal.phase, skipped: true };
    const appliedCount = journal.operations.filter(operation => operation.applied).length;
    const allApplied = appliedCount === journal.operations.length;
    if (journal.phase === 'awaiting-state-advance' || (allApplied && ['applying', 'prepared'].includes(journal.phase))) {
      this.verifyPromoted(journal);
      await this.advanceState(journal);
      journal.phase = 'completed';
      journal.recoveredAt = new Date().toISOString();
      this.writeJournal(journal);
      if (this.indexService && typeof this.indexService.enqueue === 'function') this.indexService.enqueue(journal.projectId).catch(() => {});
      return { ok: true, phase: 'completed', stateAdvanced: true };
    }
    return this.rollbackJournal(journal);
  }

  async recoverAll() {
    const root = this.layout.getRuntimePath('promotions');
    if (!fs.existsSync(root)) return [];
    const files = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(absolute);
      }
    };
    walk(root);
    const results = [];
    for (const file of files.sort()) {
      const journal = this.atomic.readJsonStrict(file, {
        category: 'promotion-journal',
        validate: value => {
          if (!value || value.schema !== JOURNAL_SCHEMA || !Array.isArray(value.operations)) throw new DomainError('DATA_CORRUPT', 'Promotion journal is corrupt.', { status: 500 });
          return value;
        },
      });
      results.push({ file, ...(await this.recoverJournal(journal)) });
    }
    return results;
  }
}

module.exports = {
  JOURNAL_SCHEMA,
  MANIFEST_SCHEMA,
  MAX_KNOWLEDGE_FILE_BYTES,
  KnowledgePromotionService,
  canonicalRelativePath,
  fileHash,
  hashBuffer,
  validateMarkdown,
};
