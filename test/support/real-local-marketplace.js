'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');

function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(environment.installationSource, 'project-knowledge/installed-registry/v1');
  const core = environment.runtimeRoots.shell, homeDir = path.join(environment.root, 'local-marketplace');
  const configDir = path.join(homeDir, '.claude'); fs.mkdirSync(configDir, { recursive: true });
  const { IntegrationManager } = require(path.join(core, '_site/lib/integration-installer'));
  const crossSpawn = createRequire(path.join(core, 'package.json'))('cross-spawn');
  const calls = [];
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.http://127.0.0.1:1/github-blocked/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/' };
  const manager = new IntegrationManager({ rootDir: core, homeDir, env, runner: (command, args, options) => {
    calls.push({ command, args });
    return crossSpawn.sync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } });
  const file = path.join(environment.root, 'real-local-marketplace.json');
  const report = { version: require(path.join(core, 'package.json')).version, passed: false, configuration: 'isolated CLI home; unreachable network proxy and blocked GitHub HTTPS Git transport', calls };
  try {
    const first = manager.installClaude(); assert.equal(first.state, 'installed');
    manager.verifyClaudeInstallation();
    const again = manager.installClaude(); assert.equal(again.state, 'installed');
    const add = calls.filter(c => c.args.slice(0, 3).join(' ') === 'plugin marketplace add');
    assert.equal(add.length, 1, 'idempotent repair must not duplicate the local marketplace');
    assert.equal(path.resolve(add[0].args[3]), path.resolve(core));
    const known = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins/known_marketplaces.json')));
    assert.equal(path.resolve(known['project-knowledge'].source.path), path.resolve(core));
    report.passed = true; report.localSource = core;
    AtomicFile.writeJsonAtomic(file, report); console.log('REAL_NPM_LOCAL_MARKETPLACE_PASSED ' + file);
  } catch (error) { report.failure = String(error.message).slice(0, 1000); AtomicFile.writeJsonAtomic(file, report); throw error; }
}
try { main(); } catch (error) { console.error('LOCAL_MARKETPLACE_FAILED: ' + error.message); process.exitCode = 1; }
