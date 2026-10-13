'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { snapshot, verify, assertInactive } = require('./existing-v5-audit');
const { latestSuite } = require('./acceptance-progress');

// Workbench agent sessions observed in real products; any of these means a
// user task is mid-flight and an upgrade would interrupt it.
const ACTIVE_AGENT_SESSION = ['running', 'starting', 'waiting-permission', 'thinking', 'pending-permission'];
const BOOTSTRAP_WORKBENCH = '0.13.2-rc.10';
const BOOTSTRAP_ENGINE = '0.2.7-rc.5';
const BOOTSTRAP_MODULES = { terminal: '@sanqianx/claude-ai-workbench', vectorHub: '@sanqianx/vector-hub', eventBridge: '@sanqianx/ai-coding-event-bridge-console' };

// A bootstrap candidate proves a safe, officially published upgrade only:
// a next-tagged 5.0.16-rc.N registry download with all four packaged module
// identities pinned and the new Workbench expected. It is not a formal
// system acceptance and must never install from latest.
function assertBootstrapCandidate(installation) {
  assert.equal(installation.registry, 'https://registry.npmjs.org/');
  assert.equal(installation.integrityPassed, true);
  assert.equal(installation.tag, 'next', 'bootstrap accepts a next-tagged candidate only, never latest');
  assert.match(installation.version || '', /^5\.0\.16-rc\.\d+$/);
  assert.equal(installation.engineVersion, BOOTSTRAP_ENGINE);
  for (const [key, packageName] of Object.entries(BOOTSTRAP_MODULES)) {
    const module = (installation.modules || {})[key];
    assert.ok(module && module.version && module.distIntegrity, `receipt module ${key} must carry registry identity`);
    assert.equal(module.packageName, packageName, `receipt module ${key} must be the official ${packageName}`);
  }
  assert.equal(installation.modules.terminal.version, BOOTSTRAP_WORKBENCH);
  return true;
}

async function main() {
  const bootstrap = process.argv.includes('--bootstrap-candidate');
  const installationFile = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(installationFile));
  const evidence = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  if (bootstrap) assertBootstrapCandidate(installation);
  else {
    assert.equal(installation.integrityPassed, true); assert.ok(['5.0.11', '5.0.12', '5.0.15'].includes(installation.version));
    const gates = installation.version === '5.0.15'
      ? ['retrieval-rc5-engine24', 'retrieval-rc5-engine22', 'retrieval-rc5-shell24', 'retrieval-rc5-shell22', ...['registry24', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'claude-real24', 'codex-real24', 'zcode-real24', 'opencode-real24', 'real-commits24', 'workbench24', 'embedding24', 'quality24', 'performance24', 'surfaces24', 'user-query24', 'local-marketplace24'].map(name => 'retrieval-formal-' + name)]
      : installation.version === '5.0.11'
      ? ['context-rc2-shell-source24', 'context-rc2-shell-source22', 'context-rc2-registry24', 'context-rc2-web24', 'context-rc2-web22', 'context-rc2-real-native24']
      : ['source-file-fixed24', 'source-file-fixed22', 'native-final-source24', 'native-final-source22', 'native-rc3-registry24', 'native-rc3-web24', 'native-rc3-web22', 'native-rc3-fault24', 'native-rc3-fault22', 'native-rc3-claude-real24', 'native-rc3-codex-real24', 'native-rc3-zcode-user-real24', 'native-rc3-real-commits24', 'native-rc3-workbench-real24', 'native-rc3-embedding24'];
    for (const name of gates) assert.equal(latestSuite(evidence, name).passed, true, name);
  }
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5'), core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const proof = path.join(evidence, 'context-user-upgrade-' + Date.now());
  const blocked = bootstrap || installation.version === '5.0.15';
  const report = { passed: false, mode: bootstrap ? 'bootstrap-candidate' : 'formal', systemAcceptanceComplete: false, installationFile, expectedVersion: installation.version, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(15000) }); assert.ok(response.ok, route); return response.json(); };
  const execute = async (script, args, timeoutMs = 65000) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, KB_DATA_DIR: dataDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-4000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0, output); return output.trim(); } finally { clearTimeout(timer); }
  };
  const indexFiles = root => {
    const result = {};
    const walk = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) walk(file); else if (item.isFile()) result[path.relative(root, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } }; walk(root); return result;
  };
  try {
    save(); const identity = await read('/api/runtime/identity'); assert.equal(identity.dataDir, dataDir);
    assertInactive((await read('/api/engine/runs')).runs, blocked);
    for (const project of (await read('/api/projects/aggregated')).projects) if (project.modules.terminal.registered) assert.ok((await read('/api/terminal/sessions?contextId=' + encodeURIComponent(project.modules.terminal.projectId))).sessions.every(s => !ACTIVE_AGENT_SESSION.includes(s.state)), 'do not interrupt a user task');
    const before = snapshot(dataDir, core), state = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json')));
    const indexRoot = (await read('/api/brain')).configuration.indexStorage.actualPath; assert.ok(typeof indexRoot === 'string' && indexRoot.trim() && path.isAbsolute(indexRoot), 'index root must be a real absolute path from the live configuration'); const indexes = indexFiles(indexRoot);
    // Retain original v5 state and secrets behind a user-only ACL. The public
    // acceptance receipt contains hashes and paths, never configuration bodies.
    const backup = path.resolve(__dirname, '../../../.project-knowledge-backups/user-upgrade-' + Date.now());
    await execute(path.join(__dirname, 'backup-client-configs.js'), [backup]);
    const copy = (source, target) => {
      if (!fs.existsSync(source)) return;
      const item = fs.lstatSync(source); assert.equal(item.isSymbolicLink(), false, 'no backup traversal through links');
      if (item.isDirectory()) { fs.mkdirSync(target, { recursive: true }); for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name)); }
      else if (item.isFile()) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
    };
    for (const relative of ['settings.json', 'projects.json', 'product-data.json', 'claude-prompts.json', 'projects', 'knowledge-engine/engine-state.json', 'workbench/profiles.v2.json', 'workbench/credentials.v1.json', 'vectorhub/config.json']) copy(path.join(dataDir, relative), path.join(backup, 'v5', relative));
    report.backup = backup; report.before = before; report.beforeIdentity = identity; save(); const owned = path.join(proof, 'owned-processes.json');
    await execute(path.join(__dirname, 'owned-process-audit.js'), ['record', owned, String(identity.pid)]);
    await execute(path.join(core, 'bin/project-knowledge.js'), ['stop']); await execute(path.join(__dirname, 'owned-process-audit.js'), ['verify', owned, 'graceful']);
    await execute(path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ['install', '-g', '@sanqianx/project-knowledge@' + installation.version, '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund'], 180000);
    await execute(path.join(core, 'bin/project-knowledge.js'), ['--no-open']);
    const deadline = Date.now() + 180000; let ready = false;
    while (Date.now() < deadline) { try { const current = await read('/api/runtime/identity'), health = await read('/api/modules/health'); if (current.version === installation.version && health.ownership.ready && Object.values(health.modules).every(m => m.up)) { report.identity = current; ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); }
    assert.equal(ready, true); const after = snapshot(dataDir, core); verify(before, after, { frozen: true, allowBlocked: blocked }); assert.equal(after.version, installation.version);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json'))).memories, state.memories); assert.deepEqual(indexFiles(indexRoot), indexes);
    await execute(path.join(__dirname, 'verify-global-registry.js'), [installationFile, core, path.join(proof, 'package-bytes.json')]);
    Object.assign(report, { passed: true, after, indexRoot, unchangedIndexFiles: Object.keys(indexes).length, finishedAt: new Date().toISOString() }); save();
    console.log((bootstrap ? 'USER_CONTEXT_BOOTSTRAP_PASSED ' : 'USER_CONTEXT_PRODUCT_UPGRADE_PASSED ') + path.join(proof, 'result.json'));
  } catch (error) { report.failure = String(error.message).slice(0, 1600); save(); throw error; }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertBootstrapCandidate, ACTIVE_AGENT_SESSION, BOOTSTRAP_WORKBENCH };
