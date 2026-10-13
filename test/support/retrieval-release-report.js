'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { latestSuite } = require('./acceptance-progress');
const AtomicFile = require('../../src/runtime/atomic-file');

function main() {
  const installationFile = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(installationFile));
  const prefix = process.argv[3]; assert.match(prefix || '', /^retrieval-(?:rc\d+|formal)$/);
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1'); assert.equal(installation.integrityPassed, true);
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const sourceLabels = ['retrieval-rc3-engine22', 'retrieval-rc3-engine24', 'retrieval-rc3-shell22', 'retrieval-rc3-shell24',
    'retrieval-source-vector22', 'retrieval-source-vector24', 'retrieval-source-workbench22', 'retrieval-source-workbench24', 'retrieval-source-bridge22', 'retrieval-source-bridge24'];
  const candidateLabels = ['registry24', 'web22', 'web24', 'fault22', 'fault24', 'lifecycle22', 'lifecycle24', 'quality24', 'performance24',
    'user-query24', 'local-marketplace24', 'real-commits24', 'claude-real24', 'zcode-real24', 'workbench24', 'embedding24', 'surfaces24'];
  const source = sourceLabels.map(label => latestSuite(directory, label));
  const installed = candidateLabels.map(label => latestSuite(directory, prefix + '-' + label));
  // Every invocation has an immutable receipt. Failed first attempts remain
  // visible; a newer successful run does not erase their existence.
  const failures = fs.readdirSync(directory).filter(name => /^retrieval-.*-\d+\.json$/.test(name)).flatMap(name => {
    const file = path.join(directory, name), value = JSON.parse(fs.readFileSync(file));
    return value.passed === false ? [{ label: value.label, exitCode: value.exitCode, report: file }] : [];
  });
  const localCorePassed = [...source, ...installed].every(gate => gate.passed);
  const report = { schema: 'retrieval-quality/release-gates/v1', checkedAt: new Date().toISOString(),
    status: localCorePassed ? 'local-core-passed-final-gates-pending' : 'in-progress', systemComplete: false,
    package: { version: installation.version, integrity: installation.distIntegrity, sourceCommit: installation.sourceCommit,
      engineVersion: installation.engineVersion, modules: installation.modules, installationFile },
    source, installed, failures, localCorePassed,
    remaining: [...[...source, ...installed].filter(g => !g.passed).map(g => g.label),
      'Exact released Codex Hook requires human native review; no trust changes or approval bypass by the agent.',
      'Formal package download and exact-byte acceptance, existing-v5 preservation/upgrade, daily latest reinstall and final real loop.',
      'The other computer and its private corpus have no new-version receipt; local results must not be presented as that machine passing.'],
    limits: ['The fixed 80-query synthetic corpus is split by problem family (60 train/20 held-out); it is not the other computer\'s corpus.',
      'The user storage query reads existing local knowledge; legacy vector results are honestly reported as lexical fallback, not verified vectors.',
      'Actual index location is checked through runtime status separately from historical Markdown references.',
      'Manual confirmed memories and genuine Agent candidates are identified separately in native receipts.',
      'OpenCode retains MCP/capture compatibility; automatic pre-prompt injection is not claimed.',
      'Desktop 1920x1080 only; no Electron implementation or Windows installer is included.'] };
  const output = path.join(directory, 'retrieval-release-' + installation.version + '.json'); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, status: report.status, passedGates: [...source, ...installed].filter(g => g.passed).length,
    totalGates: source.length + installed.length, remaining: report.remaining }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
