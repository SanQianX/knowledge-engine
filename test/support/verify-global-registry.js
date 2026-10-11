'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');

function publicFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(item => {
    if (item.name === 'node_modules') return [];
    assert.equal(item.isSymbolicLink(), false, 'runtime packages must not resolve through source links');
    const file = path.join(relative, item.name);
    return item.isDirectory() ? publicFiles(root, file) : item.isFile() ? [file] : [];
  });
}
function verifyBytes(reference, installed) {
  const files = publicFiles(reference);
  for (const file of files) {
    const actual = path.join(installed, file);
    assert.ok(fs.existsSync(actual) && !fs.lstatSync(actual).isSymbolicLink(), `installed runtime file missing or linked: ${file}`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(actual)).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(path.join(reference, file))).digest('hex'), `installed bytes differ from official download: ${file}`);
  }
  return files.length;
}
async function main() {
  const [installationFile, globalCore, output] = process.argv.slice(2);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  assert.equal(installation.integrityPassed, true);
  const core = path.resolve(globalCore);
  assert.equal(JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version, installation.version);
  const productFiles = verifyBytes(installation.core, core);
  const modules = require(path.join(core, '_site/scripts/verify-product-runtime')).verifyProductRuntime(core);
  const moduleProof = {};
  for (const [key, actual] of Object.entries(modules)) {
    const official = installation.modules[key];
    assert.equal(actual.version, official.version);
    assert.ok(actual.directory.startsWith(path.resolve(core, '../../') + path.sep), 'global modules must resolve in the npm prefix, not sibling repositories');
    moduleProof[key] = { version: actual.version, directory: actual.directory, verifiedFiles: verifyBytes(official.directory, actual.directory), integrity: official.distIntegrity };
  }
  const resolver = createRequire(path.join(core, 'package.json'));
  const sdk = resolver.resolve('@anthropic-ai/claude-agent-sdk');
  assert.ok(sdk.startsWith(path.resolve(core, '../../') + path.sep));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sdk)).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(installation.sdk)).digest('hex'), 'running SDK must match the official acceptance installation');
  const result = { schema: 'project-knowledge/global-registry-bytes/v1', passed: true, version: installation.version, core, officialInstallation: installationFile, sourceCommit: installation.sourceCommit, integrity: installation.distIntegrity, verifiedProductFiles: productFiles, modules: moduleProof, sdk, checkedAt: new Date().toISOString() };
  AtomicFile.writeJsonAtomic(output, result);
  console.log(`GLOBAL_REGISTRY_BYTES_PASSED ${output}`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publicFiles, verifyBytes };
