'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AtomicFile = require('../../src/runtime/atomic-file');
async function main() {
  const env = JSON.parse(fs.readFileSync(process.argv[2]));
  if (path.dirname(env.root) !== path.resolve(os.tmpdir()) || !path.basename(env.root).startsWith('智脑桌面验收-')) throw new Error('OWNED_FIXTURE_REQUIRED');
  const label = process.argv[3]; if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('ARCHIVE_LABEL_REQUIRED');
  const destination = path.resolve(__dirname, '../../.agent-state/acceptance/retrieval-release', label);
  if (fs.existsSync(destination) && !process.argv.includes('--resume')) throw new Error('ARCHIVE_ALREADY_EXISTS');
  if (fs.existsSync(path.join(destination, 'archive.json'))) throw new Error('ARCHIVE_ALREADY_COMPLETE');
  const { ProfileStore } = require(path.join(env.runtimeRoots.workbench, 'packages/server/lib/profile-store'));
  const profiles = new ProfileStore({ dataDir: path.join(env.root, 'workbench') });
  const secrets = [profiles.runtimeProfile('acceptance-model').apiKey, profiles.embeddingRuntime()?.apiKey].filter(Boolean);
  const { redactValue } = require(path.join(env.runtimeRoots.shell, '_site/lib/structured-logger'));
  const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); };
  const identity = await (await fetch(new URL('/api/runtime/identity', env.url))).json();
  if (identity.pid !== env.pid) throw new Error('FIXTURE_PROCESS_MISMATCH');
  const report = { schema: 'acceptance-archive/v1', source: env.root, destination, installationSource: env.installationSource, version: identity.version, files: [] };
  for (const entry of fs.readdirSync(env.root, { withFileTypes: true })) {
    if (entry.isFile() && /^(acceptance-environment|real-.*|knowledge-surfaces.*)\.json$/.test(entry.name)) {
      AtomicFile.writeJsonAtomic(path.join(destination, entry.name), redactValue(JSON.parse(fs.readFileSync(path.join(env.root, entry.name))), { secrets })); report.files.push(entry.name);
    } else if (entry.isDirectory() && /^(native-zcode-|real-workbench-web-)/.test(entry.name)) {
      for (const name of fs.readdirSync(path.join(env.root, entry.name))) {
        const source = path.join(env.root, entry.name, name), target = path.join(destination, entry.name, name);
        if (!fs.statSync(source).isFile()) continue;
        if (/\.json$/.test(name)) AtomicFile.writeJsonAtomic(target, redactValue(JSON.parse(fs.readFileSync(source)), { secrets }));
        else if (/\.png$/.test(name)) copy(source, target); else continue;
        report.files.push(path.join(entry.name, name));
      }
    }
  }
  const copyTree = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('ARCHIVE_SYMLINK_FORBIDDEN');
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) copyTree(from, to); else if (entry.isFile()) copy(from, to);
    }
  };
  copyTree(env.knowledgeRoot, path.join(destination, 'knowledge-snapshot'));
  for (const [i, repo] of env.repositories.entries()) copyTree(repo, path.join(destination, `code-snapshot-${i}`));
  AtomicFile.writeJsonAtomic(path.join(destination, 'engine-state-snapshot.json'), redactValue(JSON.parse(fs.readFileSync(path.join(env.root, 'engine/engine-state.json'))), { secrets }));
  AtomicFile.writeJsonAtomic(path.join(destination, 'archive.json'), report);
  console.log('ACCEPTANCE_ARCHIVED ' + destination);
}
main().catch(error => { console.error(error.name, error.message); process.exitCode = 1; });
