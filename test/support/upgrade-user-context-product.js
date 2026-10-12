'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { snapshot, verify } = require('./existing-v5-audit');
const { latestSuite } = require('./acceptance-progress');
async function main() {
  const installationFile = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.integrityPassed, true); assert.equal(installation.version, '5.0.11');
  const evidence = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  for (const name of ['context-rc2-shell-source24', 'context-rc2-shell-source22', 'context-rc2-registry24', 'context-rc2-web24', 'context-rc2-web22', 'context-rc2-real-native24']) assert.equal(latestSuite(evidence, name).passed, true, name);
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5'), core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const proof = path.join(evidence, 'context-user-upgrade-' + Date.now());
  const report = { passed: false, installationFile, expectedVersion: installation.version, startedAt: new Date().toISOString() };
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
    assert.ok((await read('/api/engine/runs')).runs.every(r => r.state === 'succeeded'), 'wait until user maintenance is idle');
    for (const project of (await read('/api/projects/aggregated')).projects) if (project.modules.terminal.registered) assert.ok((await read('/api/terminal/sessions?contextId=' + encodeURIComponent(project.modules.terminal.projectId))).sessions.every(s => !['running', 'starting', 'waiting-permission'].includes(s.state)), 'do not interrupt a user task');
    const before = snapshot(dataDir, core), state = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json')));
    const indexRoot = (await read('/api/brain')).configuration.indexStorage.actualPath; assert.equal(indexRoot, 'D:\\SanQian.Xu\\knowledge\\.indexes'); const indexes = indexFiles(indexRoot);
    report.before = before; report.beforeIdentity = identity; save(); const owned = path.join(proof, 'owned-processes.json');
    await execute(path.join(__dirname, 'owned-process-audit.js'), ['record', owned, String(identity.pid)]);
    await execute(path.join(core, 'bin/project-knowledge.js'), ['stop']); await execute(path.join(__dirname, 'owned-process-audit.js'), ['verify', owned, 'graceful']);
    await execute(path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ['install', '-g', '@sanqianx/project-knowledge@' + installation.version, '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund'], 180000);
    await execute(path.join(core, 'bin/project-knowledge.js'), ['--no-open']);
    const deadline = Date.now() + 180000; let ready = false;
    while (Date.now() < deadline) { try { const current = await read('/api/runtime/identity'), health = await read('/api/modules/health'); if (current.version === installation.version && health.ownership.ready && Object.values(health.modules).every(m => m.up)) { report.identity = current; ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); }
    assert.equal(ready, true); const after = snapshot(dataDir, core); verify(before, after, { frozen: true }); assert.equal(after.version, installation.version);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json'))).memories, state.memories); assert.deepEqual(indexFiles(indexRoot), indexes);
    await execute(path.join(__dirname, 'verify-global-registry.js'), [installationFile, core, path.join(proof, 'package-bytes.json')]);
    Object.assign(report, { passed: true, after, indexRoot, unchangedIndexFiles: Object.keys(indexes).length, finishedAt: new Date().toISOString() }); save(); console.log('USER_CONTEXT_PRODUCT_UPGRADE_PASSED ' + path.join(proof, 'result.json'));
  } catch (error) { report.failure = String(error.message).slice(0, 1600); save(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
