'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink() || entry.name === '.git') return [];
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}
function snapshot(dataDir, core) {
  const { StorageLayout } = require(path.join(core, '_site/lib/storage-layout'));
  const { ProjectStore } = require(path.join(core, '_site/lib/project-store'));
  const { ProjectRegistryStore } = require(path.join(core, '_site/lib/project-registry-store'));
  const layout = new StorageLayout({ dataDir });
  const registry = new ProjectRegistryStore({ layout }); const projects = new ProjectStore({ layout });
  const protectedFiles = ['credentials.v1.json', 'profiles.v2.json'].map(name => path.join(dataDir, 'workbench', name));
  for (const relative of ['.codex/config.toml', '.claude/settings.json', '.zcode/cli/config.json']) protectedFiles.push(path.join(os.homedir(), relative));
  const stateFile = path.join(dataDir, 'knowledge-engine/engine-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  return {
    dataDir, core, version: require(path.join(core, 'package.json')).version, recordedAt: new Date().toISOString(),
    projects: registry.listIds().map(projectId => {
      const config = projects.readConfig(projectId); const projectState = projects.readState(projectId);
      return { projectId, repoPath: config.repoPath, knowledgePath: config.knowledgePath, brainId: config.brainId, domainId: config.domainId, trackingStartCommit: projectState.trackingStartCommit, knowledgeFiles: files(config.knowledgePath).filter(file => file.endsWith('.md')).map(file => ({ file, sha256: hash(file) })) };
    }),
    protectedFiles: protectedFiles.map(file => ({ file, sha256: hash(file) })),
    historyFiles: ['workbench/_ai', 'workbench/cli-sessions'].flatMap(relative => files(path.join(dataDir, relative))).map(file => ({ file, sha256: hash(file) })),
    journalCursors: state.journalCursors,
    runs: state.runs.map(run => ({ runId: run.runId, projectId: run.projectId, commitSha: run.commitSha, state: run.state, indexState: run.indexState, promotedAt: run.promotedAt, analysisRunId: run.analysisRunId, indexAttempts: run.indexAttempts, knowledgeHashes: Object.fromEntries((run.staging?.operations || []).filter(op => op.operation !== 'delete').map(op => [op.path, hash(path.join(state.projects.find(project => project.projectId === run.projectId).knowledgePath, op.path))])) })),
  };
}
function verify(before, after) {
  assert.equal(before.dataDir, after.dataDir);
  for (const project of before.projects) {
    const current = after.projects.find(item => item.projectId === project.projectId);
    assert.ok(current, 'existing project must not disappear');
    for (const key of ['repoPath', 'knowledgePath', 'brainId', 'domainId', 'trackingStartCommit']) assert.equal(current[key], project[key], `${project.projectId} ${key}`);
    for (const item of project.knowledgeFiles) assert.ok(fs.existsSync(item.file), 'existing knowledge must not be deleted by upgrade');
  }
  for (const item of before.protectedFiles) assert.equal(hash(item.file), item.sha256, `protected configuration changed: ${item.file}`);
  for (const item of before.historyFiles) assert.ok(fs.existsSync(item.file), `history disappeared: ${item.file}`);
  for (const old of before.runs) assert.ok(after.runs.some(run => run.runId === old.runId && run.commitSha === old.commitSha), 'existing run history must remain');
}
if (require.main === module) {
  const [mode, directory, core, report] = process.argv.slice(2);
  assert.ok(['record', 'verify'].includes(mode));
  const dataDir = path.resolve(directory); assert.equal(path.basename(dataDir), '.project-knowledge-v5');
  const current = snapshot(dataDir, path.resolve(core));
  if (mode === 'record') AtomicFile.writeJsonAtomic(report, { schema: 'existing-v5-acceptance/v1', before: current });
  else {
    const result = JSON.parse(fs.readFileSync(report));
    verify(result.before, current); result.after = current; result.preservationPassed = true;
    AtomicFile.writeJsonAtomic(report, result);
  }
  console.log(JSON.stringify({ mode, version: current.version, projects: current.projects.length, historyFiles: current.historyFiles.length, report }));
}
module.exports = { snapshot, verify };
