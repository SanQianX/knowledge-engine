'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const { latestSuite, allPassed } = require('./acceptance-progress');

async function main() {
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const [candidateFile, formalFile] = process.argv.slice(2);
  const candidate = JSON.parse(fs.readFileSync(candidateFile)), formal = JSON.parse(fs.readFileSync(formalFile));
  for (const install of [candidate, formal]) { assert.equal(install.schema, 'project-knowledge/installed-registry/v1'); assert.equal(install.integrityPassed, true); }
  assert.match(candidate.version, /^5\.0\.\d+-rc\.\d+$/); assert.match(formal.version, /^5\.0\.\d+$/);
  const manifest = install => JSON.parse(fs.readFileSync(path.join(install.core, 'module-runtime-manifest.json')));
  assert.deepEqual(manifest(candidate), manifest(formal), 'stable runtime and UI must match the accepted candidate');
  assert.deepEqual(candidate.vendorManifest, formal.vendorManifest);
  const source = ['memory-engine-final24', 'memory-engine-final22', 'memory-shell-final24', 'memory-shell-final22', 'memory-web-final24', 'memory-web-final22'].map(label => latestSuite(directory, label));
  const packageEvidence = [];
  for (const [prefix, install] of [['memory-rc' + candidate.version.split('-rc.')[1], candidate], ['memory-formal', formal]]) {
    const suites = ['registry', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'real24'].map(suffix => latestSuite(directory, prefix + '-' + suffix));
    for (const suite of suites.filter(s => s.passed && /-web\d+$|-fault\d+$/.test(s.label))) {
      const raw = JSON.parse(fs.readFileSync(suite.report));
      const match = /PRODUCT_WEB_(?:UI|FAULT)_ACCEPTANCE_PASSED (.+?) \(real/.exec(raw.tail);
      assert.ok(match, suite.label + ' needs a browser evidence report');
      const evidence = JSON.parse(fs.readFileSync(path.join(match[1], 'report.json')));
      assert.equal(evidence.passed, true); assert.equal(evidence.installationSource, install.schema);
      assert.equal(path.resolve(evidence.runtimeRoots.shell), path.resolve(install.core));
      assert.equal(path.resolve(evidence.runtimeRoots.engine), path.resolve(install.core, '_modules/knowledge-engine'));
      assert.ok(Object.values(evidence.runtimeRoots).every(root => path.resolve(root).startsWith(path.resolve(install.installedRoot) + path.sep)));
      if (evidence.installationReport) assert.equal(path.resolve(evidence.installationReport), path.resolve(install === candidate ? candidateFile : formalFile));
      suite.browserReport = path.join(match[1], 'report.json');
    }
    const realSuite = suites.find(s => s.label === prefix + '-real24');
    let real = null;
    if (realSuite.passed) {
      const raw = JSON.parse(fs.readFileSync(realSuite.report)); const file = /REAL_SCOPED_MEMORY_ACCEPTANCE_PASSED (.+)/.exec(raw.tail)?.[1]; assert.ok(file);
      real = JSON.parse(fs.readFileSync(file)); assert.equal(real.passed, true); assert.equal(real.version, install.version); assert.ok(real.cases.length >= 10 && real.cases.every(c => c.passed));
      realSuite.realReport = file;
    }
    packageEvidence.push({ version: install.version, integrity: install.distIntegrity, gitHead: install.sourceCommit, installation: install === candidate ? candidateFile : formalFile, suites, real });
  }
  const user = ['memory-user-upgrade24', 'memory-user-ui24', 'memory-user-workbench24', 'memory-user-hook24', 'memory-user-restart24', 'memory-user-latest24'].map(label => latestSuite(directory, label));
  const bytesFile = path.join(directory, 'global-memory-registry-bytes.json');
  const bytes = fs.existsSync(bytesFile) ? JSON.parse(fs.readFileSync(bytesFile)) : { passed: false };
  const response = await fetch('http://127.0.0.1:5757/api/runtime/identity'); assert.ok(response.ok); const identity = await response.json();
  const gates = [...source, ...packageEvidence.flatMap(p => p.suites), ...user];
  const remaining = gates.filter(g => !g.passed).map(g => g.label);
  if (bytes.passed !== true || bytes.version !== formal.version) remaining.push('global-official-package-bytes');
  if (identity.version !== formal.version) remaining.push('actual-runtime-version');
  const failures = fs.readdirSync(directory).filter(name => /^memory-.*\d+\.json$/.test(name)).flatMap(name => { const result = JSON.parse(fs.readFileSync(path.join(directory, name))); return result.passed === false ? [{ file: path.join(directory, name), label: result.label }] : []; });
  const report = { schema: 'scoped-memory/acceptance/v1', passed: remaining.length === 0 && allPassed(gates), version: formal.version, source, packages: packageEvidence, user, globalBytes: bytesFile, identity, remaining, originalFailuresPreserved: failures,
    coverage: ['编辑后一次确认内容、状态和范围；取消不写入', '全局、指定领域、任意已登记项目；来源证据与适用目标分离', '范围过滤先于排名，未确认、未同步或失效目标不进入任务', '当前领域归属、解绑失效、范围移动清理旧投影、同范围去重与忽略去重', '非法范围、伪造来源、磁盘写入失败、锁冲突、并发审核和损坏状态', '现有 v5 无范围字段仍为全局；不移动项目知识与历史', '真实 MiniMax 任务、提交维护候选、非空 1536 维向量、UI/CLI/MCP 引用', '真实消息流、单项目与跨项目并发维护、重启与付费索引保留'],
    limits: ['只测试正常 1920×1080 桌面视口，无 Windows 安装包。', '故障注入和确定性 UI 用受控模型，真实模型结果单列，不互相替代。', '本轮修改外壳与引擎；其余三模块保持之前已验收的精确 npm 版本。', '退回不识别范围的旧引擎时必须配合升级前备份，不能让旧版本直接解释新的专属记忆。', '验收证明记录的环境与场景，不声称不存在任何未来缺陷。'], checkedAt: new Date().toISOString() };
  const output = path.join(directory, `scoped-memory-${formal.version}-${Date.now()}.json`); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, passed: report.passed, remaining })); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
