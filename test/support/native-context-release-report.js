'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const { latestSuite } = require('./acceptance-progress');
const SOURCE = ['source-file-fixed22', 'source-file-fixed24', 'native-final-source22', 'native-final-source24', 'native-workbench-source22', 'native-workbench-final24'];
const CANDIDATE = ['registry24', 'web22', 'web24', 'fault22', 'fault24', 'startup22', 'startup24', 'claude-real24', 'codex-real24', 'zcode-user-real24', 'real-commits24', 'workbench-real24', 'embedding24'];
const FORMAL = ['registry24', 'web22', 'web24', 'fault22', 'fault24', 'startup22', 'startup24', 'claude-real24', 'codex-real24', 'zcode-user-real24', 'real-commits24', 'workbench-real24', 'embedding24'];
const USER = ['upgrade24', 'native24', 'workbench24', 'latest24'];

async function main() {
  const file = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(file));
  const final = process.argv.includes('--final');
  assert.equal(installation.integrityPassed, true);
  assert.equal(installation.version, final ? '5.0.12' : '5.0.12-rc.3');
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const source = SOURCE.map(label => latestSuite(directory, label));
  const candidate = CANDIDATE.map(label => latestSuite(directory, 'native-rc3-' + label));
  const formal = final ? FORMAL.map(label => latestSuite(directory, 'native-formal-' + label)) : [];
  const user = final ? USER.map(label => latestSuite(directory, 'native-user-' + label)) : [];
  for (const gate of [...source, ...candidate, ...formal, ...user]) assert.equal(gate.passed, true, gate.label);
  const retainedFailures = fs.readdirSync(directory).filter(name => /^(memory-priority-|native-|source-file-|zcode-prefix-).*\d+\.json$/.test(name)).flatMap(name => { const report = JSON.parse(fs.readFileSync(path.join(directory, name))); return report.passed === false ? [{ label: report.label, file: path.join(directory, name), exitCode: report.exitCode }] : []; });
  const report = { schema: 'automatic-context/native-release/v1', checkedAt: new Date().toISOString(), status: final ? 'accepted' : 'candidate-accepted-formal-pending', phaseComplete: final, package: { version: installation.version, integrity: installation.distIntegrity, sourceCommit: installation.sourceCommit, engineVersion: installation.engineVersion, modules: installation.modules, installationFile: file }, source, candidate, formal, user, retainedFailures,
    verified: ['Claude Code, Codex and ZCode first native development requests receive the same real indexed facts and applicable confirmed memory without a search reminder.', 'Edited preferences affect actual Claude Code and ZCode generated code while old code and historical facts remain intact.', 'Codex trust was granted by the human in native /hooks; discovery before trust was untrusted and blocked this test without making a model call.', 'Existing ZCode model, env, third-party hooks and capture retained; only an owned knowledge reader installed.', 'Real single and two-project overlapping maintenance promote files, build real 1536-dimensional MiniMax vectors and return original commit references.', 'Workbench real UI send, streamed increments, persisted final reply and citations; no duplicate native context when the host provides it.', 'Explicit known source filename retrieves its own evidence despite similar historical vectors; unknown filename retains semantic background.', 'Node 22/24 desktop UI, faults, module recovery and targeted STOP verified on independently downloaded npm runtimes.'],
    inheritedSystemEvidence: path.join(directory, 'automatic-context-release-5.0.11.json'),
    remaining: final ? [] : ['Formal npm download, formal installed matrix, actual-user upgrade and daily latest reinstall.'],
    limits: ['OpenCode retains MCP/capture compatibility; automatic pre-prompt injection is not claimed.', 'Codex native model verification is a read-only interface task; Claude Code and ZCode additionally generate and commit controlled code.', 'User memory library was not seeded; evidenced confirmed-memory exercises use controlled registered projects.', 'No acceptance on the other computer is claimed.', 'Results prove the recorded cases and environment, not an absence of all future defects.'] };
  if (final) {
    const identity = await (await fetch('http://127.0.0.1:5757/api/runtime/identity')).json(); assert.equal(identity.version, installation.version); report.actualIdentity = identity;
  }
  const output = path.join(directory, 'native-context-release-' + installation.version + '.json'); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, status: report.status, gates: source.length + candidate.length + formal.length + user.length, remaining: report.remaining }));
}
main().catch(error => { console.error('NATIVE_RELEASE_GATE_FAILED', error.message); process.exitCode = 1; });
