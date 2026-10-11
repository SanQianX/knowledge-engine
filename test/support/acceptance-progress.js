'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');

function latestSuite(directory, label) {
  const file = fs.readdirSync(directory).filter(name => name.startsWith(label + '-') && /^\d+\.json$/.test(name.slice(label.length + 1))).sort().at(-1);
  if (!file) return { label, passed: false, status: 'not-run' };
  const report = JSON.parse(fs.readFileSync(path.join(directory, file)));
  assert.equal(report.label, label);
  return { label, passed: report.passed === true && report.exitCode === 0, status: report.passed === true && report.exitCode === 0 ? 'passed' : 'failed', exitCode: report.exitCode, durationMs: report.durationMs, report: path.join(directory, file) };
}
function allPassed(results) { return results.length > 0 && results.every(result => result.passed === true); }

async function main() {
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  assert.equal(installation.version, '5.0.9-rc.19');
  assert.equal(installation.integrityPassed, true);
  const source = ['shell-rc19-full24', 'shell-rc19-full22', 'engine-final-rc19-full24', 'engine-final-rc19-full22', 'workbench-startup-final24', 'workbench-startup-final22', 'vector-final24', 'vector-final22', 'bridge-final-isolated24', 'bridge-final-isolated22'].map(label => latestSuite(directory, label));
  const candidateLabels = ['registry-ready24', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'startup-gate24', 'startup-gate22', 'index-upgrade24', 'real-commits24', 'workbench24', 'live-development24', 'secondary24', 'four-clients24', 'embedding24', 'surfaces24', 'surfaces22'];
  const candidate = candidateLabels.map(label => latestSuite(directory, 'npm-rc19-' + label));
  const user = ['frozen-upgrade24', 'index-root24', 'real-workbench24', 'repair-hook24', 'restart24'].map(label => latestSuite(directory, 'user-rc19-' + label));
  const globalBytes = JSON.parse(fs.readFileSync(path.join(directory, 'global-rc19-registry-bytes.json')));
  assert.equal(globalBytes.version, installation.version);
  assert.equal(globalBytes.passed, true);
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok); return response.json(); };
  const [identity, brain, projects, runs] = await Promise.all(['/api/runtime/identity', '/api/brain', '/api/projects/aggregated', '/api/engine/runs'].map(read));
  assert.equal(identity.version, installation.version);
  const corePassed = allPassed(source) && allPassed(candidate) && allPassed(user);
  const features = [
    { area: '启动、CLI、模块生命周期', operations: ['启动/重复启动/status/stop/STOP/未知命令', '端口与子进程退出', '四模块守护重启', '损坏 CLI 发现与日志'], candidateReports: ['lifecycle24', 'lifecycle22'] },
    { area: '六页面、导入与领域', operations: ['空库首页、双目录导入与预检、归属、部分接线重试', '重复导入、中文空格路径、保留数据解绑和重新导入', '领域、设置、浅深主题和桌面嵌入布局'], candidateReports: ['web24', 'web22'] },
    { area: '工作台', operations: ['加载就绪、新会话、模型选择、发送与流式刷新', '完成、历史、草稿、切页重开、A→B→A 隔离、中止与权限', '真实回答、知识引用与持久化'], candidateReports: ['startup-gate24', 'startup-gate22', 'web24', 'web22', 'workbench24'] },
    { area: '提交维护与二次开发', operations: ['真实 Hook、分项目 journal、持久认领、冻结证据', '真实 Agent、staging、晋升、真实索引和自动前端刷新', '单项目、跨项目重叠、同项目 FIFO、开发期间提交和草稿保护', '实际检索/get → 实际小改动和测试 → 再次提交/维护/检索'], candidateReports: ['real-commits24', 'live-development24', 'secondary24'] },
    { area: '四客户端接入与检索', operations: ['Claude Code、Codex、OpenCode、ZCode 实际发现、运行、调用知识工具', '共用 MiniMax 配置运行期注入，不冒称四个独立供应商账号认证', 'UI/runtime/CLI/MCP 三范围事实与引用一致', '真实 1536 维 embo-01 向量和非空语义检索'], candidateReports: ['four-clients24', 'surfaces24', 'surfaces22', 'embedding24'] },
    { area: '记忆、故障与安全', operations: ['候选编辑/确认/忽略、证据/去重、未确认不注入、重启落盘', '超时、非法/空产物、目录越界、状态损坏、索引失败诊断和索引单独重试', '日志筛选/导出、SSE 断线快照恢复和唯一订阅、XSS/凭据不泄露'], candidateReports: ['web24', 'web22', 'fault24', 'fault22'], inheritedRealEvidence: 'Earlier real preference candidates retained in the unchanged engine runtime; current package repeats controlled memory operations.' },
    { area: 'npm 与原有 v5 升级', operations: ['独立官方缓存、integrity/gitHead/版本及静态资源哈希', '全局包逐字节与官方下载安装比较，不依赖兄弟源码', '冻结后知识/历史/配置哈希及分析 ID、晋升时间、索引次数不变', '索引跟随 D 盘知识根目录、C 盘旧索引保留', '实际修复提交与重启后的知识可检索'], candidateReports: ['registry-ready24', 'index-upgrade24'], userReports: user }
  ];
  for (const feature of features) feature.results = feature.candidateReports.map(label => candidate.find(result => result.label === 'npm-rc19-' + label));
  const report = {
    schema: 'system-regression/progress/v2', status: corePassed ? 'candidate-core-passed-final-gates-pending' : 'in-progress', checkedAt: new Date().toISOString(), systemComplete: false,
    package: { version: installation.version, tag: installation.tag, sourceCommit: installation.sourceCommit, integrity: installation.distIntegrity, installationFile, globalBytesReport: path.join(directory, 'global-rc19-registry-bytes.json') },
    source, candidate, user, features,
    actualUser: { identity, projectCount: projects.projects.length, states: runs.runs.reduce((result, run) => { result[run.state] = (result[run.state] || 0) + 1; return result; }, {}), actualIndexPath: brain.configuration.indexStorage.actualPath, indexStatus: brain.configuration.indexStorage.status },
    remaining: [...[...source, ...candidate, ...user].filter(result => !result.passed).map(result => result.label), 'Native Windows folder-dialog selection and cancellation: Computer Use stopped because it could not confidently identify the browser URL; no alternate native automation was used.', 'Formal 5.0.9 package download, installed regression, real closed loops and latest promotion'],
    notClaimed: ['Native folder-dialog UI acceptance', 'Formal package acceptance or stable latest update', 'No possible future bugs', 'Historical e9f6560 raw failure cause: old code discarded it; index-only recovery succeeded without reanalysis'],
    originalFailuresPreserved: ['npm-rc18-workbench24-1791738736439.json', 'npm-rc18-workbench-ready-retest24-1791739216524.json', 'npm-rc18-surfaces24-1791738566496.json', 'npm-rc18-lifecycle22-1791738443376.json', 'npm-rc19-registry24-1791739600611.json']
  };
  const output = path.join(directory, `progress-rc19-${Date.now()}.json`);
  AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, status: report.status, sourcePassed: allPassed(source), candidatePassed: allPassed(candidate), userPassed: allPassed(user), remaining: report.remaining }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { latestSuite, allPassed };
