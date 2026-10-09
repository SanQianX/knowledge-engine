'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DomainError, validateProjectId } = require('./contracts');

function realpathWithMissingLeaf(value) {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(realpathWithMissingLeaf(parent), path.basename(absolute));
}

class RuntimeLayout {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); }
  pathsEqual(a, b) {
    const normalize = v => process.platform === 'win32' ? realpathWithMissingLeaf(v).toLowerCase() : realpathWithMissingLeaf(v);
    return normalize(a) === normalize(b);
  }
  isPathInside(root, target, { realpath = false } = {}) {
    const canonical = v => realpath ? realpathWithMissingLeaf(v) : path.resolve(v);
    const relative = path.relative(canonical(root), canonical(target));
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }
  under(root, parts) {
    const target = path.resolve(root, ...parts.map(String));
    if (!this.isPathInside(root, target, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', 'Runtime path escapes its root.', { status: 403 });
    return target;
  }
  getRuntimePath(...parts) { return this.under(path.join(this.dataDir, 'runtime'), parts); }
  getRecoveryPath(...parts) { return this.under(path.join(this.dataDir, 'recovery'), parts); }
  getIndexPath() { return this.getRuntimePath('index-sources'); }
  getProjectMetadataDir(id) { return this.getRuntimePath('projects', validateProjectId(id)); }
  getProjectConversationEventsPath(id) { return path.join(this.getProjectMetadataDir(id), 'conversation-events.jsonl'); }
  getProjectCommitBoundariesDir(id) { return path.join(this.getProjectMetadataDir(id), 'commit-boundaries'); }
  getProjectCommitConversationsDir(id) { return path.join(this.getProjectMetadataDir(id), 'commit-conversations'); }
  validateCommitSha(sha) {
    if (!/^[a-f0-9]{7,64}$/i.test(String(sha || ''))) throw new DomainError('INVALID_ARGUMENT', 'An explicit commit SHA is required.');
    return String(sha).toLowerCase();
  }
  getProjectCommitBoundaryPath(id, sha) { return path.join(this.getProjectCommitBoundariesDir(id), `${this.validateCommitSha(sha)}.json`); }
  getProjectCommitConversationPath(id, sha) { return path.join(this.getProjectCommitConversationsDir(id), `${this.validateCommitSha(sha)}.json`); }
}

module.exports = { RuntimeLayout, realpathWithMissingLeaf };
