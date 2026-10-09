const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AtomicFile = require('./atomic-file');
const { DomainError } = require('./contracts');

const PATCH_MANIFEST_SCHEMA = 'patch-evidence-manifest/v1';
const COMMIT_EVIDENCE_SCHEMA = 'commit-evidence-bundle/v1';
const DEFAULT_CHUNK_BYTES = 512 * 1024;

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function manifestPayload(manifest) {
  const { manifestHash, ...payload } = manifest;
  return payload;
}

function lineSafeChunks(buffer, maxChunkBytes = DEFAULT_CHUNK_BYTES) {
  const limit = Math.max(64 * 1024, Number(maxChunkBytes || DEFAULT_CHUNK_BYTES));
  const chunks = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(buffer.length, start + limit);
    if (end < buffer.length) {
      const previousNewline = buffer.lastIndexOf(0x0a, end - 1);
      if (previousNewline >= start) end = previousNewline + 1;
      else {
        const nextNewline = buffer.indexOf(0x0a, end);
        end = nextNewline === -1 ? buffer.length : nextNewline + 1;
      }
    }
    if (end <= start) end = buffer.length;
    chunks.push(buffer.subarray(start, end));
    start = end;
  }
  if (!chunks.length) chunks.push(Buffer.alloc(0));
  return chunks;
}

function chunkMetadata(buffer, inheritedSourcePaths = []) {
  const text = buffer.toString('utf8');
  const sourcePaths = [...inheritedSourcePaths];
  const hunks = [];
  for (const line of text.split('\n')) {
    const diff = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff) {
      sourcePaths.push(diff[1], diff[2]);
      continue;
    }
    if (line.startsWith('@@')) hunks.push(line.slice(0, 512));
  }
  return {
    sourcePaths: [...new Set(sourcePaths)],
    hunkHeaders: hunks,
  };
}

function readManifestStrict(manifestPath, atomic = AtomicFile) {
  return atomic.readJsonStrict(manifestPath, {
    category: 'patch-evidence-manifest',
    validate: manifest => {
      if (!manifest || manifest.schema !== PATCH_MANIFEST_SCHEMA || !Array.isArray(manifest.chunks)
        || !manifest.fullPatchHash || !Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 0
        || manifest.chunkCount !== manifest.chunks.length) {
        throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence manifest is invalid.', { status: 500 });
      }
      if (manifest.manifestHash !== hashBuffer(Buffer.from(JSON.stringify(manifestPayload(manifest)), 'utf8'))) {
        throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence manifest hash does not match.', { status: 500 });
      }
      return manifest;
    },
  });
}

function safeChunkPath(evidenceRoot, relativePath) {
  if (!/^patches\/\d{6}\.patch$/.test(String(relativePath || ''))) {
    throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunk path is invalid.', { status: 500 });
  }
  const root = path.resolve(evidenceRoot);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunk escapes its read-only root.', { status: 500 });
  }
  return target;
}

class ExactPatchEvidenceBundle {
  constructor(options = {}) {
    this.atomic = options.atomic || AtomicFile;
    this.maxChunkBytes = Number(options.maxChunkBytes || DEFAULT_CHUNK_BYTES);
  }

  build(input = {}) {
    const evidenceRoot = path.resolve(String(input.evidenceRoot || ''));
    if (!input.evidenceRoot) throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence root is required.', { status: 500 });
    const patch = Buffer.isBuffer(input.patch) ? input.patch : Buffer.from(String(input.patch || ''), 'utf8');
    const fullPatchHash = hashBuffer(patch);
    if (input.patchHash && input.patchHash !== fullPatchHash) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Full patch hash changed before evidence bundling.', { status: 500 });
    }
    const manifestPath = path.join(evidenceRoot, 'patch-manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = this.verify(evidenceRoot, { expectedPatchHash: fullPatchHash, expectedBytes: patch.length });
      return this.describe(evidenceRoot, manifest);
    }

    fs.mkdirSync(path.join(evidenceRoot, 'patches'), { recursive: true });
    const chunks = lineSafeChunks(patch, this.maxChunkBytes);
    let activeSourcePaths = [];
    const records = chunks.map((chunk, index) => {
      const relativePath = `patches/${String(index + 1).padStart(6, '0')}.patch`;
      const filePath = safeChunkPath(evidenceRoot, relativePath);
      this.atomic.writeFileAtomic(filePath, chunk);
      const metadata = chunkMetadata(chunk, activeSourcePaths);
      if (metadata.sourcePaths.length) activeSourcePaths = metadata.sourcePaths.slice(-2);
      return {
        sequence: index + 1,
        path: relativePath,
        bytes: chunk.length,
        sha256: hashBuffer(chunk),
        ...metadata,
      };
    });
    const manifest = {
      schema: PATCH_MANIFEST_SCHEMA,
      fullPatchHash,
      totalBytes: patch.length,
      chunkCount: records.length,
      chunks: records,
      manifestHash: '',
    };
    manifest.manifestHash = hashBuffer(Buffer.from(JSON.stringify(manifestPayload(manifest)), 'utf8'));
    this.atomic.writeJsonAtomic(manifestPath, manifest);
    const commitEvidence = {
      schema: COMMIT_EVIDENCE_SCHEMA,
      commit: input.commit || {},
      files: input.files || [],
      fullPatchHash,
      totalBytes: patch.length,
      patchManifestHash: manifest.manifestHash,
    };
    this.atomic.writeJsonAtomic(path.join(evidenceRoot, 'commit.json'), commitEvidence);
    this.verify(evidenceRoot, { expectedPatchHash: fullPatchHash, expectedBytes: patch.length });
    return this.describe(evidenceRoot, manifest);
  }

  verify(evidenceRoot, expected = {}) {
    try {
      return this.verifyUnchecked(evidenceRoot, expected);
    } catch (error) {
      if (error && error.code === 'EVIDENCE_INTEGRITY_FAILED') throw error;
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence bundle could not be read or verified.', {
        status: 500,
        cause: error,
        retryable: true,
      });
    }
  }

  verifyUnchecked(evidenceRoot, expected = {}) {
    const root = path.resolve(evidenceRoot);
    const manifest = readManifestStrict(path.join(root, 'patch-manifest.json'), this.atomic);
    const commitEvidence = this.atomic.readJsonStrict(path.join(root, 'commit.json'), {
      category: 'commit-evidence-bundle',
      validate: value => {
        if (!value || value.schema !== COMMIT_EVIDENCE_SCHEMA || value.fullPatchHash !== manifest.fullPatchHash
          || value.totalBytes !== manifest.totalBytes || value.patchManifestHash !== manifest.manifestHash
          || !value.commit || !Array.isArray(value.files)) {
          throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Commit evidence metadata does not match the patch manifest.', { status: 500 });
        }
        return value;
      },
    });
    if (expected.expectedPatchHash && manifest.fullPatchHash !== expected.expectedPatchHash) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Frozen patch evidence hash does not match the claim.', { status: 500 });
    }
    if (expected.expectedBytes != null && manifest.totalBytes !== expected.expectedBytes) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Frozen patch evidence byte count does not match the claim.', { status: 500 });
    }
    const aggregate = crypto.createHash('sha256');
    let bytes = 0;
    manifest.chunks.forEach((chunk, index) => {
      if (chunk.sequence !== index + 1 || !Number.isInteger(chunk.bytes) || chunk.bytes < 0 || !chunk.sha256) {
        throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunk order or metadata is invalid.', { status: 500 });
      }
      const filePath = safeChunkPath(root, chunk.path);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) {
        throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunk is missing or unsafe.', { status: 500 });
      }
      const value = fs.readFileSync(filePath);
      if (value.length !== chunk.bytes || hashBuffer(value) !== chunk.sha256) {
        throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunk failed integrity validation.', { status: 500 });
      }
      aggregate.update(value);
      bytes += value.length;
    });
    if (bytes !== manifest.totalBytes || `sha256:${aggregate.digest('hex')}` !== manifest.fullPatchHash) {
      throw new DomainError('EVIDENCE_INTEGRITY_FAILED', 'Patch evidence chunks do not exactly cover the full diff.', { status: 500 });
    }
    void commitEvidence;
    return manifest;
  }

  describe(evidenceRoot, manifest) {
    return {
      root: path.resolve(evidenceRoot),
      commitPath: path.join(path.resolve(evidenceRoot), 'commit.json'),
      manifestPath: path.join(path.resolve(evidenceRoot), 'patch-manifest.json'),
      manifestHash: manifest.manifestHash,
      chunkCount: manifest.chunkCount,
      totalBytes: manifest.totalBytes,
      chunkBytes: manifest.chunks.map(chunk => chunk.bytes),
    };
  }
}

module.exports = {
  PATCH_MANIFEST_SCHEMA,
  COMMIT_EVIDENCE_SCHEMA,
  DEFAULT_CHUNK_BYTES,
  ExactPatchEvidenceBundle,
  hashBuffer,
  lineSafeChunks,
  readManifestStrict,
};
