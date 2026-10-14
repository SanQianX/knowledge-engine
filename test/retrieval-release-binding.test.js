'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { buildReport } = require('./support/retrieval-release-report');

const INTEGRITY = 'sha512-' + 'a'.repeat(86) + '==';
const ROOT_COMMIT = 'b'.repeat(40);
const ENGINE_COMMIT = 'e'.repeat(40);
const VECTOR_COMMIT = 'c'.repeat(40);
const installation = over => ({
  schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next',
  version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT, engineVersion: '0.2.7-rc.6',
  modules: {
    terminal: { version: '0.13.2-rc.11', packageName: '@sanqianx/claude-ai-workbench', distIntegrity: INTEGRITY, sourceCommit: 'd'.repeat(40) },
    vectorHub: { version: '1.0.8-rc.5', packageName: '@sanqianx/vector-hub', distIntegrity: INTEGRITY, sourceCommit: VECTOR_COMMIT },
    eventBridge: { version: '0.7.3', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: INTEGRITY, sourceCommit: 'f'.repeat(40) },
  },
  vendorManifest: { schema: 'project-knowledge/vendor-runtime/v1', modules: { 'knowledge-engine': { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', sourceCommit: ENGINE_COMMIT } } },
  ...over,
});
const stamp = (directory, label, at, fields = {}) => {
  fs.writeFileSync(path.join(directory, label + '-' + at + '.json'),
    JSON.stringify({ label, passed: true, exitCode: 0, durationMs: 7, ...fields }));
};
const find = (report, label) => [...report.source, ...report.installed].find(gate => gate.label === label);

test('a bound formal report never inherits 5.0.15 formal labels and requires this batch identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-bind-'));
  stamp(directory, 'retrieval-formal-web24', 10);
  stamp(directory, 'retrieval-rc6-engine24', 20, { sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', commit: ENGINE_COMMIT, runtimeDirty: [] } });
  const report = buildReport({ installation: installation(), prefix: 'retrieval-formal', bindReceipt: true, sourcePrefixArg: 'retrieval-rc6', directory });
  assert.equal(report.bound, true);
  assert.equal(find(report, 'retrieval-formal-web24').passed, false);
  assert.equal(find(report, 'retrieval-formal-web24').status, 'not-run');
  assert.equal(find(report, 'retrieval-rc6-engine24').passed, true);
  assert.equal(report.binding.mode, 'official-download-receipt');
  assert.equal(report.binding.version, '5.0.16-rc.1');
  assert.equal(report.binding.distIntegrity, INTEGRITY);
  assert.equal(report.binding.sourceCommit, ROOT_COMMIT);
  assert.equal(report.binding.moduleVersions.terminal, '0.13.2-rc.11');
  assert.equal(report.systemComplete, false);
});

test('a bound report counts only suites bound to this batch engine, product, modules or install receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-bind-'));
  const receipt = { registry: 'https://registry.npmjs.org/', integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
  stamp(directory, 'retrieval-rc6-engine24', 100, { sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.5', commit: ENGINE_COMMIT, runtimeDirty: [] } });
  stamp(directory, 'retrieval-rc6-engine24', 50, { sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', commit: ENGINE_COMMIT, runtimeDirty: [] } });
  stamp(directory, 'retrieval-rc6-shell24', 60, { sourceIdentity: { name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1', commit: ROOT_COMMIT, runtimeDirty: [] } });
  stamp(directory, 'retrieval-source-vector24', 70, { sourceIdentity: { name: '@sanqianx/vector-hub', version: '1.0.8-rc.5', commit: VECTOR_COMMIT, runtimeDirty: [] } });
  stamp(directory, 'retrieval-rc6-web24', 80, { installIdentity: receipt });
  stamp(directory, 'retrieval-rc6-fault24', 90, { installIdentity: { ...receipt, sourceCommit: 'oldhead' } });
  stamp(directory, 'retrieval-rc6-lifecycle22', 91, { installIdentity: { ...receipt, distIntegrity: 'sha512-' + 'b'.repeat(86) + '==' } });
  stamp(directory, 'retrieval-source-workbench24', 92, { sourceIdentity: { name: '@sanqianx/claude-ai-workbench', version: '0.13.2-rc.10', commit: 'd'.repeat(40), runtimeDirty: [] } });
  stamp(directory, 'retrieval-rc6-registry24', 93);
  const report = buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, directory });
  assert.equal(find(report, 'retrieval-rc6-engine24').passed, true);
  assert.equal(find(report, 'retrieval-rc6-engine24').matched, 'source-commit');
  assert.equal(find(report, 'retrieval-rc6-shell24').passed, true);
  assert.equal(find(report, 'retrieval-source-vector24').passed, true);
  assert.equal(find(report, 'retrieval-rc6-web24').matched, 'install-receipt');
  for (const label of ['retrieval-rc6-fault24', 'retrieval-rc6-lifecycle22', 'retrieval-source-workbench24', 'retrieval-rc6-registry24']) {
    assert.equal(find(report, label).passed, false, label + ' must not count for this batch');
    assert.equal(find(report, label).status, 'not-run');
  }
});

test('bound and source-prefix arguments are strict about labels and receipt identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-bind-'));
  assert.throws(() => buildReport({ installation: installation(), prefix: 'retrieval-formal', bindReceipt: true, directory }), /source-prefix/);
  assert.throws(() => buildReport({ installation: installation({ version: '5.0.15', engineVersion: '0.2.7-rc.5' }), prefix: 'retrieval-rc5', sourcePrefixArg: 'retrieval-rc5', directory }), /--bind-receipt/);
  assert.throws(() => buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, sourcePrefixArg: 'retrieval-formal', directory }), /retrieval-rc/);
  assert.throws(() => buildReport({ installation: installation({ sourceCommit: undefined }), prefix: 'retrieval-rc6', bindReceipt: true, directory }), /identity/);
  assert.throws(() => buildReport({ installation: installation(), prefix: 'retrieval-latest', directory }), /retrieval-/);
});

test('legacy unbound calls keep the rc5 formal fallback and count identity-free receipts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-legacy-'));
  stamp(directory, 'retrieval-rc5-engine24', 5);
  stamp(directory, 'retrieval-formal-web24', 6);
  const report = buildReport({ installation: installation({ version: '5.0.15', engineVersion: '0.2.7-rc.5' }), prefix: 'retrieval-formal', directory });
  assert.equal(report.bound, false);
  assert.equal(report.binding, undefined);
  assert.equal(find(report, 'retrieval-rc5-engine24').passed, true);
  assert.equal(find(report, 'retrieval-formal-web24').passed, true);
});

test('failed bound receipts stay visible even after a later passing run of the same label', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-fifo-'));
  const receipt = { registry: 'https://registry.npmjs.org/', integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
  stamp(directory, 'retrieval-rc6-web24', 30, { passed: false, exitCode: 1, installIdentity: receipt });
  stamp(directory, 'retrieval-rc6-web24', 40, { installIdentity: receipt });
  stamp(directory, 'retrieval-rc6-fault22', 50, { passed: false, exitCode: 1, installIdentity: receipt });
  const report = buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, directory });
  assert.equal(find(report, 'retrieval-rc6-web24').passed, true);
  assert.equal(find(report, 'retrieval-rc6-fault22').status, 'failed');
  assert.ok(report.failures.some(failure => failure.label === 'retrieval-rc6-web24'));
  assert.ok(report.failures.some(failure => failure.label === 'retrieval-rc6-fault22'));
  assert.ok(report.remaining.includes('Formal package download and exact-byte acceptance, existing-v5 preservation/upgrade, daily latest reinstall and final real loop.'));
  assert.equal(report.status, 'in-progress');
});

test('system-suite records non-secret source and install receipt identity for every run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-identity-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6' }));
  const receipt = path.join(directory, 'registry-installation.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next', version: '5.0.16-rc.1', engineVersion: '0.2.7-rc.6', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT }));
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, 'support/system-suite.js'), 'd2-identity-selfcheck24', directory, 'node', '-e', '0'],
    { env: { ...process.env, KB_TEST_NODE: '', KB_SUITE_INSTALL_RECEIPT: receipt } },
    (error, out, err) => error ? reject(new Error(err || out || String(error))) : resolve(out)));
  const summary = JSON.parse(stdout.trim().split('\n').pop());
  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'));
  assert.equal(report.passed, true);
  assert.match(report.nodeVersion, /^v\d+\.\d+\.\d+$/);
  assert.equal(report.harnessNodeVersion, process.version);
  const packageHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'package.json'))).digest('hex');
  assert.deepEqual(report.sourceIdentity, { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', nodeVersion: report.nodeVersion, commit: null, runtimeDirty: null, runtimeFiles: { 'package.json': packageHash } });
  assert.equal(report.installIdentity.version, '5.0.16-rc.1');
  assert.equal(report.installIdentity.distIntegrity, INTEGRITY);
  assert.equal(report.installIdentity.sourceCommit, ROOT_COMMIT);
  assert.equal(report.installIdentity.receipt, receipt);
});

test('system-suite refuses a receipt that is not an official registry installation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-identity-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1' }));
  const receipt = path.join(directory, 'fake.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'handwritten/receipt/v9', version: '5.0.16-rc.1' }));
  const failure = await new Promise(resolve => execFile(process.execPath,
    [path.join(__dirname, 'support/system-suite.js'), 'd2-identity-selfcheck24', directory, 'node', '-e', '0'],
    { env: { ...process.env, KB_TEST_NODE: '', KB_SUITE_INSTALL_RECEIPT: receipt } },
    (error, out, err) => resolve({ error, out, err })));
  assert.ok(failure.error, 'a non-official receipt must abort the suite run');
});

// F1 red cases: the same official install receipt must not let an
// isolated-control real24 run satisfy local native acceptance for clients
// that have a --user-config mode. Mode comes from the recorded command.
const USER_CONFIG_CLIENTS = {
  'retrieval-rc6-claude-real24': ['test/support/real-automatic-context.js', '.agent-state/tmp/env/acceptance-environment.json'],
  'retrieval-rc6-zcode-real24': ['test/support/real-zcode-automatic-context.js', '.agent-state/tmp/env/acceptance-environment.json'],
};
const stampNativeRun = (directory, label, at, receipt, scriptArgs, userConfig) => {
  stamp(directory, label, at, { installIdentity: receipt, command: ['C:/Program Files/nodejs/node.exe', ...scriptArgs, ...(userConfig ? ['--user-config'] : []), '--commit'] });
};

test('F1 red: bound claude/zcode real24 without --user-config is isolated control and must not satisfy native acceptance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-userconfig-red-'));
  const receipt = { registry: 'https://registry.npmjs.org/', integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
  for (const [label, scriptArgs] of Object.entries(USER_CONFIG_CLIENTS)) stampNativeRun(directory, label, 10, receipt, scriptArgs, false);
  const report = buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, directory });
  for (const label of Object.keys(USER_CONFIG_CLIENTS)) {
    const gate = find(report, label);
    assert.equal(gate.passed, false, label + ' without --user-config never counts as existing-user integration');
    assert.notEqual(gate.status, 'passed');
  }
});

test('F1 spec: the same official receipt counts for claude/zcode real24 once the command carries --user-config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-userconfig-green-'));
  const receipt = { registry: 'https://registry.npmjs.org/', integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
  for (const [label, scriptArgs] of Object.entries(USER_CONFIG_CLIENTS)) stampNativeRun(directory, label, 20, receipt, scriptArgs, true);
  const report = buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, directory });
  for (const label of Object.keys(USER_CONFIG_CLIENTS)) assert.equal(find(report, label).passed, true, label + ' with --user-config is valid user-integration evidence');
});

test('F1 boundary: codex and opencode real24 never require a --user-config parameter', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-release-userconfig-boundary-'));
  const receipt = { registry: 'https://registry.npmjs.org/', integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
  stampNativeRun(directory, 'retrieval-rc6-codex-real24', 30, receipt, ['test/support/real-codex-automatic-context.js', '.agent-state/tmp/env/acceptance-environment.json'], false);
  stamp(directory, 'retrieval-rc6-opencode-real24', 40, { installIdentity: receipt, command: ['C:/Program Files/nodejs/node.exe', 'test/support/real-client-knowledge.js', '.agent-state/tmp/env/acceptance-environment.json', '--agent', 'opencode', '--auth', 'profile-injected'] });
  const report = buildReport({ installation: installation(), prefix: 'retrieval-rc6', bindReceipt: true, directory });
  assert.equal(find(report, 'retrieval-rc6-codex-real24').passed, true, 'codex acceptance runs through reviewed user hooks and has no --user-config flag');
  assert.equal(find(report, 'retrieval-rc6-opencode-real24').passed, true, 'opencode is covered on the knowledge-tool surface only; its boundary stays unchanged');
});
