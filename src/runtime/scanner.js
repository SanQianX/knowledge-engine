const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { execGit } = require('./git-runner');
const { DomainError } = require('./contracts');
const { ExactPatchEvidenceBundle } = require('./evidence-bundle');

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function validateSha(value, name = 'commit') {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new DomainError('INVALID_ARGUMENT', `${name} must be a full Git commit SHA.`);
  return sha;
}

function parseNameStatus(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
    const columns = line.split('\t');
    const status = columns.shift() || '';
    const renamed = /^[RC]/.test(status) && columns.length >= 2;
    return {
      status,
      path: renamed ? columns[1] : columns[0] || '',
      oldPath: renamed ? columns[0] : null,
      binary: false,
    };
  });
}

function applyNumstat(files, text) {
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const line of String(text || '').split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, ...nameParts] = line.split('\t');
    const name = nameParts[nameParts.length - 1] || '';
    const file = byPath.get(name);
    if (!file) continue;
    file.binary = added === '-' && deleted === '-';
    file.added = added === '-' ? null : Number(added);
    file.deleted = deleted === '-' ? null : Number(deleted);
  }
  return files;
}

class TrustedGitReader {
  constructor(options = {}) {
    this.execGit = options.execGit || execGit;
    this.maxPatchBytes = Number(options.maxPatchBytes || DEFAULT_MAX_PATCH_BYTES);
    this.evidenceBundle = options.evidenceBundle || new ExactPatchEvidenceBundle(options);
  }

  async run(repoPath, args, timeoutMs = 30_000) {
    const result = await this.execGit(repoPath, args, timeoutMs);
    if (!result || !result.ok) {
      throw new DomainError('INVALID_ARGUMENT', 'Trusted Git read failed.', {
        status: 409,
        details: { args: args.slice(0, 4), code: result && result.code, error: String(result && (result.stderr || result.error) || '').slice(0, 1000) },
      });
    }
    return String(result.stdout || '');
  }

  async runBuffer(repoPath, args, timeoutMs = 30_000) {
    const result = await this.execGit(repoPath, args, timeoutMs);
    if (!result || !result.ok) {
      throw new DomainError('INVALID_ARGUMENT', 'Trusted Git read failed.', {
        status: 409,
        details: { args: args.slice(0, 4), code: result && result.code, error: String(result && (result.stderr || result.error) || '').slice(0, 1000) },
      });
    }
    return Buffer.isBuffer(result.stdoutBuffer) ? result.stdoutBuffer : Buffer.from(String(result.stdout || ''), 'utf8');
  }

  async isRepository(repoPath) {
    if (!repoPath || !fs.existsSync(repoPath)) return false;
    const result = await this.execGit(repoPath, ['rev-parse', '--is-inside-work-tree'], 10_000);
    return Boolean(result && result.ok && String(result.stdout || '').trim() === 'true');
  }

  async head(repoPath) {
    const result = await this.execGit(repoPath, ['rev-parse', '--verify', 'HEAD'], 10_000);
    if (!result || !result.ok) return null;
    const sha = String(result.stdout || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async branch(repoPath) {
    const result = await this.execGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000);
    return result && result.ok ? String(result.stdout || '').trim() : '';
  }

  async isAncestor(repoPath, ancestor, commit) {
    validateSha(ancestor, 'baseline');
    validateSha(commit, 'HEAD');
    const result = await this.execGit(repoPath, ['merge-base', '--is-ancestor', ancestor, commit], 10_000);
    return Boolean(result && result.ok);
  }

  async listCommits(repoPath, baseline, head) {
    validateSha(head, 'HEAD');
    const revision = baseline ? `${validateSha(baseline, 'baseline')}..${head}` : head;
    const output = await this.run(repoPath, ['rev-list', '--reverse', '--topo-order', revision]);
    return output.split(/\r?\n/).map(value => value.trim().toLowerCase()).filter(value => /^[0-9a-f]{40}$/.test(value));
  }

  async collectEvidence(repoPath, commitSha, options = {}) {
    const commit = validateSha(commitSha);
    const raw = await this.run(repoPath, ['show', '-s', '--date=iso-strict', '--format=%H%x00%P%x00%an%x00%aI%x00%s', commit]);
    const [resolved, parentsRaw, author, date, ...subjectParts] = raw.replace(/\r?\n$/, '').split('\u0000');
    const parents = String(parentsRaw || '').split(/\s+/).filter(Boolean).map(parent => validateSha(parent, 'parent'));
    const nameStatus = await this.run(repoPath, ['diff-tree', '--root', '--find-renames', '--name-status', '-r', '--no-commit-id', commit]);
    const numstat = await this.run(repoPath, ['diff-tree', '--root', '--find-renames', '--numstat', '-r', '--no-commit-id', commit]);
    const files = applyNumstat(parseNameStatus(nameStatus), numstat);
    const base = parents.length ? parents[0] : EMPTY_TREE_SHA;
    const patchBuffer = await this.runBuffer(repoPath, ['diff', '--no-ext-diff', '--binary', '--find-renames', '--unified=3', base, commit], options.patchTimeoutMs || 60_000);
    const patchBytes = patchBuffer.length;
    const maxPatchBytes = Number(options.maxPatchBytes || this.maxPatchBytes);
    let patch = null;
    try { patch = new TextDecoder('utf-8', { fatal: true }).decode(patchBuffer); } catch { patch = null; }
    const patchChunked = patchBytes > maxPatchBytes || patch == null;
    const branch = options.branch != null ? String(options.branch) : await this.branch(repoPath);
    const metadata = {
      commitSha: resolved || commit,
      parents,
      author: author || '',
      date: date || '',
      subject: subjectParts.join('\u0000').trim(),
      branch,
      patchBase: base,
      patchMode: parents.length > 1 ? 'merge-first-parent' : parents.length === 0 ? 'root-empty-tree' : 'parent',
    };
    const patchHash = sha256(patchBuffer);
    if (patchChunked && !options.evidenceRoot) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Large patch requires an exact evidence bundle root.', { status: 500 });
    }
    const evidenceBundle = options.evidenceRoot ? this.evidenceBundle.build({
      evidenceRoot: options.evidenceRoot,
      patch: patchBuffer,
      patchHash,
      commit: metadata,
      files,
    }) : null;
    const evidenceHash = sha256(JSON.stringify({
      metadata,
      files,
      patchHash,
      patchBytes,
      evidenceManifestHash: evidenceBundle && evidenceBundle.manifestHash || null,
    }));
    return {
      schema: 'commit-evidence/v1',
      ...metadata,
      files,
      patch: patchChunked ? null : patch,
      patchHash,
      patchBytes,
      patchInline: !patchChunked,
      patchChunked,
      patchOmitted: false,
      patchLimitBytes: maxPatchBytes,
      omittedReason: null,
      evidenceBundle,
      evidenceHash,
    };
  }

  verifyEvidence(evidence) {
    if (!evidence || !evidence.patchHash || !Number.isInteger(evidence.patchBytes)) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Commit evidence is incomplete.', { status: 500 });
    }
    if (evidence.evidenceBundle) {
      return this.evidenceBundle.verify(evidence.evidenceBundle.root, {
        expectedPatchHash: evidence.patchHash,
        expectedBytes: evidence.patchBytes,
      });
    }
    if (evidence.patchChunked) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Chunked patch has no frozen evidence bundle.', { status: 500 });
    }
    if (sha256(evidence.patch || '') !== evidence.patchHash) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Inline patch hash does not match.', { status: 500 });
    }
    return null;
  }
}

class CommitScanner {
  constructor(options = {}) {
    this.git = options.gitReader || new TrustedGitReader(options);
    this.batchSize = Math.max(1, Number(options.batchSize || 200));
  }

  async scan(config, state, options = {}) {
    const repoPath = config && config.repoPath;
    if (!repoPath || !await this.git.isRepository(repoPath)) {
      return { status: 'not-git', head: null, baseline: null, commits: [], continuation: null, error: 'repoPath is not an available Git worktree' };
    }
    const head = await this.git.head(repoPath);
    if (!head) {
      return { status: 'empty-repo', head: null, baseline: null, commits: [], continuation: null, branch: await this.git.branch(repoPath) };
    }
    const branch = await this.git.branch(repoPath);
    const last = state && state.lastAnalyzedCommit || null;
    const tracking = state && state.trackingStartCommit || null;
    const baseline = last || tracking || null;
    if (!baseline && (!state || state.trackingMode !== 'empty-repo')) {
      return { status: 'establish-tracking', head, baseline: null, commits: [], continuation: null, branch };
    }
    if (baseline && !await this.git.isAncestor(repoPath, baseline, head)) {
      return { status: 'history-diverged', head, baseline, commits: [], continuation: null, branch, error: 'tracking baseline is not an ancestor of HEAD' };
    }
    const all = await this.git.listCommits(repoPath, baseline, head);
    const batchSize = Math.max(1, Number(options.batchSize || this.batchSize));
    const commits = all.slice(0, batchSize);
    return {
      status: 'ok',
      head,
      baseline,
      branch,
      commits,
      pendingCount: all.length,
      continuation: all.length > commits.length ? { remaining: all.length - commits.length, after: commits[commits.length - 1] } : null,
    };
  }

  collectEvidence(config, commitSha, options = {}) {
    return this.git.collectEvidence(config.repoPath, commitSha, options);
  }

  verifyEvidence(evidence) {
    return this.git.verifyEvidence(evidence);
  }
}

// Transitional read-only adapter for callers migrated in T10.
async function scanProject(project, options = {}) {
  const scanner = options.scanner || new CommitScanner(options);
  const config = { repoPath: project && (project.repoPath || project.gitPath || project.localPath) };
  const state = {
    lastAnalyzedCommit: project && project.lastAnalyzedCommit || null,
    trackingStartCommit: project && project.trackingStartCommit || null,
    trackingMode: project && project.trackingMode || 'normal',
  };
  const scan = await scanner.scan(config, state, options);
  const result = {
    slug: project && (project.projectId || project.slug),
    repoStatus: scan.status === 'empty-repo' ? 'empty' : scan.status === 'not-git' ? 'not-git' : scan.status === 'history-diverged' ? 'diverged' : 'ok',
    headCommit: scan.head,
    lastAnalyzedCommit: state.lastAnalyzedCommit,
    trackingStartCommit: scan.status === 'establish-tracking' ? scan.head : state.trackingStartCommit,
    pendingCount: scan.commits.length,
    mode: scan.status === 'establish-tracking' ? 'tracking-start' : state.lastAnalyzedCommit ? 'incremental' : state.trackingMode === 'empty-repo' ? 'empty-repo-first-commit' : 'tracked',
    range: scan.baseline && scan.head ? `${scan.baseline}..${scan.head}` : null,
    commits: [],
    continuation: scan.continuation,
    error: scan.error || null,
  };
  for (const commitSha of scan.commits) {
    const evidence = await scanner.collectEvidence(config, commitSha, { branch: scan.branch });
    result.commits.push({
      hash: commitSha,
      short: commitSha.slice(0, 7),
      date: evidence.date,
      author: evidence.author,
      subject: evidence.subject,
    });
  }
  return result;
}

async function applyScanResult(project, scan) {
  project.headCommit = scan.headCommit;
  project.repoStatus = scan.repoStatus;
  if (!project.trackingStartCommit && scan.trackingStartCommit) project.trackingStartCommit = scan.trackingStartCommit;
  project.lastSeenCommit = scan.headCommit || project.lastSeenCommit;
  project.lastScanAt = new Date().toISOString();
  project.lastScanPendingCount = scan.pendingCount;
  project.lastScanMode = scan.mode;
  project.lastScanError = scan.error || null;
  return project;
}

module.exports = {
  EMPTY_TREE_SHA,
  DEFAULT_MAX_PATCH_BYTES,
  TrustedGitReader,
  CommitScanner,
  scanProject,
  applyScanResult,
  parseNameStatus,
  sha256,
  validateSha,
};
