'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('./runtime/atomic-file');
const { validateClaim } = require('./runtime/commit-reconciler');
const { validateSha } = require('./runtime/scanner');
const { initialRuntime } = require('./store');

// Only frozen analysis artifacts cross this boundary, never shell settings,
// registries or credentials. Canonical knowledge files stay where they are.
async function importLegacyState(coordinator, input) {
  const { store, layout } = coordinator;
  if (!/^cutover-[a-f0-9-]{36}$/.test(input.migrationId || '') || !path.isAbsolute(input.sourceDataDir || '') || !Array.isArray(input.projects)) throw failure('INVALID_ARGUMENT');
  if (store.state.migrations?.includes(input.migrationId)) return { reused: true };
  if (coordinator.executionEnabled || coordinator.active.size) throw failure('ENGINE_NOT_PAUSED');
  const backup = path.join(input.sourceDataDir, 'recovery', 'engine-cutover', input.migrationId);
  if (!fs.existsSync(path.join(backup, 'snapshot.json'))) throw failure('MIGRATION_BACKUP_MISSING');
  const snapshot = AtomicFile.readJsonStrict(path.join(backup, 'snapshot.json'));
  if (snapshot.migrationId !== input.migrationId || snapshot.sourceDataDir !== input.sourceDataDir) throw failure('MIGRATION_BACKUP_MISMATCH');
  input = snapshot;
  const mappings = ['runs', 'claims', 'promotions', 'processed-commits'].map(kind => [path.join(input.sourceDataDir, 'runtime', kind), layout.getRuntimePath(kind)]);
  mappings.push([path.join(input.sourceDataDir, 'recovery', 'promotions'), layout.getRecoveryPath('promotions')]);
  for (const projected of input.projects) mappings.push([path.join(input.sourceDataDir, 'projects', projected.registration.projectId), layout.getProjectMetadataDir(projected.registration.projectId)]);
  function remap(value) {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    if (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\n')) {
      const mapping = mappings.find(([from]) => layout.isPathInside(from, value));
      if (mapping) return path.join(mapping[1], path.relative(mapping[0], value));
    }
    return value;
  }
  function copy(source, target) {
    if (!fs.existsSync(source)) return;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !layout.isPathInside(backup, source, { realpath: true }) || !layout.isPathInside(store.dataDir, target, { realpath: true })) throw failure('MIGRATION_UNSAFE_PATH');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(source)) copy(path.join(source, entry), path.join(target, entry));
      return;
    }
    if (!stat.isFile()) throw failure('MIGRATION_UNSAFE_PATH');
    let bytes = fs.readFileSync(source);
    if (source.endsWith('.json')) bytes = Buffer.from(JSON.stringify(remap(JSON.parse(bytes.toString('utf8'))), null, 2));
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(bytes)) throw failure('MIGRATION_ARTIFACT_CONFLICT');
    } else AtomicFile.writeFileAtomic(target, bytes);
  }
  for (const kind of ['runs', 'claims', 'promotions', 'processed-commits']) copy(path.join(backup, 'runtime', kind), layout.getRuntimePath(kind));
  copy(path.join(backup, 'recovery', 'promotions'), layout.getRecoveryPath('promotions'));
  for (const { registration, runtime } of input.projects) {
    const project = store.addProject(registration).project;
    if (project.migrationId === input.migrationId) continue;
    if (store.state.runs.some(run => run.projectId === project.projectId)) throw failure('MIGRATION_PROJECT_ALREADY_ACTIVE');
    const next = initialRuntime(registration);
    if (runtime.lastAnalyzedCommit) next.lastAnalyzedCommit = validateSha(runtime.lastAnalyzedCommit);
    next.conversationBaselineCursor = runtime.conversationBaselineCursor ?? next.conversationBaselineCursor;
    if (runtime.conversationBaselineCursors) {
      if (Object.entries(runtime.conversationBaselineCursors).some(([journal, cursor]) => !/^(global|sha256:[a-f0-9]{64})$/.test(journal) || !Number.isSafeInteger(cursor) || cursor < 0)) throw failure('MIGRATION_INVALID_BASELINE');
      next.conversationBaselineCursors = { ...runtime.conversationBaselineCursors };
    }
    next.analysis.consumedRequirementIds = (runtime.analysis?.consumedRequirementIds || []).filter(id => typeof id === 'string');
    next.index.dirty = runtime.index?.dirty === true;
    const claim = runtime.analysis?.activeClaim;
    if (claim) {
      validateClaim(claim, project.projectId, validateSha(claim.commitSha));
      const claimKeys = ['schema', 'projectId', 'commitSha', 'parents', 'triggerFirstSeen', 'requirementIds', 'requirementBinding', 'conversationSnapshotHash', 'conversationTurnIds', 'conversationEventIds', 'promptTemplateVersion', 'promptHash', 'patchHash', 'evidenceHash', 'evidenceManifestHash', 'retrievalManifestHash', 'knowledgePath', 'runId', 'operationId', 'phase', 'attempt', 'fingerprint'];
      next.analysis.activeClaim = remap(Object.fromEntries(claimKeys.filter(key => claim[key] !== undefined).map(key => [key, claim[key]])));
      next.analysis.status = claim.phase;
    }
    for (const name of ['conversation-events.jsonl', 'commit-boundaries', 'commit-conversations']) copy(path.join(backup, 'projects', project.projectId, name), path.join(layout.getProjectMetadataDir(project.projectId), name));
    project.runtime = next;
    project.migrationId = input.migrationId;
    store.save();
    if (claim) {
      const run = store.addRun({ projectId: project.projectId, commitSha: claim.commitSha, trigger: 'upgrade-recovery' });
      store.updateRun(run.runId, { analysisRunId: claim.runId, phase: 'recovering' });
    } else if (next.index.dirty && next.lastAnalyzedCommit) {
      const run = store.addRun({ projectId: project.projectId, commitSha: next.lastAnalyzedCommit, trigger: 'upgrade-index-recovery' });
      store.updateRun(run.runId, { promotedAt: new Date().toISOString(), phase: 'index-pending', state: 'index-pending', indexState: 'failed' });
    }
  }
  store.state.migrations = [...(store.state.migrations || []), input.migrationId];
  store.save();
  return { migrated: input.projects.length, fingerprint: crypto.createHash('sha256').update(JSON.stringify(input.projects.map(p => [p.registration.projectId, p.runtime.lastAnalyzedCommit]))).digest('hex') };
}
function failure(code) { return Object.assign(new Error('运行迁移未完成，原数据与升级备份已保留。'), { code, status: 409 }); }
module.exports = { importLegacyState };
