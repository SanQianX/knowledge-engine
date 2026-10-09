'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const report = JSON.parse(fs.readFileSync(process.argv[2]));
if (path.dirname(report.installedRoot) !== path.resolve(os.tmpdir()) || !path.basename(report.installedRoot).startsWith('kb-installed-product-') || !report.integrityPassed) throw new Error('ISOLATED_INSTALLATION_REQUIRED');
const root = path.join(report.installedRoot, 'acceptance-data');
const fixtures = ['安装项目 A', '安装项目 B'].map(name => {
  const codePath = path.join(root, 'code', name), knowledgePath = path.join(root, 'knowledge', name);
  fs.mkdirSync(codePath, { recursive: true });
  if (!fs.existsSync(path.join(codePath, '.git'))) {
    const git = args => execFileSync('git', args, { cwd: codePath, windowsHide: true, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'acceptance@local.invalid']); git(['config', 'user.name', 'Acceptance']);
    AtomicFile.writeFileAtomic(path.join(codePath, 'README.md'), `# ${name}\n\n安装候选的真实 Git 验收仓库，不是演示项目。\n`);
    git(['add', '.']); git(['commit', '-qm', 'acceptance baseline']);
  }
  return { name, codePath, knowledgePath };
});
AtomicFile.writeJsonAtomic(path.join(root, 'ui-input-fixtures.json'), { root, fixtures });
process.stdout.write(JSON.stringify({ root, fixtures }) + '\n');
