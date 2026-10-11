'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const fingerprint = directory => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  assert.equal(entry.isSymbolicLink(), false);
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? Object.entries(fingerprint(file)).map(([name, hash]) => [entry.name + '/' + name, hash]) : [[entry.name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
}));

async function main() {
  const [mode, environmentFile, reportFile] = process.argv.slice(2);
  assert.ok(['record', 'verify'].includes(mode));
  const environment = JSON.parse(fs.readFileSync(path.resolve(environmentFile)));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  const read = async route => {
    const response = await fetch(new URL(route, environment.url), { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, route); return response.json();
  };
  const brain = await read('/api/brain');
  const settings = (await read('/api/vectorhub/settings')).settings;
  const rebuild = await read('/api/vectorhub/rebuild/status');
  assert.equal(rebuild.running, false);
  assert.deepEqual(rebuild.errors, []);
  assert.equal(settings.rootPath, path.join(brain.knowledgeRoot, '.indexes'));
  assert.equal(brain.configuration.indexStorage.status, 'ready');
  const runs = (await read('/api/engine/runs')).runs;
  assert.ok(runs.every(run => !['queued', 'running'].includes(run.state)), 'freeze only an idle fixture');
  const current = { pid: environment.pid, root: environment.root, indexRoot: settings.rootPath, files: fingerprint(settings.rootPath), installationReport: environment.installationReport, at: new Date().toISOString() };
  if (mode === 'record') {
    assert.equal(fs.existsSync(reportFile), false, 'do not overwrite a prior restart record');
    AtomicFile.writeJsonAtomic(reportFile, { before: current, passed: false });
  } else {
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.notEqual(current.pid, report.before.pid);
    if (process.argv.includes('--upgrade')) {
      const previous = JSON.parse(fs.readFileSync(report.before.installationReport));
      const next = JSON.parse(fs.readFileSync(current.installationReport));
      assert.ok(previous.integrityPassed && next.integrityPassed && next.schema === 'project-knowledge/installed-registry/v1');
      assert.notEqual(next.version, previous.version, 'an upgrade receipt requires distinct official package versions');
      assert.equal(next.engineVersion, previous.engineVersion, 'this no-rebuild upgrade check requires the same source-policy runtime');
      for (const key of Object.keys(previous.modules)) assert.equal(next.modules[key].version, previous.modules[key].version);
      report.upgrade = { before: previous.version, after: next.version, verifiedRegistryBytes: true };
    } else assert.equal(current.installationReport, report.before.installationReport);
    assert.equal(current.root, report.before.root);
    assert.equal(current.indexRoot, report.before.indexRoot);
    assert.deepEqual(current.files, report.before.files, 'restart must not rewrite or regenerate real vectors');
    assert.equal(rebuild.total, 0, 'ordinary restart must not initiate a whole-index paid rebuild');
    Object.assign(report, { after: current, passed: true, rebuild });
    const outputFile = process.argv.includes('--upgrade') ? path.join(path.dirname(reportFile), `${path.basename(reportFile, '.json')}-upgrade-${Date.now()}.json`) : reportFile;
    AtomicFile.writeJsonAtomic(outputFile, report);
    if (outputFile !== reportFile) console.log(`REAL_INDEX_UPGRADE_EVIDENCE ${outputFile}`);
  }
  console.log(`REAL_INDEX_RESTART_${mode.toUpperCase()} ${reportFile}`);
}
main().catch(error => { console.error(`${error.code || 'RESTART_ACCEPTANCE_FAILED'}: ${error.message}`); process.exitCode = 1; });
