'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { localHealthSnapshot } = require('./local-health-snapshot');

async function main() {
  const output = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || fs.existsSync(output)) throw new Error('A new explicit backup directory is required');
  fs.mkdirSync(output, { recursive: true });
  if (process.platform === 'win32') execFileSync('icacls', [output, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  const data = path.join(os.homedir(), '.project-knowledge-v5');
  const packageRoot = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const { KnowledgeToolRuntime } = require(path.join(packageRoot, '_site/lib/knowledge-tool-runtime'));
  const lookup = new KnowledgeToolRuntime({ dataDir: data });
  const report = { startedAt: new Date().toISOString(), node: process.version, installedVersion: require(path.join(packageRoot, 'package.json')).version, dataDir: data, repositories: [], knowledgeLookups: [], backupFiles: [] };
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function copyTree(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Backup refuses symbolic links');
      const from = path.join(source, item.name), to = path.join(destination, item.name);
      if (item.isDirectory()) copyTree(from, to);
      else { fs.copyFileSync(from, to); report.backupFiles.push({ source: from, destination: path.relative(output, to), sha256: hash(to) }); }
    }
  }
  let stage = 'health-before';
  try {
    const before = await localHealthSnapshot('http://127.0.0.1:5757/api/engine/health');
    if (before.counts.running) throw new Error('Wait for running maintenance before taking a backup');
    const family = path.resolve(__dirname, '../../..');
    for (const name of ['project-knowledge-base', 'knowledge-engine', 'claude-ai-workbench', 'vector-hub', 'ai-coding-event-bridge']) {
      stage = `repository:${name}`;
      const root = path.join(family, name);
      const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
      report.repositories.push({ name, root, head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), status: git(['status', '--porcelain']), dirtyTrackedFiles: git(['diff', '--name-only']).split('\n').filter(Boolean).map(file => ({ file, sha256: hash(path.join(root, file)) })) });
      const project = lookup.resolveProject({ repoPath: root });
      stage = `knowledge-search:${name}`;
      const result = await lookup.search({ projectId: project.projectId, query: name === 'project-knowledge-base' ? 'folded K favicon' : '索引 失败 日志', limit: 5 });
      report.knowledgeLookups.push({ repository: name, projectId: project.projectId, query: result.query, backend: result.backend, results: result.results.map(row => ({ path: row.entry_id, commitSha: row.commitSha, title: row.title })) });
      stage = `knowledge-copy:${name}`;
      copyTree(project.knowledgePath, path.join(output, 'knowledge', name));
    }
    stage = 'v5-data-copy';
    copyTree(data, path.join(output, 'v5-data'));
    stage = 'health-after';
    const after = await localHealthSnapshot('http://127.0.0.1:5757/api/engine/health');
    report.maintenanceIdleBeforeAndAfter = before.counts.running === 0 && after.counts.running === 0;
    if (!report.maintenanceIdleBeforeAndAfter) throw new Error('Maintenance started during the backup; take a fresh idle snapshot');
    report.backupKind = 'live file snapshot; atomic state files copied, no service stop or data reset';
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'baseline.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ baseline: path.join(output, 'baseline.json'), repositories: report.repositories.map(r => ({ name: r.name, head: r.head, dirty: !!r.status })), installedVersion: report.installedVersion, backedUpFiles: report.backupFiles.length, maintenanceIdle: report.maintenanceIdleBeforeAndAfter }) + '\n');
  } catch (error) {
    const failure = { stage, code: error.code || '', message: error.message, cause: error.cause?.code || '', copiedFiles: report.backupFiles.length };
    fs.writeFileSync(path.join(output, 'backup-failed.json'), JSON.stringify(failure, null, 2));
    throw new Error(`${stage}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
  } finally { await lookup.close(); }
}
main().catch(error => { process.stderr.write(`${error.code || 'BASELINE_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
