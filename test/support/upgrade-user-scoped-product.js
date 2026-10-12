'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { snapshot, verify } = require('./existing-v5-audit');
const { publicFiles } = require('./verify-global-registry');
const { latestSuite } = require('./acceptance-progress');
const crypto = require('node:crypto');

async function main() {
  const installationFile = path.resolve(process.argv[2]), installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.integrityPassed, true); assert.match(installation.version, /^5\.0\.\d+$/);
  const evidence = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  for (const suffix of ['registry', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'real24']) assert.equal(latestSuite(evidence, 'memory-formal-' + suffix).passed, true, 'formal package gate: ' + suffix);
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5'), core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', 'memory-upgrade-' + Date.now());
  const reportFile = path.join(proof, 'result.json');
  const report = { passed: false, expectedVersion: installation.version, installationFile, dataDir, startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(reportFile, report);
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const execute = async (script, args, timeout = 65000) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, KB_DATA_DIR: dataDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-4000); });
    const timer = setTimeout(() => child.kill(), timeout);
    try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0, output); return output.trim(); }
    finally { clearTimeout(timer); }
  };
  const fingerprint = directory => Object.fromEntries(publicFiles(directory).filter(f => !['settings.json', 'config.json'].includes(f)).map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, f))).digest('hex')]));
  const memories = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge-engine/engine-state.json'))).memories;
  try {
    save(); const identity = await read('/api/runtime/identity'); assert.equal(identity.dataDir, dataDir); assert.equal(identity.version, JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version);
    assert.ok((await read('/api/engine/runs')).runs.every(r => r.state === 'succeeded'), 'do not interrupt active maintenance');
    assert.ok((await read('/api/terminal/sessions')).sessions.every(s => !['running', 'starting', 'waiting-permission'].includes(s.state)), 'do not interrupt an active user workbench task');
    const before = snapshot(dataDir, core), beforeMemories = memories();
    const indexRoot = (await read('/api/brain')).configuration.indexStorage.actualPath;
    assert.equal(indexRoot, 'D:\\SanQian.Xu\\knowledge\\.indexes'); const beforeIndexes = fingerprint(indexRoot);
    report.before = before; report.beforeIdentity = identity; report.memoryCount = beforeMemories.length; save();
    const owned = path.join(proof, 'owned-processes.json');
    await execute(path.join(__dirname, 'owned-process-audit.js'), ['record', owned, String(identity.pid)]);
    await execute(path.join(core, 'bin/project-knowledge.js'), ['stop']);
    await execute(path.join(__dirname, 'owned-process-audit.js'), ['verify', owned, 'graceful']);
    await execute(path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ['install', '-g', '@sanqianx/project-knowledge@' + installation.version, '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund'], 180000);
    assert.equal(await execute(path.join(core, 'bin/project-knowledge.js'), ['--version']), installation.version);
    await execute(path.join(core, 'bin/project-knowledge.js'), []);
    const deadline = Date.now() + 180000; let ready = false;
    while (Date.now() < deadline) {
      try { const current = await read('/api/runtime/identity'), health = await read('/api/modules/health'), brain = await read('/api/brain'); if (current.version === installation.version && health.ownership.ready && Object.values(health.modules).every(m => m.up) && brain.configuration.indexStorage.status === 'ready' && brain.configuration.scopeStatus.status === 'ready') { report.identity = current; ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(ready, true); assert.notEqual(report.identity.pid, identity.pid);
    const after = snapshot(dataDir, core); verify(before, after, { frozen: true });
    assert.deepEqual(memories(), beforeMemories, 'upgrade must not rewrite confirmed or candidate memory metadata');
    assert.deepEqual(fingerprint(indexRoot), beforeIndexes, 'upgrade must not rebuild paid vectors');
    const bytes = path.join(evidence, 'global-memory-registry-bytes.json');
    await execute(path.join(__dirname, 'verify-global-registry.js'), [installationFile, core, bytes]);
    Object.assign(report, { passed: true, after, owned, globalBytes: bytes, indexRoot, vectorFilesUnchanged: Object.keys(beforeIndexes).length, finishedAt: new Date().toISOString() }); save();
    console.log('USER_SCOPED_PRODUCT_UPGRADE_PASSED ' + reportFile);
  } catch (error) { report.failure = { code: error.code || 'UPGRADE_FAILED', message: String(error.message).slice(0, 1500) }; save(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
