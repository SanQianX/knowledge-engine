'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBootstrapCandidate, ACTIVE_AGENT_SESSION, BOOTSTRAP_WORKBENCH } = require('./support/upgrade-user-context-product');

const receipt = () => ({
  registry: 'https://registry.npmjs.org/', integrityPassed: true, tag: 'next', version: '5.0.16-rc.1', engineVersion: '0.2.7-rc.5',
  modules: {
    terminal: { version: BOOTSTRAP_WORKBENCH, packageName: '@sanqianx/claude-ai-workbench', distIntegrity: 'sha512-t' },
    vectorHub: { version: '1.0.8-rc.4', packageName: '@sanqianx/vector-hub', distIntegrity: 'sha512-v' },
    eventBridge: { version: '0.7.2', packageName: '@sanqianx/ai-coding-event-bridge-console', distIntegrity: 'sha512-e' },
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
