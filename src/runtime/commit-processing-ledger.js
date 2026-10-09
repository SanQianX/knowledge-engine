const fs = require('fs');
const { DomainError, validateProjectId } = require('./contracts');
const { validateSha } = require('./scanner');
const AtomicFile = require('./atomic-file');

class CommitProcessingLedger {
  constructor(options = {}) { this.layout = options.layout; this.atomic = options.atomic || AtomicFile; }
  filePath(projectId, commitSha) { return this.layout.getRuntimePath('processed-commits', validateProjectId(projectId), `${validateSha(commitSha)}.json`); }
  read(projectId, commitSha) {
    const file = this.filePath(projectId, commitSha);
    if (!fs.existsSync(file)) return null;
    return this.atomic.readJsonStrict(file, { category: 'commit-processing-record', validate: value => {
      if (!value || value.schema !== 'commit-processing-record/v1' || value.projectId !== projectId || value.commitSha !== commitSha || value.status !== 'completed') {
        throw new DomainError('DATA_CORRUPT', 'Commit processing ledger record is corrupt.', { status: 500 });
      }
      return value;
    } });
  }
  complete(projectId, commitSha, fields = {}) {
    const record = { schema: 'commit-processing-record/v1', projectId: validateProjectId(projectId), commitSha: validateSha(commitSha), status: 'completed', ...fields, completedAt: new Date().toISOString() };
    this.atomic.writeJsonAtomic(this.filePath(projectId, commitSha), record);
    return record;
  }
}

module.exports = { CommitProcessingLedger };
