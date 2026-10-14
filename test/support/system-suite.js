'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { assertOfficialReceipt } = require('./official-receipt');
const [label, directory, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label || '') || !directory || !['npm', 'node'].includes(command)) throw new Error('Usage: system-suite <label> <repository> npm|node <args>');
// Non-secret identity of what this run exercises: the repository's own
// package identity — the Node runtime actually executing the suite, its
// version, the source commit and the dirty state of runtime-affecting
// files — plus, when given, the official install receipt. Suite reports
// never contain credentials or configuration bodies.
const repoRoot = path.resolve(directory);
const repoPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const git = (...gitArgs) => { try { return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' }); } catch { return null; } };
const engineRepo = repoPackage.name === '@sanqianx/ai-coding-knowledge-engine';
// The engine runtime graph is exactly what npm publishes and the product
// vendoring copies — README.md, package.json, the three published ui files
// and src/** — hashed as raw bytes, the same verified byte convention as
// vendor-manifest.json. Unrelated untracked user files outside that set are
// never read as runtime identity.
const runtimeFiles = root => {
  const files = {};
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const name of ['README.md', 'package.json', 'ui/index.html', 'ui/app.js', 'ui/app.css']) if (fs.existsSync(path.join(root, name))) files[name] = hash(path.join(root, name));
  const walk = folder => { if (!fs.existsSync(folder)) return; for (const item of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, item.name); if (item.isDirectory()) walk(file); else if (item.isFile()) files[path.relative(root, file).split(path.sep).join('/')] = hash(file); } };
  walk(path.join(root, 'src'));
  return files;
};
const head = git('rev-parse', 'HEAD');
// Dirty scope follows what npm actually publishes for the package under test:
// the package.json files list plus the files npm always packs. Unrelated
// tracked user work outside the published runtime is preserved untouched and
// never counts as runtime dirt.
const statusScope = Array.isArray(repoPackage.files) && repoPackage.files.length ? [...new Set([...repoPackage.files, 'package.json', 'README.md', 'LICENSE'])] : [];
const status = git('status', '--porcelain', '--untracked-files=no', ...statusScope);
const executable = process.env.KB_TEST_NODE || process.execPath;
// The report must describe the Node runtime that actually executes the
// suite, never the harness process that launched system-suite itself.
const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
if (probe.error || probe.status !== 0 || !/^v\d+\.\d+\.\d+/.test((probe.stdout || '').trim())) throw new Error('system-suite must record the Node runtime it executes; probing ' + executable + ' failed');
const nodeVersion = probe.stdout.trim();
const sourceIdentity = {
  name: repoPackage.name || null, version: repoPackage.version || null, nodeVersion,
  commit: head === null ? null : (head.trim() || null),
  runtimeDirty: status === null ? null : status.split('\n').filter(Boolean).map(line => {
    // Porcelain v1 prefixes exactly two status columns and one space;
    // trimming the line first would eat the first character of the path.
    const raw = line.slice(3);
    return raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw;
  }),
  ...(engineRepo ? { runtimeFiles: runtimeFiles(repoRoot) } : {}),
};
let installIdentity = null;
if (process.env.KB_SUITE_INSTALL_RECEIPT) {
  const receiptFile = path.resolve(process.env.KB_SUITE_INSTALL_RECEIPT);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  // An illegal receipt is refused before any suite runs on its behalf.
  assertOfficialReceipt(receipt);
  installIdentity = { schema: receipt.schema, registry: receipt.registry, integrityPassed: receipt.integrityPassed, version: receipt.version, tag: receipt.tag, engineVersion: receipt.engineVersion, distIntegrity: receipt.distIntegrity, sourceCommit: receipt.sourceCommit, receipt: receiptFile };
}
const proof = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression'); fs.mkdirSync(proof, { recursive: true });
const stamp = Date.now(); const logfile = path.join(proof, `${label}-${stamp}.log`);
const output = fs.createWriteStream(logfile, { mode: 0o600 });
const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const argv = command === 'npm' ? [cli, ...args] : args;
const start = Date.now(); let tail = '';
const child = spawn(executable, argv, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_execpath: cli, PATH: path.dirname(executable) + path.delimiter + process.env.PATH, FORCE_COLOR: '0' } });
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output.write(bytes); tail = (tail + bytes).slice(-5000); });
child.on('error', error => { tail += error.message; });
child.on('close', (code, signal) => output.end(() => {
  const result = { label, command: [executable, ...argv], repository: repoRoot, nodeVersion, harnessNodeVersion: process.version, sourceIdentity, installIdentity, exitCode: code, signal, passed: code === 0, durationMs: Date.now() - start, logfile, tail };
  const report = path.join(proof, `${label}-${stamp}.json`); fs.writeFileSync(report, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ ...result, tail: tail.slice(-2200), report }) + '\n'); process.exitCode = code === 0 ? 0 : 1;
}));
