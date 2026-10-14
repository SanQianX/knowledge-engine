'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBootstrapCandidate, parseExpectedVersions, ACTIVE_AGENT_SESSION, BOOTSTRAP_WORKBENCH } = require('./support/upgrade-user-context-product');

const INTEGRITY = 'sha512-' + 'K'.repeat(86) + '==';
const receipt = () => ({
  schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next', version: '5.0.16-rc.1', engineVersion: '0.2.7-rc.5',
  distIntegrity: INTEGRITY, sourceCommit: 'a'.repeat(40),
  modules: {
    terminal: { version: BOOTSTRAP_WORKBENCH, packageName: '@sanqianx/claude-ai-workbench', distIntegrity: INTEGRITY, sourceCommit: 'c'.repeat(40) },
    vectorHub: { version: '1.0.8-rc.4', packageName: '@sanqianx/vector-hub', distIntegrity: INTEGRITY, sourceCommit: 'd'.repeat(40) },
    eventBridge: { version: '0.7.2', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: INTEGRITY, sourceCommit: 'b'.repeat(40) },
  },
});

test('bootstrap accepts a verified next-tagged 5.0.16-rc candidate pinning four modules and the new workbench', () => {
  assert.equal(assertBootstrapCandidate(receipt()), true);
});

test('bootstrap rejects stable, latest-tagged, off-registry or workbench-mismatched receipts', () => {
  for (const mutate of [
    r => { r.version = '5.0.16'; },
    r => { r.version = '5.0.15'; },
    r => { r.tag = 'latest'; },
    r => { r.integrityPassed = false; },
    r => { r.registry = 'https://mirror.example.com/'; },
    r => { delete r.engineVersion; },
    r => { delete r.modules.vectorHub; },
    r => { delete r.modules.terminal.distIntegrity; },
    r => { r.modules.terminal.version = '0.13.2-rc.9'; },
    r => { r.engineVersion = '0.2.7-rc.4'; },
    r => { r.modules.vectorHub.packageName = '@sanqianx/other-hub'; },
  ]) {
    const candidate = receipt();
    mutate(candidate);
    assert.throws(() => assertBootstrapCandidate(candidate), 'candidate receipt must be rejected');
  }
});

test('agent sessions in thinking or pending-permission count as active and block an upgrade', () => {
  assert.ok(ACTIVE_AGENT_SESSION.includes('thinking') && ACTIVE_AGENT_SESSION.includes('pending-permission'));
  for (const state of ACTIVE_AGENT_SESSION) assert.ok(typeof state === 'string' && state.length > 0);
});
const nextCandidate = over => ({
  schema: 'project-knowledge/installed-registry/v1', registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next',
  version: '5.0.16-rc.2', distIntegrity: INTEGRITY, sourceCommit: 'a'.repeat(40), engineVersion: '0.2.7-rc.6',
  modules: {
    terminal: { version: '0.13.2-rc.11', packageName: '@sanqianx/claude-ai-workbench', distIntegrity: INTEGRITY, sourceCommit: 'c'.repeat(40) },
    vectorHub: { version: '1.0.8-rc.5', packageName: '@sanqianx/vector-hub', distIntegrity: INTEGRITY, sourceCommit: 'd'.repeat(40) },
    eventBridge: { version: '0.7.3', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: INTEGRITY, sourceCommit: 'b'.repeat(40) },
  },
  ...over,
});

test('bootstrap accepts the next repair candidate only through explicit exact expectations checked against the official receipt', () => {
  assert.equal(assertBootstrapCandidate(nextCandidate(), { engine: '0.2.7-rc.6', workbench: '0.13.2-rc.11', vectorhub: '1.0.8-rc.5', eventbridge: '0.7.3', version: '5.0.16-rc.2' }), true);
});

test('explicit expectations must be exact published versions, never ranges or tags', () => {
  assert.deepEqual(parseExpectedVersions(['receipt.json', '--bootstrap-candidate', '--expect-engine=0.2.7-rc.6', '--expect-workbench=0.13.2-rc.11']),
    { engine: '0.2.7-rc.6', workbench: '0.13.2-rc.11' });
  assert.equal(parseExpectedVersions(['receipt.json', '--bootstrap-candidate']), null);
  for (const bad of ['^0.2.7-rc.6', '>=1.0.0', '1.x', '0.13.2-rc.x', 'latest', 'next', '*', '', ' 0.13.2-rc.11', '0.13.2-rc.'])
    assert.throws(() => parseExpectedVersions(['--expect-workbench=' + bad]), /exact published version/);
});

test('explicit expectations reject every receipt that does not pin the expected modules exactly', () => {
  const expected = { engine: '0.2.7-rc.6', workbench: '0.13.2-rc.11', vectorhub: '1.0.8-rc.5', eventbridge: '0.7.3', version: '5.0.16-rc.2' };
  for (const mutate of [
    r => { r.modules.terminal.version = BOOTSTRAP_WORKBENCH; },
    r => { r.engineVersion = '0.2.7-rc.5'; },
    r => { r.modules.vectorHub.version = '1.0.8-rc.4'; },
    r => { r.modules.eventBridge.version = '0.7.2'; },
    r => { r.version = '5.0.16-rc.1'; },
    r => { r.tag = 'latest'; },
    r => { r.integrityPassed = false; },
  ]) {
    const candidate = nextCandidate(); mutate(candidate);
    assert.throws(() => assertBootstrapCandidate(candidate, expected), 'candidate must be rejected against explicit expectations');
  }
});

test('bootstrap receipts must be official registry downloads with real npm integrity digests', () => {
  const expected = { engine: '0.2.7-rc.6', workbench: '0.13.2-rc.11' };
  for (const mutate of [
    r => { delete r.schema; },
    r => { r.schema = 'handwritten/receipt/v9'; },
    r => { delete r.distIntegrity; },
    r => { r.distIntegrity = 'sha512-short'; },
    r => { r.modules.terminal.distIntegrity = 'md5-abc'; },
    r => { delete r.modules.vectorHub.distIntegrity; },
    r => { delete r.modules.eventBridge.sourceCommit; },
    r => { delete r.sourceCommit; },
    r => { r.sourceCommit = '0'.repeat(40); },
    r => { r.modules.terminal.sourceCommit = 'short'; },
  ]) {
    const candidate = nextCandidate(); mutate(candidate);
    assert.throws(() => assertBootstrapCandidate(candidate, expected), 'receipt must be rejected as not an official verified download');
  }
});
