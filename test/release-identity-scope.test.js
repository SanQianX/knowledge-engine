'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { matchesInstallation } = require('./support/retrieval-release-report');
const { formalGatePlan } = require('./support/upgrade-user-context-product');

const INTEGRITY = 'sha512-' + 'M'.repeat(86) + '==';
const ROOT_COMMIT = 'b'.repeat(40);
const OFFICIAL = 'https://registry.npmjs.org/';
const installation = over => ({
  schema: 'project-knowledge/installed-registry/v1', registry: OFFICIAL, integrityPassed: true, tag: 'next',
  version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT, engineVersion: '0.2.7-rc.6',
  modules: {
    terminal: { version: '0.13.2-rc.11', packageName: '@sanqianx/claude-ai-workbench', distIntegrity: INTEGRITY, sourceCommit: 'c'.repeat(40) },
    vectorHub: { version: '1.0.8-rc.5', packageName: '@sanqianx/vector-hub', distIntegrity: INTEGRITY, sourceCommit: 'd'.repeat(40) },
    eventBridge: { version: '0.7.3', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: INTEGRITY, sourceCommit: '9'.repeat(40) },
  },
  ...over,
});
const provenance = { registry: OFFICIAL, integrityPassed: true, version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };

test('an unverified suite receipt never lends an install-receipt pass', () => {
  const forged = { ...provenance, integrityPassed: false, registry: 'https://invalid.example' };
  assert.equal(matchesInstallation({ installIdentity: forged }, installation()), false);
});

test('install evidence needs official provenance on both sides, never default trust', () => {
  assert.equal(matchesInstallation({ installIdentity: { version: provenance.version, distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT } }, installation()), false);
  assert.equal(matchesInstallation({ installIdentity: provenance }, installation({ integrityPassed: false })), false);
  assert.equal(matchesInstallation({ installIdentity: provenance }, installation({ registry: 'https://invalid.example' })), false);
  assert.equal(matchesInstallation({ installIdentity: provenance }, installation()), 'install-receipt');
});

test('a formal next-tagged release receipt is accepted for the full 24-gate plan before latest promotion', () => {
  const plan = formalGatePlan(installation({ tag: 'next', version: '5.0.16' }), { version: '5.0.16' }, 'retrieval-rc6');
  assert.equal(plan.bound, true);
  assert.equal(plan.tag, 'next');
  assert.deepEqual(plan.gates, [
    'retrieval-rc6-engine22', 'retrieval-rc6-engine24', 'retrieval-rc6-shell22', 'retrieval-rc6-shell24',
    'retrieval-formal-registry24', 'retrieval-formal-web24', 'retrieval-formal-web22', 'retrieval-formal-fault24', 'retrieval-formal-fault22',
    'retrieval-formal-lifecycle24', 'retrieval-formal-lifecycle22', 'retrieval-formal-claude-real24', 'retrieval-formal-codex-real24',
    'retrieval-formal-zcode-real24', 'retrieval-formal-opencode-real24', 'retrieval-formal-real-commits24', 'retrieval-formal-workbench24',
    'retrieval-formal-embedding24', 'retrieval-formal-quality24', 'retrieval-formal-performance24', 'retrieval-formal-surfaces24',
    'retrieval-formal-user-query24', 'retrieval-formal-local-marketplace24', 'retrieval-formal-topic-context24']);
  assert.equal(plan.gates.length, 24);
  const latest = formalGatePlan(installation({ tag: 'latest', version: '5.0.16' }), { version: '5.0.16' }, 'retrieval-rc6');
  assert.equal(latest.bound, true);
  assert.equal(latest.tag, 'latest');
  assert.throws(() => formalGatePlan(installation({ tag: 'legacy', version: '5.0.16' }), { version: '5.0.16' }, 'retrieval-rc6'), /dist-tag/);
  assert.throws(() => formalGatePlan(installation({ tag: 'next', version: '5.0.16-rc.2' }), { version: '5.0.16-rc.2' }, 'retrieval-rc6'), /never an rc candidate/);
  assert.throws(() => formalGatePlan(installation({ tag: 'next', version: '5.0.16-rc.2' }), { version: '5.0.16' }, 'retrieval-rc6'), /never an rc candidate/);
  assert.throws(() => formalGatePlan(installation({ tag: 'next', version: '5.0.16', integrityPassed: false }), { version: '5.0.16' }, 'retrieval-rc6'), /integrity/);
});

const gitIn = (directory, ...args) => execFileSync('git', ['-c', 'user.email=d3@localhost', '-c', 'user.name=d3', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
const runSuite = async (label, directory, extraEnv = {}) => {
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, 'support/system-suite.js'), label, directory, 'node', '-e', '0'],
    { env: { ...process.env, KB_TEST_NODE: '', ...extraEnv } },
    (error, out, err) => error ? reject(new Error(err || out || String(error))) : resolve(out)));
  const summary = JSON.parse(stdout.trim().split('\n').pop());
  return JSON.parse(fs.readFileSync(summary.report, 'utf8'));
};

test('the engine runtime graph reads exactly the published runtime files with raw-byte hashes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d3-engine-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', files: ['src', 'ui/index.html', 'ui/app.js', 'ui/app.css', 'README.md'] }));
  fs.writeFileSync(path.join(directory, 'README.md'), 'engine readme\n');
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'repo notes\n');
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src/server.js'), 'const a = 1;\r\nconst b = 2;\r\n');
  fs.mkdirSync(path.join(directory, 'ui'));
  for (const name of ['index.html', 'app.js', 'app.css']) fs.writeFileSync(path.join(directory, 'ui', name), 'runtime ' + name);
  fs.writeFileSync(path.join(directory, 'ui/control-plane-prototype.html'), 'user prototype');
  fs.writeFileSync(path.join(directory, 'ui/mockup-phase2.html'), 'user mockup');
  gitIn(directory, 'init', '-q');
  gitIn(directory, 'add', 'package.json', 'README.md', 'AGENTS.md', 'src', 'ui/index.html', 'ui/app.js', 'ui/app.css');
  gitIn(directory, 'commit', '-qm', 'runtime');
  fs.appendFileSync(path.join(directory, 'src/server.js'), 'const c = 3;\r\n');
  fs.appendFileSync(path.join(directory, 'AGENTS.md'), 'user edit\n');
  const report = await runSuite('d3-scope-engine24', directory);
  assert.deepEqual(Object.keys(report.sourceIdentity.runtimeFiles).sort(),
    ['README.md', 'package.json', 'src/server.js', 'ui/app.css', 'ui/app.js', 'ui/index.html']);
  assert.deepEqual(report.sourceIdentity.runtimeDirty, ['src/server.js']);
  const raw = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'src/server.js'))).digest('hex');
  assert.equal(report.sourceIdentity.runtimeFiles['src/server.js'], raw);
  assert.notEqual(raw, crypto.createHash('sha256').update('const a = 1;\nconst b = 2;\nconst c = 3;\n').digest('hex'));
});

test('non-engine runtime dirt is scoped to the published package files, preserving unrelated user work', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d3-product-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1', files: ['_site/server.js', 'bin/'] }));
  fs.mkdirSync(path.join(directory, '_site'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'desktop/scripts'), { recursive: true });
  fs.writeFileSync(path.join(directory, '_site/server.js'), 'server\n');
  fs.writeFileSync(path.join(directory, 'bin/run.js'), 'run\n');
  fs.writeFileSync(path.join(directory, 'desktop/scripts/audit.cjs'), 'audit\n');
  gitIn(directory, 'init', '-q');
  gitIn(directory, 'add', '.');
  gitIn(directory, 'commit', '-qm', 'product');
  fs.appendFileSync(path.join(directory, '_site/server.js'), 'edit\n');
  fs.appendFileSync(path.join(directory, 'desktop/scripts/audit.cjs'), 'user edit\n');
  const report = await runSuite('d3-scope-product24', directory);
  assert.deepEqual(report.sourceIdentity.runtimeDirty, ['_site/server.js']);
});

test('system-suite preserves the official provenance fields inside installIdentity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d3-receipt-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1' }));
  const receiptFile = path.join(directory, 'registry-installation.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ schema: 'project-knowledge/installed-registry/v1', registry: OFFICIAL, integrityPassed: true, tag: 'next', version: '5.0.16-rc.1', engineVersion: '0.2.7-rc.6', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT }));
  const report = await runSuite('d3-provenance24', directory, { KB_SUITE_INSTALL_RECEIPT: receiptFile });
  assert.equal(report.installIdentity.registry, OFFICIAL);
  assert.equal(report.installIdentity.integrityPassed, true);
  assert.equal(report.installIdentity.version, '5.0.16-rc.1');
  assert.equal(report.installIdentity.sourceCommit, ROOT_COMMIT);
});
