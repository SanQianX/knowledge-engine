'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildReport, matchesInstallation } = require('./support/retrieval-release-report');
const { formalGatePlan } = require('./support/upgrade-user-context-product');

const INTEGRITY = 'sha512-' + 'M'.repeat(86) + '==';
const ROOT_COMMIT = 'b'.repeat(40);
const ENGINE_COMMIT = 'a'.repeat(40);
const OTHER_ENGINE_COMMIT = 'f'.repeat(40);
const WB_COMMIT = 'c'.repeat(40);
const VECTOR_COMMIT = 'd'.repeat(40);
const BRIDGE_COMMIT = '9'.repeat(40);
const runtime = { 'README.md': '1'.repeat(64), 'package.json': '2'.repeat(64), 'src/retrieval.js': '3'.repeat(64) };
const installation = over => ({
  schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next',
  version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT, engineVersion: '0.2.7-rc.6',
  modules: {
    terminal: { version: '0.13.2-rc.11', packageName: '@sanqianx/claude-ai-workbench', distIntegrity: INTEGRITY, sourceCommit: WB_COMMIT },
    vectorHub: { version: '1.0.8-rc.5', packageName: '@sanqianx/vector-hub', distIntegrity: INTEGRITY, sourceCommit: VECTOR_COMMIT },
    eventBridge: { version: '0.7.3', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: INTEGRITY, sourceCommit: BRIDGE_COMMIT },
  },
  vendorManifest: { schema: 'project-knowledge/vendor-runtime/v1', modules: { 'knowledge-engine': { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', root: '_modules/knowledge-engine', files: runtime, sourceCommit: ENGINE_COMMIT } } },
  ...over,
});
const stamp = (directory, label, at, fields = {}) => {
  fs.writeFileSync(path.join(directory, label + '-' + at + '.json'),
    JSON.stringify({ label, passed: true, exitCode: 0, durationMs: 5, ...fields }));
};
const find = (report, label) => [...report.source, ...report.installed].find(gate => gate.label === label);

test('5.0.16 binds identity by default: an unbound call cannot inherit old formal passes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d2-mandatory-'));
  stamp(directory, 'retrieval-formal-web24', 10);
  stamp(directory, 'retrieval-rc6-engine24', 20, { sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6' } });
  const report = buildReport({ installation: installation(), prefix: 'retrieval-formal', sourcePrefixArg: 'retrieval-rc6', directory });
  assert.equal(report.bound, true);
  assert.equal(find(report, 'retrieval-formal-web24').status, 'not-run');
  assert.equal(find(report, 'retrieval-rc6-engine24').status, 'not-run');
  assert.equal(report.localCorePassed, false);
});

test('a new release formal report refuses the legacy rc5 source fallback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d2-mandatory-'));
  stamp(directory, 'retrieval-rc5-engine24', 10);
  assert.throws(() => buildReport({ installation: installation(), prefix: 'retrieval-formal', directory }), /source-prefix/);
});

test('degenerate install identities never lend a pass', () => {
  const zeros = '0'.repeat(40);
  assert.equal(matchesInstallation({ installIdentity: { version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: zeros } }, installation({ sourceCommit: zeros })), false);
  assert.equal(matchesInstallation({ installIdentity: { version: '5.0.16-rc.1', distIntegrity: INTEGRITY, sourceCommit: 'deadbeef' } }, installation({ sourceCommit: 'deadbeef' })), false);
  assert.equal(matchesInstallation({ installIdentity: { version: '5.0.16-rc.1', distIntegrity: 'sha512-short', sourceCommit: ROOT_COMMIT } }, installation({ distIntegrity: 'sha512-short' })), false);
});

test('source suites need commit or runtime-content evidence, never name and version alone', () => {
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6' } }, installation()), false);
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', commit: ENGINE_COMMIT, runtimeDirty: [] } }, installation()), 'source-commit');
});

test('engine content identity accepts test/doc-only HEAD drift and rejects changed runtime files', () => {
  const drifted = { name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6', commit: OTHER_ENGINE_COMMIT, runtimeDirty: [], runtimeFiles: runtime };
  assert.equal(matchesInstallation({ sourceIdentity: drifted }, installation()), 'source-content');
  assert.equal(matchesInstallation({ sourceIdentity: { ...drifted, runtimeFiles: { ...runtime, 'src/retrieval.js': '4'.repeat(64) } } }, installation()), false);
  assert.equal(matchesInstallation({ sourceIdentity: { ...drifted, runtimeFiles: { ...runtime, 'src/extra.js': '5'.repeat(64) } } }, installation()), false);
});

test('module and product source suites match receipt source commits, not versions alone', () => {
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/vector-hub', version: '1.0.8-rc.5' } }, installation()), false);
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/vector-hub', version: '1.0.8-rc.5', commit: VECTOR_COMMIT, runtimeDirty: [] } }, installation()), 'source-commit');
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1' } }, installation()), false);
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1', commit: ROOT_COMMIT, runtimeDirty: [] } }, installation()), 'source-commit');
  assert.equal(matchesInstallation({ sourceIdentity: { name: '@sanqianx/claude-ai-workbench', version: '0.13.2-rc.11', commit: ROOT_COMMIT, runtimeDirty: [] } }, installation()), false);
});

test('system-suite aborts before running a suite when the receipt is not an official verified installation', async () => {
  for (const mutate of [
    receipt => { receipt.integrityPassed = false; },
    receipt => { receipt.registry = 'https://mirror.example.com/'; },
    receipt => { delete receipt.tag; },
    receipt => { receipt.sourceCommit = 'deadbeef'; },
    receipt => { receipt.distIntegrity = 'sha512-short'; },
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d2-receipt-'));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/project-knowledge', version: '5.0.16-rc.1' }));
    const receipt = { schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next', version: '5.0.16-rc.1', engineVersion: '0.2.7-rc.6', distIntegrity: INTEGRITY, sourceCommit: ROOT_COMMIT };
    mutate(receipt);
    const receiptFile = path.join(directory, 'receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const outcome = await new Promise(resolve => execFile(process.execPath,
      [path.join(__dirname, 'support/system-suite.js'), 'd2-receipt-refused24', directory, 'node', '-e', '0'],
      { env: { ...process.env, KB_TEST_NODE: '', KB_SUITE_INSTALL_RECEIPT: receiptFile } },
      (error, out, err) => resolve({ error, out, err })));
    assert.ok(outcome.error, 'an unofficial receipt must abort the suite run before it starts');
  }
});

const NODE22 = 'D:/SanQian.Xu/knowledge-engine/.agent-state/npm-node22-cache/_npx/52027bd8fc0022aa/node_modules/node/bin/node.exe';
const secondaryNode = fs.existsSync(NODE22) ? NODE22 : (process.env.KB_TEST_NODE && fs.existsSync(process.env.KB_TEST_NODE) ? process.env.KB_TEST_NODE : null);
test('system-suite reports the Node runtime it executes, not the harness that launched it', { skip: !secondaryNode && 'no second Node runtime available' }, async () => {
  const expected = await new Promise((resolve, reject) => execFile(secondaryNode, ['--version'], (error, out) => error ? reject(error) : resolve(out.trim())));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d2-node-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@sanqianx/ai-coding-knowledge-engine', version: '0.2.7-rc.6' }));
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, 'support/system-suite.js'), 'd2-node-identity24', directory, 'node', '-e', '0'],
    { env: { ...process.env, KB_TEST_NODE: secondaryNode } },
    (error, out, err) => error ? reject(new Error(err || out || String(error))) : resolve(out)));
  const summary = JSON.parse(stdout.trim().split('\n').pop());
  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'));
  assert.equal(report.command[0], secondaryNode);
  assert.equal(report.nodeVersion, expected);
  assert.equal(report.sourceIdentity.nodeVersion, expected);
  assert.equal(report.harnessNodeVersion, process.version);
  if (expected !== process.version) assert.notEqual(report.nodeVersion, process.version);
});

test('formal upgrades of new releases gate on this round\'s bound evidence with explicit exact expectations', () => {
  const formal = installation({ tag: 'latest', version: '5.0.16' });
  const plan = formalGatePlan(formal, { version: '5.0.16' }, 'retrieval-rc6');
  assert.equal(plan.bound, true);
  assert.deepEqual(plan.gates, ['retrieval-rc6-engine22', 'retrieval-rc6-engine24', 'retrieval-rc6-shell22', 'retrieval-rc6-shell24',
    'retrieval-formal-registry24', 'retrieval-formal-web24', 'retrieval-formal-web22', 'retrieval-formal-fault24', 'retrieval-formal-fault22',
    'retrieval-formal-lifecycle24', 'retrieval-formal-lifecycle22', 'retrieval-formal-claude-real24', 'retrieval-formal-codex-real24',
    'retrieval-formal-zcode-real24', 'retrieval-formal-opencode-real24', 'retrieval-formal-real-commits24', 'retrieval-formal-workbench24',
    'retrieval-formal-embedding24', 'retrieval-formal-quality24', 'retrieval-formal-performance24', 'retrieval-formal-surfaces24',
    'retrieval-formal-user-query24', 'retrieval-formal-local-marketplace24']);
  assert.throws(() => formalGatePlan(formal, {}, 'retrieval-rc6'), /expect-version/);
  assert.throws(() => formalGatePlan(formal, { version: '5.0.16-rc.1' }, 'retrieval-rc6'), /released version/);
  assert.equal(formalGatePlan(installation({ version: '5.0.16' }), { version: '5.0.16' }, 'retrieval-rc6').bound, true);
  assert.throws(() => formalGatePlan(installation({ version: '5.0.16', tag: 'legacy' }), { version: '5.0.16' }, 'retrieval-rc6'), /dist-tag/);
  assert.throws(() => formalGatePlan(formal, { version: '5.0.16' }, null), /source-prefix/);
  assert.throws(() => formalGatePlan(installation({ integrityPassed: false, tag: 'latest', version: '5.0.16' }), { version: '5.0.16' }, 'retrieval-rc6'), /integrity/);
  assert.equal(formalGatePlan(installation({ version: '5.0.15', tag: 'latest' }), { version: '5.0.15' }, 'retrieval-rc5'), null);
});
