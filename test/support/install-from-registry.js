'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const registry = 'https://registry.npmjs.org/';
const packageName = '@sanqianx/project-knowledge';
const installedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-registry-product-'));
const cachePath = process.env.KB_REGISTRY_ACCEPTANCE_CACHE ? path.resolve(process.env.KB_REGISTRY_ACCEPTANCE_CACHE) : path.join(installedRoot, 'npm-cache');
AtomicFile.writeJsonAtomic(path.join(installedRoot, 'package.json'), { name: 'kb-registry-acceptance', version: '1.0.0', private: true });
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(args, preferOffline = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args, `--registry=${registry}`, '--cache', cachePath, preferOffline ? '--prefer-offline' : '--prefer-online', '--maxsockets=5'], {
    cwd: installedRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: '' },
  });
  if (result.status !== 0) throw new Error(`Registry operation failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  const expected = process.argv[2];
  assert.match(expected || '', /^\d+\.\d+\.\d+$/);
  const latest = npm(['view', packageName, 'dist-tags.latest']).trim();
  assert.equal(latest, expected, 'latest must point to the release before acceptance');
  npm(['install', '--prefix', installedRoot, '--global=false', '--save-exact', '--no-audit', '--no-fund', `${packageName}@${expected}`], true);
  const core = path.join(installedRoot, 'node_modules', '@sanqianx', 'project-knowledge');
  const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json')));
  assert.equal(pkg.version, expected);
  const lock = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package-lock.json')));
  assert.ok(Object.values(lock.packages).every(entry => !entry.link && (!entry.resolved || entry.resolved.startsWith(registry))), 'all dependencies must come from the official registry, not file/source overrides');
  const dist = JSON.parse(npm(['view', `${packageName}@${expected}`, 'dist', '--json']));
  assert.equal(lock.packages['node_modules/@sanqianx/project-knowledge'].integrity, dist.integrity);
  const modules = require(path.join(core, '_site/scripts/verify-product-runtime')).verifyProductRuntime(core);
  const check = spawnSync(process.execPath, [path.join(core, '_site/scripts/verify-module-runtime.js')], { encoding: 'utf8', windowsHide: true });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const resolve = createRequire(path.join(core, 'package.json'));
  for (const [key, module] of Object.entries(modules)) assert.ok(module.directory.startsWith(installedRoot + path.sep), `${key} must resolve inside the installation`);
  const engine = JSON.parse(fs.readFileSync(path.join(core, '_modules/knowledge-engine/package.json')));
  assert.equal(Object.keys(engine.dependencies || {}).length, 0);
  const report = {
    schema: 'project-knowledge/installed-registry/v1', registry, packageName, version: pkg.version,
    installedRoot, core, integrityPassed: true, freshCache: !process.env.KB_REGISTRY_ACCEPTANCE_CACHE, distIntegrity: dist.integrity,
    modules: Object.fromEntries(Object.entries(modules).map(([key, module]) => [key, { version: module.version, directory: module.directory }])),
    engineVersion: engine.version, sdk: resolve.resolve('@anthropic-ai/claude-agent-sdk'), checkedAt: new Date().toISOString(),
  };
  const file = path.join(installedRoot, 'registry-installation.json'); AtomicFile.writeJsonAtomic(file, report);
  process.stdout.write(`REGISTRY_INSTALLATION ${file}\n`);
  process.stdout.write(`Verified ${packageName}@${expected} and four packaged modules from npm.\n`);
} catch (error) { process.stderr.write(`REGISTRY_ACCEPTANCE_FAILED: ${error.message}\n`); process.exitCode = 1; }
