'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { latestSuite } = require('./acceptance-progress');

async function main() {
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.version, '5.0.11'); assert.equal(installation.integrityPassed, true);
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const source = ['context-engine-final22', 'context-engine-final24', 'context-workbench-source22', 'context-workbench-source24', 'context-rc2-shell-source22', 'context-rc2-shell-source24'].map(name => latestSuite(directory, name));
  const candidate = ['context-rc2-registry24', 'context-rc2-web22', 'context-rc2-web24', 'context-rc2-fault22', 'context-rc2-fault24', 'context-rc2-startup22', 'context-rc2-real-native24', 'context-rc2-workbench-real24'].map(name => latestSuite(directory, name));
  const formal = ['context-formal-registry24', 'context-formal-web22', 'context-formal-web24', 'context-formal-startup22', 'context-formal-startup24', 'context-formal-fault22', 'context-formal-fault24', 'context-formal-native24', 'context-formal-workbench24', 'context-formal-embedding24'].map(name => latestSuite(directory, name));
  const user = ['context-user-upgrade24', 'context-user-native24', 'context-user-workbench24', ...(process.argv.includes('--final') ? ['context-user-latest24'] : [])].map(name => latestSuite(directory, name));
  for (const result of [...source, ...candidate, ...formal, ...user]) assert.equal(result.passed, true, result.label);
  const identity = await (await fetch('http://127.0.0.1:5757/api/runtime/identity')).json(); assert.equal(identity.version, installation.version);
  const report = {
    schema: 'automatic-context/release-acceptance/v1', status: 'claude-first-batch-accepted', checkedAt: new Date().toISOString(), entirePlanComplete: false,
    package: { version: installation.version, integrity: installation.distIntegrity, sourceCommit: installation.sourceCommit, installationFile }, source, candidate, formal, user, identity,
    changes: { engine: 'f83a3383719afb8db2e13bf0062bc0d0c412c8cc', workbench: 'baedfaa44e21c49b428e1d2732c6348f17a887a8', shell: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../../project-knowledge-base'), encoding: 'utf8', windowsHide: true }).trim() },
    verified: [
      'Ordinary external Claude Code task: first actual development model request contains indexed project facts and applicable confirmed project memory without a retrieval reminder.',
      'Actual generated code follows the confirmed memory; original user prompt is captured unchanged, and injected memory is not forged user evidence.',
      'Native development -> real commit -> real Agent maintenance -> promotion -> real MiniMax embeddings -> index -> subsequent context cites the new commit.',
      'Existing user native plugin configuration and actual registered repository read facts before the first development request; worktree unchanged.',
      'Workbench sends the same engine envelope; native hook is suppressed only when Workbench has already provided context.',
      'Memory reads are keyword independent and scope checked; ignored/unconfirmed/corrupt memories are excluded, separately budgeted, edited files are read canonically.',
      'Stale Claude plugin is upgraded and native Git CRLF is accepted only for integration-text comparison; published integrity remains byte exact.',
      'Instance identity and data directory are verified; service failure warns and continues rather than pretending there is no knowledge.',
      'Existing v5 projects, histories, preferences, knowledge and vector files survive the official global npm upgrade; vector path remains on D drive.'
    ],
    evidenceRoots: [path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5'), path.resolve(__dirname, '../../.agent-state/registry-temp/智脑桌面验收-7sCmKT'), directory],
    firstFailuresRetained: [
      'RC.1 falsely rejected the updated native Claude plugin because Git converted LF to CRLF; fixed with a reproducing regression, RC.2 and formal native installation passed.',
      'An initial acceptance assumption incorrectly treated the native title generator as a development request; only the explicitly identified auxiliary title request is excluded, every earlier unknown request still fails.',
      'An isolated probe copied a previous probe with a different fixture memory; reports retained, untracked prior probes archived outside the test repository and confirmed preference reused.',
      'A source web test invocation lacking KB_PRODUCT_INSTALLATION_REPORT was excluded from npm evidence and rerun with official installed runtime roots.'
    ],
    remaining: [...(process.argv.includes('--final') ? [] : ['Promote latest and repeat daily stop/install/version/start with preservation checks.']), 'Codex native UserPromptSubmit integration, per-definition native trust review and real external acceptance.', 'ZCode native automatic context integration and real external acceptance.', 'OpenCode remains compatibility-only; no unverified automatic injection claim.'],
    notClaimed: ['Complete multi-client implementation', 'Other computer environment acceptance', 'Guarantee of no future defects', 'Automatic context for internal native title-generation requests', 'Actual user confirmed-memory acceptance: user memory library is empty; real evidenced candidate acceptance uses the controlled registered fixture.']
  };
  const output = path.join(directory, 'automatic-context-release-5.0.11.json'); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, status: report.status, totalGates: source.length + candidate.length + formal.length + user.length, remaining: report.remaining }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
