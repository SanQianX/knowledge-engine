'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { snapshot, verify } = require('./existing-v5-audit');
const { publicFiles } = require('./verify-global-registry');
const crypto = require('node:crypto');
const fingerprint = root => Object.fromEntries(publicFiles(root).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));

async function main() {
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.ok(installation.integrityPassed && /^5\.0\.\d+$/.test(installation.version));
  const exact = process.argv.includes('--exact');
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const cli = path.join(core, 'bin/project-knowledge.js');
  const proof = path.resolve(__dirname, `../../.agent-state/acceptance/system-regression/${exact ? 'frozen-exact' : 'latest-daily'}-${Date.now()}`);
  fs.mkdirSync(proof, { recursive: true });
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok); return response.json(); };
  const execute = async (script, args, timeoutMs = 65000) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KB_DATA_DIR: dataDir } });
    let output = ''; child.stdout.on('data', bytes => { output = (output + bytes).slice(-6000); }); child.stderr.on('data', bytes => { output = (output + bytes).slice(-6000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); assert.equal(code, 0, output); return output.trim(); }
    finally { clearTimeout(timer); }
  };
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!exact) {
    const tag = await execute(npm, ['view', '@sanqianx/project-knowledge', 'dist-tags.latest', '--registry=https://registry.npmjs.org/', '--prefer-online']);
    assert.equal(tag, installation.version, 'latest must be the accepted formal version');
  }
  const beforeIdentity = await read('/api/runtime/identity'); assert.equal(beforeIdentity.version, installation.version);
  assert.ok((await read('/api/engine/runs')).runs.every(run => run.state === 'succeeded'), 'never interrupt active maintenance');
  const before = snapshot(dataDir, core);
  const indexRoot = (await read('/api/brain')).configuration.indexStorage.actualPath;
  const vectorsBefore = fingerprint(indexRoot);
  const ownedFile = path.join(proof, 'owned-processes.json');
  await execute(path.join(__dirname, 'owned-process-audit.js'), ['record', ownedFile, String(beforeIdentity.pid)]);
  await execute(cli, ['stop']);
  await execute(path.join(__dirname, 'owned-process-audit.js'), ['verify', ownedFile, 'graceful']);
  const specifier = `@sanqianx/project-knowledge@${exact ? installation.version : 'latest'}`;
  await execute(npm, ['install', '-g', specifier, '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund'], 180000);
  assert.equal(await execute(cli, ['--version']), installation.version);
  await execute(cli, []);
  const deadline = Date.now() + 180000;
  let identity, brain, ready = false;
  do {
    try { identity = await read('/api/runtime/identity'); brain = await read('/api/brain'); const modules = await read('/api/modules/health'); if (identity.version === installation.version && modules.ownership.ready && Object.values(modules.modules).every(module => module.up) && brain.configuration.indexStorage.status === 'ready') { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.equal(ready, true, 'all modules, engine ownership and index storage must acknowledge readiness after npm reinstall');
  assert.equal(identity?.version, installation.version); assert.notEqual(identity.pid, beforeIdentity.pid);
  assert.equal(brain.configuration.indexStorage.status, 'ready');
  verify(before, snapshot(dataDir, core), { frozen: true });
  assert.deepEqual(fingerprint(indexRoot), vectorsBefore, 'daily reinstall must not rebuild paid vectors');
  const rebuild = await read('/api/vectorhub/rebuild/status'); assert.equal(rebuild.running, false); assert.equal(rebuild.total, 0); assert.deepEqual(rebuild.errors, []);
  const bytes = path.join(proof, 'official-bytes.json');
  await execute(path.join(__dirname, 'verify-global-registry.js'), [installationFile, core, bytes]);
  const report = { passed: true, mode: exact ? 'frozen exact-version reinstall' : 'user daily latest reinstall', version: installation.version, sequence: ['stop', `npm install -g ${specifier} --registry=https://registry.npmjs.org/`, '--version', 'start'], beforeIdentity, identity, projectsPreserved: before.projects.length, completedRunsPreserved: before.runs.length, realVectorFilesUnchanged: Object.keys(vectorsBefore).length, indexRoot, rebuild, ownedFile, registryBytes: bytes, checkedAt: new Date().toISOString() };
  AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report); console.log(`${exact ? 'FROZEN_EXACT_INSTALL' : 'LATEST_DAILY_INSTALL'}_PASSED ${proof}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
