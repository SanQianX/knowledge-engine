'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const support = require('./support/verify-native-mcp');

const BOOTSTRAP = 'const fs=require("fs");launcher-body';
const nodeLocalManifest = { type: 'stdio', command: 'node', args: ['-e', BOOTSTRAP], env: { KB_PLUGIN_VERSION: '5.0.16-rc.1', KB_EXTRA: '1' } };
const officialSameVersion = { type: 'stdio', command: 'node', args: ['-e', BOOTSTRAP], env: { KB_EXTRA: '1', KB_PLUGIN_VERSION: '5.0.16-rc.1' } };
const originalNpxManifest = version => ({ type: 'stdio', command: 'npx', args: ['-y', '--package', '@sanqianx/project-knowledge@' + version, 'project-knowledge-mcp'] });

test('contract boundary follows semver, not string order', () => {
  assert.equal(support.NODE_LOCAL_FLOOR, '5.0.16-rc.1');
  assert.equal(support.classifyContract('5.0.9'), 'legacy-npx');
  assert.equal(support.classifyContract('5.0.15'), 'legacy-npx');
  assert.equal(support.classifyContract('5.0.15-rc.3'), 'legacy-npx');
  assert.equal(support.classifyContract('5.0.16-rc.0'), 'legacy-npx');
  assert.equal(support.classifyContract('5.0.16-rc.1'), 'node-local');
  assert.equal(support.classifyContract('5.0.16'), 'node-local');
  assert.equal(support.classifyContract('5.0.17-beta.1'), 'node-local');
  assert.equal(support.classifyContract('6.0.0'), 'node-local');
  assert.equal(support.semverCompare('5.0.16-rc.1', '5.0.16'), -1);
  assert.equal(support.semverCompare('5.0.16-rc.1', '5.0.16-rc.2'), -1);
  assert.equal(support.semverCompare('5.0.16', '5.0.15'), 1);
  assert.equal(support.semverCompare('5.0.15', '5.0.15'), 0);
});

test('manifest path is keyed by the installed version inside the codex plugin cache', () => {
  assert.equal(support.pluginManifestPath('H', '5.0.16-rc.1'), path.join('H', '.codex', 'plugins', 'cache', 'project-knowledge', 'project-knowledge', '5.0.16-rc.1', '.mcp.json'));
});

test('node-local era manifests must keep the declared local node launcher', () => {
  assert.deepEqual(support.validateManifest(nodeLocalManifest, '5.0.16-rc.1'), { ok: true, contract: 'node-local' });
  assert.equal(support.validateManifest({ ...nodeLocalManifest, command: 'npx' }, '5.0.16-rc.1').code, 'NODE_LOCAL_COMMAND_EXPECTED');
  assert.equal(support.validateManifest(originalNpxManifest('5.0.16-rc.1'), '5.0.16-rc.1').code, 'NODE_LOCAL_COMMAND_EXPECTED');
  assert.equal(support.validateManifest({ ...nodeLocalManifest, args: ['C:/bin/project-knowledge-mcp.exe'] }, '5.0.16-rc.1').code, 'NODE_LOCAL_ARGS_INVALID');
  assert.equal(support.validateManifest({ ...nodeLocalManifest, args: ['-e', ''] }, '5.0.16-rc.1').code, 'NODE_LOCAL_ARGS_INVALID');
  assert.equal(support.validateManifest(null, '5.0.16-rc.1').code, 'MANIFEST_INVALID');
});

test('legacy npx support stays limited to the explicit original manifest', () => {
  assert.deepEqual(support.validateManifest(originalNpxManifest('5.0.15'), '5.0.15'), { ok: true, contract: 'legacy-npx' });
  assert.equal(support.validateManifest(originalNpxManifest('5.0.14'), '5.0.15').code, 'LEGACY_MANIFEST_NOT_ORIGINAL');
  assert.equal(support.validateManifest({ ...originalNpxManifest('5.0.15'), command: 'node' }, '5.0.15').code, 'LEGACY_NPX_COMMAND_EXPECTED');
  assert.equal(support.validateManifest({ ...originalNpxManifest('5.0.15'), args: ['-y', '--package', '@sanqianx/other@5.0.15', 'project-knowledge-mcp'] }, '5.0.15').code, 'LEGACY_MANIFEST_NOT_ORIGINAL');
});

test('execution is gated on semantic equality with the official same-version manifest', () => {
  // env key order must not matter
  assert.equal(support.compareDefinitions(nodeLocalManifest, officialSameVersion).equal, true);
  // any non-empty -e body is not enough: a different bootstrap fails
  const tampered = support.compareDefinitions({ ...nodeLocalManifest, args: ['-e', 'process.exit(0)'] }, officialSameVersion);
  assert.equal(tampered.equal, false);
  assert.equal(tampered.argsEqual, false);
  assert.equal(support.compareDefinitions({ ...nodeLocalManifest, command: 'npx' }, officialSameVersion).commandEqual, false);
  const envDrift = support.compareDefinitions({ ...nodeLocalManifest, env: { ...nodeLocalManifest.env, KB_PLUGIN_VERSION: '5.0.16-rc.2' } }, officialSameVersion);
  assert.equal(envDrift.equal, false);
  assert.equal(envDrift.envEqual, false);
  const extraOfficial = support.compareDefinitions(nodeLocalManifest, { ...officialSameVersion, env: { ...officialSameVersion.env, KB_EXTRA_OFFICIAL: '1' } });
  assert.deepEqual(extraOfficial.envOnlyInOfficial, ['KB_EXTRA_OFFICIAL']);
  assert.equal(extraOfficial.equal, false);
  assert.equal(support.compareDefinitions(null, officialSameVersion).equal, false);
});

test('child env preserves real wiring verbatim; only declared env merges on top', () => {
  const real = {
    PATH: 'C:/windows-system32',
    KB_DATA_DIR: 'D:/real-data-root',
    KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:5757',
    PLUGIN_ROOT: 'D:/real-plugin-root',
    CLAUDE_PLUGIN_ROOT: 'D:/real-plugin-root',
    KB_PLUGIN_VERSION: 'stale-from-shell',
    UNRELATED_USER_VAR: 'kept-as-is'
  };
  const env = support.buildChildEnv(real, { KB_PLUGIN_VERSION: '5.0.16-rc.1' });
  assert.equal(env.KB_DATA_DIR, 'D:/real-data-root');
  assert.equal(env.KB_KNOWLEDGE_ENGINE_URL, 'http://127.0.0.1:5757');
  assert.equal(env.PLUGIN_ROOT, 'D:/real-plugin-root');
  assert.equal(env.CLAUDE_PLUGIN_ROOT, 'D:/real-plugin-root');
  assert.equal(env.UNRELATED_USER_VAR, 'kept-as-is');
  assert.equal(env.PATH, 'C:/windows-system32');
  assert.equal(env.KB_PLUGIN_VERSION, '5.0.16-rc.1');
  assert.equal(Object.keys(env).length, Object.keys(real).length);
});

test('search keeps the strict index health gate and current-hit requirement', () => {
  const hit = { entry_id: 'changes/abc.md', commitSha: 'abc123' };
  assert.equal(support.searchGate({ health: { index: 'ok' }, results: [hit] }).ok, true);
  assert.equal(support.searchGate({ health: { index: 'degraded' }, results: [hit] }).code, 'HEALTH_NOT_OK');
  assert.equal(support.searchGate({ health: { index: 'partial' }, results: [hit] }).code, 'HEALTH_NOT_OK');
  assert.equal(support.searchGate({ health: { index: 'ok' }, results: [] }).code, 'SEARCH_NO_CURRENT_RESULT');
  assert.equal(support.searchGate({ health: { index: 'ok' }, results: [{ entry_id: 'x' }] }).code, 'SEARCH_NO_CURRENT_RESULT');
});

test('get verification checks identity metadata, not full sha text inclusion', () => {
  const hit = { entry_id: 'changes/abc123def.md', commitSha: 'abc123def456', space_id: 'project:p1' };
  const legal = { entryId: 'changes/abc123def.md', projectId: 'p1', chunks: [{ chunk_text: '# Title. Legal body never quotes the commit sha.', entry_id: 'changes/abc123def.md', space_id: 'project:p1' }] };
  assert.equal(support.getReferenceGate(legal, hit, 'p1').ok, true);
  const bs = String.fromCharCode(92);
  assert.equal(support.getReferenceGate({ ...legal, entryId: 'changes' + bs + 'abc123def.md' }, hit, 'p1').ok, true);
  assert.equal(support.getReferenceGate({ ...legal, entryId: 'changes/other.md' }, hit, 'p1').code, 'GET_REFERENCE_MISMATCH');
  assert.equal(support.getReferenceGate({ ...legal, projectId: 'p2' }, hit, 'p1').code, 'GET_REFERENCE_MISMATCH');
  assert.equal(support.getReferenceGate({ ...legal, chunks: [{ ...legal.chunks[0], entry_id: 'changes/other.md' }] }, hit, 'p1').code, 'GET_REFERENCE_MISMATCH');
  assert.equal(support.getReferenceGate({ ...legal, chunks: [{ ...legal.chunks[0], space_id: 'project:p2' }] }, hit, 'p1').code, 'GET_REFERENCE_MISMATCH');
  assert.equal(support.getReferenceGate({ ...legal, chunks: [] }, hit, 'p1').code, 'GET_REFERENCE_MISMATCH');
});

test('failures expose only known codes - no raw message or raw code echo', () => {
  assert.deepEqual(support.failureFromError(Object.assign(new Error('boom'), { code: 'CONNECT_TIMEOUT' })), { code: 'CONNECT_TIMEOUT' });
  const secret = 'SYNTHETIC-SECRET-DO-NOT-PRINT';
  const unexpected = support.failureFromError(Object.assign(new Error('token=' + secret + ' path=C:/x'), { code: 'ENOENT' }));
  assert.deepEqual(unexpected, { code: 'UNEXPECTED' });
  assert.ok(!JSON.stringify(unexpected).includes(secret));
  assert.ok(!JSON.stringify(unexpected).includes('ENOENT'));
  assert.equal(support.failureFromError(new Error('plain message')).code, 'UNEXPECTED');
  assert.ok(support.KNOWN_FAILURE_CODES.includes('UNEXPECTED'));
});

test('--query selects Leader-specified knowledge; anything else is a usage failure', () => {
  assert.deepEqual(support.parseArgs([]), { query: null });
  assert.deepEqual(support.parseArgs(['--query', 'exportRecords contract']), { query: 'exportRecords contract' });
  assert.throws(() => support.parseArgs(['--fresh']), error => error.code === 'USAGE');
  assert.throws(() => support.parseArgs(['--query']), error => error.code === 'USAGE');
});

test('launch reproduces manifest values verbatim and never swaps in a replacement binary', () => {
  const manifest = { command: 'node', args: ['-e', 'bootstrap'] };
  const runtime = { execPath: 'C:/node.exe', npmCli: 'C:/npm-cli.js' };
  assert.deepEqual(support.buildLaunch(manifest, 'node-local', runtime), { command: 'node', args: ['-e', 'bootstrap'] });
  const copied = support.buildLaunch(manifest, 'node-local', runtime);
  assert.notEqual(copied.args, manifest.args);
  const legacy = support.buildLaunch(originalNpxManifest('5.0.15'), 'legacy-npx', runtime);
  assert.equal(legacy.command, 'C:/node.exe');
  assert.deepEqual(legacy.args, ['C:/npm-cli.js', 'exec', '-y', '--package', '@sanqianx/project-knowledge@5.0.15', 'project-knowledge-mcp']);
});
