'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
const { latestSuite, allPassed } = require('./acceptance-progress');

function evaluateEvidence({ source, installed, user, manual, globalBytes, identity, version }) {
  const remaining = [...source, ...installed, ...user].filter(item => item.passed !== true).map(item => item.label);
  if (manual.selectionAndImport !== 'passed') remaining.push('native-folder-selection');
  if (manual.nativeCancellation !== 'passed') remaining.push('native-folder-cancellation');
  if (globalBytes.passed !== true || globalBytes.version !== version) remaining.push('global-official-package-bytes');
  if (identity.version !== version) remaining.push('actual-user-runtime-version');
  return { passed: remaining.length === 0 && allPassed(source) && allPassed(installed) && allPassed(user), remaining };
}

async function main() {
  const directory = path.resolve(__dirname, '../../.agent-state/acceptance/system-regression');
  const installationFile = path.resolve(process.argv[2]);
  const installation = JSON.parse(fs.readFileSync(installationFile));
  assert.equal(installation.schema, 'project-knowledge/installed-registry/v1');
  assert.equal(installation.integrityPassed, true);
  assert.match(installation.version, /^5\.0\.\d+$/);
  const source = ['shell', 'engine', 'workbench', 'vector', 'bridge'].flatMap(name => [24, 22].map(node => latestSuite(directory, `${name}-formal-full${node}`)));
  const installed = ['registry24', 'web24', 'web22', 'fault24', 'fault22', 'lifecycle24', 'lifecycle22', 'startup-gate24', 'startup-gate22', 'real-commits24', 'workbench24', 'live-development24', 'secondary24', 'memory24', 'four-clients24', 'external-capture24', 'embedding24', 'surfaces24', 'surfaces22'].map(label => latestSuite(directory, 'npm-formal-' + label));
  const user = ['frozen-upgrade24', 'index-root24', 'real-workbench24', 'repair-hook24', 'restart24', 'latest-install24'].map(label => latestSuite(directory, 'user-formal-' + label));
  const manual = JSON.parse(fs.readFileSync(path.join(directory, 'native-picker-user-receipt.json')));
  const globalBytesFile = path.join(directory, 'global-formal-registry-bytes.json');
  const globalBytes = fs.existsSync(globalBytesFile) ? JSON.parse(fs.readFileSync(globalBytesFile)) : { passed: false };
  const read = async route => { const response = await fetch('http://127.0.0.1:5757' + route, { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok); return response.json(); };
  const [identity, brain, projects, runs] = await Promise.all(['/api/runtime/identity', '/api/brain', '/api/projects/aggregated', '/api/engine/runs'].map(read));
  const assessment = evaluateEvidence({ source, installed, user, manual, globalBytes, identity, version: installation.version });
  const featureDefinitions = [
    ['启动与实例管理', ['启动、重复启动、status、stop/STOP、未知命令、启动失败日志', '目标实例识别、受管端口和子进程退出、四模块守护恢复'], ['lifecycle24', 'lifecycle22'], ['restart24', 'latest-install24']],
    ['项目生命周期和六页面', ['空库、双目录导入预检、重复导入、中文空格路径、部分接线重试', '领域归属、保留数据解绑/重新导入、主题、桌面布局、项目切换与刷新', '目录选择/取消由用户手工确认；其他交互自动验收'], ['web24', 'web22'], []],
    ['工作台', ['就绪门禁、新会话、模型、发送、真实流式增量与引用', '中止、权限、草稿、历史、重开、A→B→A 与迟到响应隔离'], ['startup-gate24', 'startup-gate22', 'web24', 'web22', 'workbench24'], ['real-workbench24', 'restart24']],
    ['知识维护与二次开发', ['真实 Git Hook/journal/认领/冻结证据/staging/晋升/真实向量检索', '空库首次维护、跨项目并发、同项目 FIFO、开发中提交/未提交草稿保护', '实际 search/get 在修改前执行，实际测试/提交后再次维护与检索'], ['real-commits24', 'live-development24', 'secondary24'], ['repair-hook24']],
    ['客户端与检索', ['四个实际客户端通过当前 MiniMax 配置执行知识工具', '外部原生 Claude Code（非工作台）真实 Prompt/Stop Hook 采集', '项目/领域/智脑范围及 UI、CLI、MCP 事实/引用一致，非空 1536 维真实向量'], ['four-clients24', 'external-capture24', 'embedding24', 'surfaces24', 'surfaces22'], ['index-root24']],
    ['记忆、故障与安全', ['实际维护生成有原始需求/提交证据的候选', '编辑/确认/忽略/重启落盘、未确认不注入', '超时、缺配置、非法产物、路径越界、状态损坏、索引单独重试', '本地日志/显示/导出、XSS/凭据脱敏、SSE 断线恢复与唯一订阅'], ['memory24', 'web24', 'web22', 'fault24', 'fault22'], []],
    ['npm 安装与升级', ['官方独立缓存安装、integrity/gitHead/包内模块/资源与 favicon 哈希', '实际用户知识/历史/配置冻结保存、已完成运行不重放、付费向量不重建', '知识根目录 D 盘索引，C 盘旧索引保留；日常 latest 下载/启动/重启'], ['registry24'], ['frozen-upgrade24', 'index-root24', 'restart24', 'latest-install24']],
  ];
  const features = featureDefinitions.map(([area, operations, packageLabels, userLabels]) => ({ area, operations, results: [...packageLabels.map(label => installed.find(item => item.label === 'npm-formal-' + label)), ...userLabels.map(label => user.find(item => item.label === 'user-formal-' + label))] }));
  const originalFailuresPreserved = fs.readdirSync(directory).filter(name => /^(npm-formal-|user-formal-).*\d+\.json$/.test(name)).flatMap(name => {
    const result = JSON.parse(fs.readFileSync(path.join(directory, name)));
    return result.passed === false ? [{ label: result.label, exitCode: result.exitCode, report: path.join(directory, name) }] : [];
  });
  const report = { schema: 'system-regression/formal-acceptance/v1', checkedAt: new Date().toISOString(), systemComplete: assessment.passed, status: assessment.passed ? 'accepted' : 'gates-pending', package: { version: installation.version, sourceCommit: installation.sourceCommit, integrity: installation.distIntegrity, installationFile, modules: installation.modules, engineVersion: installation.engineVersion }, source, installed, user, manual, globalBytesFile, remaining: assessment.remaining,
    features, originalFailuresPreserved,
    actualUser: { identity, projectCount: projects.projects.length, states: runs.runs.reduce((out, run) => { out[run.state] = (out[run.state] || 0) + 1; return out; }, {}), indexPath: brain.configuration.indexStorage.actualPath, indexStatus: brain.configuration.indexStorage.status },
    limits: ['Native selection/cancellation receipt is user manual confirmation, not an automated Windows UI result.', 'Four real clients use the configured MiniMax profile; no claim of four separate vendor-account authentications.', 'The first global frozen upgrade check observed a concurrent Codex configuration change and remains failed; the subsequent frozen exact-version reinstall verifies all current protected configuration bytes without concurrent client tests.', 'Historical e9f6560 raw index failure was discarded by the old version and cannot be recovered; controlled diagnostic coverage and real index-only recovery are separate evidence.', 'Acceptance proves the recorded environment and cases, not the absence of all future defects.'],
    previousEvidence: path.join(directory, 'progress-rc19-1791741071594.json') };
  const output = path.join(directory, `formal-${installation.version}-${Date.now()}.json`); AtomicFile.writeJsonAtomic(output, report);
  console.log(JSON.stringify({ output, systemComplete: report.systemComplete, remaining: report.remaining }));
  if (!report.systemComplete) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { evaluateEvidence };
