'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const { latestSuite, allPassed } = require('./acceptance-progress');

function evaluateEvidence({ source, installed, user, manual, globalBytes, identity, version }) {
  const remaining = [...source, ...installed, ...user].filter(item => item.passed !== true).map(item => item.label);
  if (manual.selectionAndImport !== 'passed') remaining.push('native-folder-selection');
  if (manual.nativeCancellation !== 'passed') remaining.push('native-folder-cancellation');
  if (globalBytes.passed !== true || globalBytes.version !== version) remaining.push('global-official-package-bytes');
  if (identity.version !== version) remaining.push('actual-user-runtime-version');
  return { passed: remaining.length === 0 && allPassed(source) && allPassed(installed) && allPassed(user), remaining };
}

async function main() {
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  assert.equal(installation.integrityPassed, true);
  assert.match(installation.version, /^5\.0\.\d+$/);
  const source = ['shell', 'engine', 'workbench', 'vector', 'bridge'].flatMap(name => [24, 22].map(node => latestSuite(directory, `${name}-formal-full${node}`)));
  const installed = ['registry24', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'startup-gate24', 'startup-gate22', 'real-commits24', 'workbench24', 'live-development24', 'secondary24', 'memory24', 'four-clients24', 'external-capture24', 'embedding24', 'surfaces24', 'surfaces22'].map(label => latestSuite(directory, 'npm-formal-' + label));
  const user = ['frozen-upgrade24', 'index-root24', 'real-workbench24', 'repair-hook24', 'restart24', 'latest-install24'].map(label => latestSuite(directory, 'user-formal-' + label));
  const manual = JSON.parse(fs.readFileSync(path.join(directory, 'native-picker-user-receipt.json')));
  const globalBytesFile = path.join(directory, 'global-formal-registry-bytes.json');
  const globalBytes = fs.existsSync(globalBytesFile) ? JSON.parse(fs.readFileSync(globalBytesFile)) : { passed: false };
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok); return response.json(); };
  const [identity, brain, projects, runs] = await Promise.all(['/api/runtime/identity', '/api/brain', '/api/projects/aggregated', '/api/engine/runs'].map(read));
  const assessment = evaluateEvidence({ source, installed, user, manual, globalBytes, identity, version: installation.version });
  const report = { schema: 'system-regression/formal-acceptance/v1', checkedAt: new Date().toISOString(), systemComplete: assessment.passed, status: assessment.passed ? 'accepted' : 'gates-pending', package: { version: installation.version, sourceCommit: installation.sourceCommit, integrity: installation.distIntegrity, installationFile, modules: installation.modules, engineVersion: installation.engineVersion }, source, installed, user, manual, globalBytesFile, remaining: assessment.remaining,
    actualUser: { identity, projectCount: projects.projects.length, states: runs.runs.reduce((out, run) => { out[run.state] = (out[run.state] || 0) + 1; return out; }, {}), indexPath: brain.configuration.indexStorage.actualPath, indexStatus: brain.configuration.indexStorage.status },
    limits: ['Native selection/cancellation receipt is user manual confirmation, not an automated Windows UI result.', 'Four real clients use the configured MiniMax profile; no claim of four separate vendor-account authentications.', 'Historical e9f6560 raw index failure was discarded by the old version and cannot be recovered; controlled diagnostic coverage and real index-only recovery are separate evidence.', 'Acceptance proves the recorded environment and cases, not the absence of all future defects.'],
    previousEvidence: path.join(directory, 'progress-rc19-1791741071594.json') };
  const output = path.join(directory, `formal-${installation.version}-${Date.now()}.json`); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, systemComplete: report.systemComplete, remaining: report.remaining }));
  if (!report.systemComplete) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { evaluateEvidence };
