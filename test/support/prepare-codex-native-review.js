'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const installation = JSON.parse(fs.readFileSync(process.argv[2])); assert.equal(installation.integrityPassed, true);
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  const backup = path.resolve(process.argv[3]); assert.ok(backup.startsWith(path.resolve(__dirname, '../../../.project-knowledge-backups') + path.sep));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  const config = path.join(os.homedir(), '.codex/config.toml');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  assert.equal(hash(fs.readFileSync(config)), manifest.files.find(f => f.relative === '.codex/config.toml')?.sha256, 'client configuration changed since backup; do not replace it');
  const { IntegrationManager } = require(path.join(installation.core, '_site/lib/integration-installer'));
  const manager = new IntegrationManager({ rootDir: installation.core, marketplaceSource: installation.core });
  const existing = manager.codexPlugin(); assert.ok(existing && existing.enabled !== false, 'existing enabled owned plugin required');
  const globalCore = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sourceVersion = JSON.parse(read(path.join(existing.source.path, '.codex-plugin/plugin.json'))).version;
  const previousFile = process.argv[4];
  const previous = previousFile ? JSON.parse(fs.readFileSync(previousFile)) : null;
  if (previous) {
    assert.equal(previous.schema, 'project-knowledge/installed-registry/v1'); assert.equal(previous.integrityPassed, true);
    assert.equal(JSON.parse(read(path.join(previous.core, 'package.json'))).version, previous.version);
    require(path.join(previous.core, '_site/scripts/verify-product-runtime')).verifyProductRuntime(previous.core);
  }
  const referenceCore = sourceVersion === installation.version ? installation.core : previous && sourceVersion === previous.version ? previous.core : globalCore;
  // Only replace the known product source. An identically named foreign plugin
  // or user-edited definition must not be removed for convenience.
  for (const name of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/codex.json', 'scripts/context-hook.cjs']) {
    assert.equal(read(path.join(existing.source.path, name)), read(path.join(referenceCore, 'plugins/project-knowledge', name)), 'owned product definition required: ' + name);
  }
  const fingerprint = text => {
    let owned = false;
    return hash(text.split(/\r?\n/).filter(line => {
      if (/^\s*\[/.test(line)) owned = /^\s*\[(?:plugins|marketplaces)\..*project-knowledge/.test(line);
      return !owned && !/^\s*(?:"project-knowledge"|project-knowledge)\s*=/.test(line) && line.trim();
    }).map(line => line.trim()).join('\n'));
  };
  const before = fingerprint(read(config));
  const report = { schema: 'native-codex/review-preparation/v1', version: installation.version, backup, beforeVersion: existing.version,
    packageSource: installation.core, noTrustWrites: true, passed: false };
  const output = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression/codex-review-' + installation.version + '.json');
  const save = () => AtomicFile.writeJsonAtomic(output, report);
  try {
    // The operator prepares only the owned local source with apply_patch when
    // the native CLI cannot add it. This helper never edits user TOML or trust,
    // and refuses to remove a working marketplace as a preparation shortcut.
    const listing = manager.execute('codex', ['plugin', 'marketplace', 'list']);
    const row = String(listing.stdout || '').split(/\r?\n/).find(line => /^project-knowledge\s+/.test(line));
    const source = row?.replace(/^project-knowledge\s+/, '').trim();
    assert.ok(source && fs.realpathSync.native(source).toLowerCase() === fs.realpathSync.native(installation.core).toLowerCase(), 'prepare the exact local npm catalogue before updating');
    report.installation = manager.installCodex(); manager.verifyCodexInstallation();
    report.preservedUnrelatedConfiguration = fingerprint(read(config)) === before;
    assert.equal(report.preservedUnrelatedConfiguration, true, 'unrelated native configuration must remain unchanged');
    report.hook = await manager.automaticCodexContextStatus(manager.statusCodex(), path.resolve(__dirname, '../..'));
    report.passed = true; save(); console.log(JSON.stringify({ output, version: report.version, preservedUnrelatedConfiguration: true, state: report.hook.state, trustStatus: report.hook.trustStatus, noTrustWrites: true }));
  } catch (error) { report.error = error.message; save(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
