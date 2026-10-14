'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { latestSuite } = require('./acceptance-progress');
const AtomicFile = require('../../src/runtime/atomic-file');
const { NPM_INTEGRITY, OFFICIAL_REGISTRY, isRealCommit, isNewRelease, assertOfficialReceipt } = require('./official-receipt');

// Source suites vouch for this batch through the running repository's own
// identity: the version plus, correspondingly, the official receipt's root
// sourceCommit, modules.*.sourceCommit or the vendored engine commit (or
// its exact runtime content). A suite without matching identity counts as
// not-run and can never lend an older version's pass to this release.
const SOURCE_REPO_EXPECTATIONS = {
  '@sanqianx/project-knowledge': installation => installation.version,
  '@sanqianx/ai-coding-knowledge-engine': installation => installation.engineVersion,
  '@sanqianx/vector-hub': installation => installation.modules && installation.modules.vectorHub && installation.modules.vectorHub.version,
  '@sanqianx/claude-ai-workbench': installation => installation.modules && installation.modules.terminal && installation.modules.terminal.version,
  '@sanqianx/ai-coding-event-bridge-console': installation => installation.modules && installation.modules.eventBridge && installation.modules.eventBridge.version,
};
const SOURCE_MODULE_KEYS = {
  '@sanqianx/claude-ai-workbench': 'terminal',
  '@sanqianx/vector-hub': 'vectorHub',
  '@sanqianx/ai-coding-event-bridge-console': 'eventBridge',
};

function sourceSuiteMatches(source, installation) {
  const expectation = SOURCE_REPO_EXPECTATIONS[source.name];
  if (!expectation || source.version !== expectation(installation)) return false;
  const commit = typeof source.commit === 'string' && isRealCommit(source.commit) ? source.commit : null;
  const clean = Array.isArray(source.runtimeDirty) && source.runtimeDirty.length === 0;
  if (source.name === '@sanqianx/ai-coding-knowledge-engine') {
    const vendored = installation.vendorManifest && installation.vendorManifest.modules && installation.vendorManifest.modules['knowledge-engine'];
    if (!vendored || !isRealCommit(vendored.sourceCommit)) return false;
    // Test or documentation commits after the release commit do not change
    // the published runtime, so an exact runtime content match is accepted
    // evidence; otherwise only the exact release commit on a clean runtime
    // tree counts. A test helper's newer HEAD never impersonates a release.
    if (commit && clean && commit === vendored.sourceCommit) return 'source-commit';
    if (source.runtimeFiles && vendored.files) {
      for (const key of new Set([...Object.keys(vendored.files), ...Object.keys(source.runtimeFiles)])) if (vendored.files[key] !== source.runtimeFiles[key]) return false;
      return 'source-content';
    }
    return false;
  }
  const expectedCommit = source.name === '@sanqianx/project-knowledge' ? installation.sourceCommit
    : installation.modules && installation.modules[SOURCE_MODULE_KEYS[source.name]] && installation.modules[SOURCE_MODULE_KEYS[source.name]].sourceCommit;
  return Boolean(commit && clean && isRealCommit(expectedCommit) && commit === expectedCommit) ? 'source-commit' : false;
}

function matchesInstallation(suite, installation) {
  if (suite.installIdentity) {
    const identity = suite.installIdentity;
    // Both sides must carry official verified provenance — the registry and
    // the integrity verdict — themselves; a side lacking them is not evidence
    // and reads as not-run instead of being trusted by default. Degenerate
    // identities (all-zero or short commit, missing digest) never pass either.
    for (const side of [identity, installation]) {
      if (side.registry !== OFFICIAL_REGISTRY || side.integrityPassed !== true) return false;
      if (!NPM_INTEGRITY.test(side.distIntegrity || '') || !isRealCommit(side.sourceCommit)) return false;
    }
    if (identity.version !== installation.version || identity.distIntegrity !== installation.distIntegrity) return false;
    if (identity.sourceCommit !== installation.sourceCommit) return false;
    return 'install-receipt';
  }
  if (suite.sourceIdentity) return sourceSuiteMatches(suite.sourceIdentity, installation);
  return false;
}

function latestBoundSuite(directory, label, installation) {
  const files = fs.readdirSync(directory).filter(name => name.startsWith(label + '-') && /^\d+\.json$/.test(name.slice(label.length + 1))).sort().reverse();
  for (const name of files) {
    const suite = JSON.parse(fs.readFileSync(path.join(directory, name)));
    assert.equal(suite.label, label);
    const matched = matchesInstallation(suite, installation);
    if (!matched) continue;
    const passed = suite.passed === true && suite.exitCode === 0;
    return { label, passed, status: passed ? 'passed' : 'failed', exitCode: suite.exitCode, durationMs: suite.durationMs, report: path.join(directory, name), matched };
  }
  return { label, passed: false, status: 'not-run', matched: null };
}

function buildReport({ installation, installationFile = null, prefix, bindReceipt = false, sourcePrefixArg = null, directory }) {
  assert.match(prefix || '', /^retrieval-(?:rc\d+|formal)$/);
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1'); assert.equal(installation.integrityPassed, true);
  // 5.0.16 and every later release cannot rely on a forgettable --bind-receipt
  // switch: identity binding is mandatory and missing evidence reads as
  // not-run. Only the frozen <= 5.0.15 history keeps the unbound fallback.
  const bound = bindReceipt || isNewRelease(installation.version);
  if (bound) {
    assertOfficialReceipt(installation);
    if (sourcePrefixArg) assert.match(sourcePrefixArg, /^retrieval-rc\d+$/, '--source-prefix must name this batch source round as retrieval-rcN');
    else if (prefix === 'retrieval-formal') throw new Error('a formal report for this release requires --source-prefix=retrieval-rcN naming this batch source round; it must not reuse an older one');
  } else if (sourcePrefixArg) throw new Error('--source-prefix requires --bind-receipt');
  const sourcePrefix = sourcePrefixArg || (!bound && prefix === 'retrieval-formal' ? 'retrieval-rc5' : prefix);
  const sourceLabels = [sourcePrefix + '-engine22', sourcePrefix + '-engine24', sourcePrefix + '-shell22', sourcePrefix + '-shell24',
    'retrieval-source-vector22', 'retrieval-source-vector24', 'retrieval-source-workbench22', 'retrieval-source-workbench24', 'retrieval-source-bridge22', 'retrieval-source-bridge24'];
  const candidateLabels = ['registry24', 'web22', 'web24', 'fault22', 'fault24', 'lifecycle22', 'lifecycle24', 'quality24', 'performance24',
    'user-query24', 'local-marketplace24', 'real-commits24', 'claude-real24', 'codex-real24', 'zcode-real24', 'opencode-real24', 'workbench24', 'embedding24', 'surfaces24'];
  const lookup = bound ? label => latestBoundSuite(directory, label, installation) : label => latestSuite(directory, label);
  const source = sourceLabels.map(lookup);
  const installed = candidateLabels.map(label => lookup(prefix + '-' + label));
  // Every invocation has an immutable receipt. Failed first attempts remain
  // visible; a newer successful run does not erase their existence.
  const failures = fs.readdirSync(directory).filter(name => /^retrieval-.*-\d+\.json$/.test(name)).flatMap(name => {
    const file = path.join(directory, name), value = JSON.parse(fs.readFileSync(file));
    return value.passed === false ? [{ label: value.label, exitCode: value.exitCode, report: file }] : [];
  });
  const localCorePassed = [...source, ...installed].every(gate => gate.passed);
  const report = { schema: 'retrieval-quality/release-gates/v1', checkedAt: new Date().toISOString(),
    status: localCorePassed ? 'local-core-passed-final-gates-pending' : 'in-progress', systemComplete: false, bound,
    package: { version: installation.version, integrity: installation.distIntegrity, sourceCommit: installation.sourceCommit,
      engineVersion: installation.engineVersion, modules: installation.modules, installationFile },
    source, installed, failures, localCorePassed,
    remaining: [...[...source, ...installed].filter(g => !g.passed).map(g => g.label),
      'Formal package download and exact-byte acceptance, existing-v5 preservation/upgrade, daily latest reinstall and final real loop.',
      'The other computer and its private corpus have no new-version receipt; local results must not be presented as that machine passing.'],
    limits: ['The fixed 80-query synthetic corpus is split by problem family (60 train/20 held-out); it is not the other computer\'s corpus.',
      'The user storage query reads existing local knowledge; legacy vector results are honestly reported as lexical fallback, not verified vectors.',
      'Actual index location is checked through runtime status separately from historical Markdown references.',
      'Manual confirmed memories and genuine Agent candidates are identified separately in native receipts.',
      'OpenCode retains MCP/capture compatibility; automatic pre-prompt injection is not claimed.',
      'Desktop 1920x1080 only; no Electron implementation or Windows installer is included.'] };
  if (bound) report.binding = { mode: 'official-download-receipt', version: installation.version, distIntegrity: installation.distIntegrity, sourceCommit: installation.sourceCommit,
    engineVersion: installation.engineVersion,
    moduleVersions: { terminal: installation.modules && installation.modules.terminal && installation.modules.terminal.version,
      vectorHub: installation.modules && installation.modules.vectorHub && installation.modules.vectorHub.version,
      eventBridge: installation.modules && installation.modules.eventBridge && installation.modules.eventBridge.version } };
  return report;
}

function main() {
  const bindReceipt = process.argv.includes('--bind-receipt');
  const sourcePrefixArg = (process.argv.find(argument => argument.startsWith('--source-prefix=')) || '').slice('--source-prefix='.length) || null;
  const installationFile = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(installationFile));
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const report = buildReport({ installation, installationFile, prefix: process.argv[3], bindReceipt, sourcePrefixArg, directory });
  const output = path.join(directory, 'retrieval-release-' + installation.version + '.json'); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, status: report.status, bound: report.bound, passedGates: [...report.source, ...report.installed].filter(g => g.passed).length,
    totalGates: report.source.length + report.installed.length, remaining: report.remaining }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { buildReport, latestBoundSuite, matchesInstallation };
