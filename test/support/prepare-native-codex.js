'use strict';
// Install ONLY this product's plugin through native commands. Trust remains a
// human action in /hooks; this script neither edits trust nor bypasses it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const owned = 'project-knowledge@project-knowledge';

function unrelatedConfig(source) {
  let skip = false;
  return source.replace(/\r\n/g, '\n').split('\n').filter(line => {
    if (/^\s*\[/.test(line)) skip = /^\s*\[(?:marketplaces\.project-knowledge|plugins\."project-knowledge@project-knowledge")\]\s*$/.test(line);
    return !skip;
  }).join('\n').trim();
}

async function main() {
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  assert.equal(installation.integrityPassed, true);
  assert.ok(installation.core.startsWith(installation.installedRoot + path.sep));
  require(path.join(installation.core, '_site/scripts/verify-product-runtime')).verifyProductRuntime(installation.core);
  const { IntegrationManager } = require(path.join(installation.core, '_site/lib/integration-installer'));
  // Codex 0.137 parses '@' inside a scoped npm path as a Git ref. Its normal
  // Git marketplace path avoids that upstream CLI issue. Pin the package's
  // published source commit, then compare plugin bytes with the npm package.
  assert.match(installation.sourceCommit, /^[a-f0-9]{40}$/);
  const marketplaceSource = 'SanQianX/project-knowledge-base@' + installation.sourceCommit;
  const manager = new IntegrationManager({ rootDir: installation.core, marketplaceSource });
  const configFile = path.join(os.homedir(), '.codex', 'config.toml');
  const beforeConfig = fs.readFileSync(configFile, 'utf8');
  const list = () => JSON.parse(manager.execute('codex', ['plugin', 'list', '--json']).stdout).installed;
  const others = plugins => plugins.filter(p => p.pluginId !== owned).map(p => ({ id: p.pluginId, version: p.version, enabled: p.enabled, source: p.source })).sort((a, b) => a.id.localeCompare(b.id));
  const before = list(), prior = before.find(p => p.pluginId === owned);
  assert.notEqual(prior?.enabled, false, 'never override a user-disabled plugin');
  const backup = path.resolve(__dirname, '../../../.project-knowledge-backups', 'pre-codex-native-' + Date.now());
  execFileSync(process.execPath, [path.join(__dirname, 'backup-client-configs.js'), backup], { windowsHide: true, stdio: 'pipe' });
  const output = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', 'codex-hook-setup-' + Date.now() + '.json');
  const report = { passed: false, installationFile, version: installation.version, integrity: installation.distIntegrity, marketplaceSource, pluginBytesVerifiedAgainstNpm: false, backup, priorVersion: prior?.version || null, unrelatedConfigBefore: digest(unrelatedConfig(beforeConfig)), at: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, report); save();
  try {
    if (prior) manager.execute('codex', ['plugin', 'remove', owned]);
    if (manager.codexMarketplaceExists()) manager.execute('codex', ['plugin', 'marketplace', 'remove', 'project-knowledge']);
    manager.installCodex();
    report.pluginBytesVerifiedAgainstNpm = true;
    const after = list();
    assert.deepEqual(others(after), others(before), 'all unrelated plugins retain source, version and enabled state');
    report.unrelatedConfigAfter = digest(unrelatedConfig(fs.readFileSync(configFile, 'utf8')));
    assert.equal(report.unrelatedConfigAfter, report.unrelatedConfigBefore, 'model, notify, permissions and other settings remain unchanged');
    const cwd = path.resolve(process.argv[3] || path.join(__dirname, '../..'));
    const snapshot = await manager.codexHookProbe({ command: manager.executable('codex'), env: process.env, cwd });
    report.hooks = (snapshot.data || []).flatMap(e => e.hooks || []).filter(h => h.pluginId === owned).map(h => ({ eventName: h.eventName, command: h.command, sourcePath: h.sourcePath, currentHash: h.currentHash, enabled: h.enabled, trustStatus: h.trustStatus, pluginId: h.pluginId }));
    assert.equal(report.hooks.length, 1, 'native discovery must load exactly one owned hook');
    assert.equal(report.hooks[0].eventName, 'userPromptSubmit');
    assert.equal(report.hooks[0].enabled, true);
    report.state = report.hooks[0].trustStatus === 'trusted' ? 'trusted-by-user' : 'waiting-user-review';
    report.passed = true; save();
    console.log(JSON.stringify({ output, ...report }, null, 2));
  } catch (error) { report.failure = error.message; save(); throw error; }
}
main().catch(error => { console.error('CODEX_NATIVE_SETUP_FAILED', error.message); process.exitCode = 1; });
