'use strict';
// Isolated desktop acceptance environment. Git, services, hooks, promotion and
// indexes are real; ONLY Agent replies and embeddings are controlled doubles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');
const { protectRealFixtureRoot } = require('./protect-fixture-credentials');
const family = path.resolve(__dirname, '../../..');
const installation = process.env.KB_PRODUCT_INSTALLATION_REPORT ? JSON.parse(fs.readFileSync(process.env.KB_PRODUCT_INSTALLATION_REPORT)) : null;
if (installation && (!installation.integrityPassed || installation.schema !== 'project-knowledge/installed-registry/v1')) throw new Error('Verified registry installation required');
const shellPackage = installation?.core || path.join(family, 'project-knowledge-base');
const installedResolve = installation ? createRequire(path.join(shellPackage, 'package.json')) : null;
const modulePackage = (name, source) => installedResolve ? path.dirname(installedResolve.resolve(`${name}/package.json`)) : path.join(family, source);
const bridgePackage = modulePackage('@sanqianx/ai-coding-event-bridge-console', 'ai-coding-event-bridge/packages/console');
const workbenchPackage = modulePackage('claude-ai-workbench', 'claude-ai-workbench');
const vectorPackage = modulePackage('@sanqianx/vector-hub', 'vector-hub');
const { createEngineServer } = require(installation ? path.join(shellPackage, '_modules/knowledge-engine/src/server') : '../../src/server');
const { createConsoleServer } = require(path.join(bridgePackage, 'src/server'));
const { BridgeAdapter } = require(path.join(shellPackage, '_site/lib/bridge-adapter'));
const { ModuleBridge } = require(path.join(shellPackage, '_site/lib/module-bridge'));
const { createRuntime, startServer } = require(path.join(shellPackage, '_site/lib/server-app'));
const { Logger } = require(path.join(shellPackage, '_site/lib/structured-logger'));
const { StorageLayout } = require(path.join(shellPackage, '_site/lib/storage-layout'));
const { createWorkbenchServer } = require(path.join(workbenchPackage, 'packages/server'));
const { ProfileStore } = require(path.join(workbenchPackage, 'packages/server/lib/profile-store'));
const { createFakeRunner } = require(path.join(family, 'claude-ai-workbench', 'tests/helpers/fake-runner'));
const { HubManager } = require(path.join(vectorPackage, 'dist/cjs/server/manager'));
const { createServer } = require(path.join(vectorPackage, 'dist/cjs/server/server'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = server => `http://127.0.0.1:${server.address().port}`;

async function main() {
  const realProfile = process.env.KB_ACCEPTANCE_REAL_PROFILE_ID ? new ProfileStore({ dataDir: process.env.KB_REAL_PROFILE_DATA_DIR || path.join(os.homedir(), '.agent-terminal') }).runtimeProfile(process.env.KB_ACCEPTANCE_REAL_PROFILE_ID) : null;
  const realEmbeddingSettings = process.env.KB_ACCEPTANCE_REAL_EMBEDDING === '1'
    ? process.env.KB_REAL_PROFILE_DATA_DIR
      ? new ProfileStore({ dataDir: process.env.KB_REAL_PROFILE_DATA_DIR }).embeddingRuntime()
      : JSON.parse(fs.readFileSync(process.env.KB_REAL_VECTOR_CONFIG || path.join(os.homedir(), '.vector-hub', 'config.json'), 'utf8')).settings
    : null;
  if (realEmbeddingSettings && (!realEmbeddingSettings.apiKey || !['minimax', 'openai'].includes(realEmbeddingSettings.provider))) throw new Error('REAL_EMBEDDING_CONFIGURATION_REQUIRED');
  if (realProfile) process.env.NODE_PATH = installation ? [path.join(shellPackage, 'node_modules'), path.join(installation.installedRoot, 'node_modules')].join(path.delimiter) : [path.join(family, 'claude-ai-workbench', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const root = process.env.KB_PRODUCT_TEST_ROOT ? path.resolve(process.env.KB_PRODUCT_TEST_ROOT) : fs.mkdtempSync(path.join(os.tmpdir(), '智脑桌面验收-'));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('智脑桌面验收-')) throw new Error('Acceptance root must be its own temporary directory');
  // Real credentials are persisted inside this root (agent apiKey via
  // setCredential, embedding secret via setEmbeddingConfig). Restrict it to
  // the current user + SYSTEM before the first real credential write and
  // abort startup when protection fails; the fake path never pays for ACLs.
  if (realProfile || realEmbeddingSettings) protectRealFixtureRoot(root, { parent: os.tmpdir(), prefix: '智脑桌面验收-' });
  // Real tests must not silently inherit unrelated user plugins or their memories.
  if (realProfile && process.env.KB_ACCEPTANCE_USER_AGENT_CONFIG !== '1') process.env.CLAUDE_CONFIG_DIR = path.join(root, 'agent-config');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.KB_MODULES_AUTOSTART = '0'; process.env.KB_MODULES_REGISTER = '1';
  process.env.KB_DATA_DIR = path.join(root, 'shell');
  const productLogger = new Logger({ layout: new StorageLayout({ dataDir: process.env.KB_DATA_DIR }) });
  process.env.AI_CODING_EVENT_BRIDGE_HOME = path.join(root, 'events');
  process.env.AI_CODING_EVENT_BRIDGE_MODULE = path.join(bridgePackage, 'src/bridge');
  const repositories = [];
  for (const name of ['测试项目 A', '测试项目 B']) {
    const repoPath = path.join(root, name); fs.mkdirSync(repoPath, { recursive: true });
    const git = args => execFileSync('git', args, { cwd: repoPath, windowsHide: true, stdio: 'pipe' });
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      git(['init', '-q']); git(['config', 'user.email', 'acceptance@local.invalid']); git(['config', 'user.name', 'Product Acceptance']);
      AtomicFile.writeFileAtomic(path.join(repoPath, 'README.md'), `# ${name}\n\n基线代码。\n`); git(['add', '.']); git(['commit', '-qm', 'baseline']);
    }
    repositories.push(repoPath);
  }
  const events = http.createServer(createConsoleServer({ home: process.env.AI_CODING_EVENT_BRIDGE_HOME, runtimeToken: token })); await listen(events);
  const faultScenarios = !realProfile && process.env.KB_ACCEPTANCE_FAULT_SCENARIOS === '1';
  const observations = { attempts: {}, syncFailures: 0 };
  const recordFaults = () => AtomicFile.writeJsonAtomic(path.join(root, 'fault-observations.json'), observations);
  const settingsFile = path.join(process.env.KB_DATA_DIR, 'settings.json');
  const initialSettings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : { knowledge: { rootPath: path.join(root, 'knowledge') } };
  // Mirror the supervisor's persisted directory choice. A hardcoded old root
  // would manufacture a storage switch and paid rebuild on every fixture restart.
  const initialIndexRoot = new StorageLayout({ dataDir: process.env.KB_DATA_DIR }).getVectorRootPath(initialSettings);
  const manager = await HubManager.load({ managed: true, rootPath: initialIndexRoot, configPath: path.join(root, 'vector.json'), ...(realEmbeddingSettings ? {} : { embeddingsFactory: () => ({ maxTokens: 1000, async createEmbeddings(inputs) { return { status: 'success', output: (Array.isArray(inputs) ? inputs : [inputs]).map(() => [1, 0]) }; } }) }) });
  const vectorHandler = createServer(manager, { runtimeToken: token, uiPath: path.join(vectorPackage, 'ui/index.html') });
  const vectors = http.createServer((req, res) => {
    if (faultScenarios && req.method === 'POST' && req.url === '/api/sync' && observations.syncFailures === 0) {
      observations.syncFailures++; recordFaults(); req.resume();
      res.writeHead(503, { 'Content-Type': 'application/json', 'x-request-id': 'request-index-fixture' }); res.end(JSON.stringify({ ok: false, error: { code: 'CONTROLLED_INDEX_OUTAGE', message: '<img src=x onerror=window.__indexXss=1> CONTROLLED_INDEX_OUTAGE apiKey="no-leak-key"' } })); return;
    }
    vectorHandler(req, res);
  }); await listen(vectors);
  const engine = createEngineServer({ dataDir: path.join(root, 'engine'), logger: productLogger, managed: true, runtimeToken: token, bridgeUrl: url(events), vectorUrl: url(vectors), ...(realProfile ? {} : { analyzer: { async runClaim(input) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    let emptyOutput = false;
    if (faultScenarios) {
      const sha = input.claim.commitSha;
      observations.attempts[sha] = (observations.attempts[sha] || 0) + 1; recordFaults();
      const subject = execFileSync('git', ['show', '-s', '--format=%s', sha], { cwd: input.config.repoPath, windowsHide: true, encoding: 'utf8' });
      emptyOutput = observations.attempts[sha] === 1 && subject.includes('acceptance-empty-output');
      if (observations.attempts[sha] === 1 && subject.includes('acceptance-timeout')) throw Object.assign(new Error('Controlled model timeout'), { code: 'MODEL_TIMEOUT', retryable: true });
      if (observations.attempts[sha] === 1 && subject.includes('acceptance-invalid')) {
        AtomicFile.writeJsonAtomic(input.manifestPath, { schema: 'knowledge-staging-manifest/v1', projectId: input.projectId, runId: input.claim.runId, commitSha: sha, operations: [{ operation: 'create', path: '../outside.md' }] }); return;
      }
    }
    const relative = `changes/${input.claim.commitSha.slice(0, 12)}.md`;
    const memoryText = process.env.KB_ACCEPTANCE_DISTINCT_MEMORIES === '1' ? `项目 ${input.projectId} 的维护偏好：保持功能简单，复用成熟消息流。` : '功能保持简单，复用成熟消息流。';
    const title = process.env.KB_ACCEPTANCE_TITLELESS_OUTPUT === '1' ? '' : `# ${input.claim.commitSha} · 知识写入边界\n\n`;
    const content = emptyOutput ? ' \n\t' : `${title}知识由引擎的晋升路径作为单写者维护，提交依据：${input.claim.commitSha}。\n\n用户要求：${memoryText}\n`;
    AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', relative), content);
    const memoryCandidates = [{ text: memoryText, entryId: relative, quote: memoryText }];
    if (process.env.KB_ACCEPTANCE_INVALID_MEMORY_CANDIDATE === '1') memoryCandidates.push({ text: 'Invalid model candidate must not enter memory', entryId: 'candidate-wrong-id', quote: memoryText });
    AtomicFile.writeJsonAtomic(input.manifestPath, { schema: 'knowledge-staging-manifest/v1', projectId: input.projectId, runId: input.claim.runId, commitSha: input.claim.commitSha, operations: [{ path: relative, operation: 'create', reason: 'Controlled model acceptance output', sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`] }], memoryCandidates });
  } } }) }); await engine.ready; await listen(engine.server);
  const workbench = createWorkbenchServer({ dataDir: path.join(root, 'workbench'), ...(realProfile ? {} : { runner: createFakeRunner({ streamDelayMs: Math.min(5000, Math.max(0, Number(process.env.KB_ACCEPTANCE_STREAM_DELAY_MS) || 0)) }) }), runtimeToken: token, engineUrl: url(engine.server), bridgeUrl: url(events) });
  workbench.profiles.save(realProfile ? { ...realProfile, id: 'acceptance-model', credentialRef: 'acceptance-model', name: '真实模型抽测' } : { id: 'acceptance-model', name: '验收模型替身', provider: 'test', baseUrl: 'https://example.invalid', models: { default: 'controlled-model' } });
  workbench.profiles.setCredential('acceptance-model', realProfile?.apiKey || 'controlled-agent-not-real'); workbench.profiles.setMaintenanceDefault('acceptance-model'); await listen(workbench.server);
  if (realEmbeddingSettings) workbench.profiles.setEmbeddingConfig({ provider: realEmbeddingSettings.provider, model: realEmbeddingSettings.model, endpoint: realEmbeddingSettings.endpoint, secret: realEmbeddingSettings.apiKey });
  else if (!workbench.profiles.embeddingConfig().configured) workbench.profiles.setEmbeddingConfig({ provider: 'minimax', model: 'controlled-embedding', secret: 'controlled-embedding-not-real' });
  const shellRuntime = createRuntime({ dataDir: process.env.KB_DATA_DIR, logger: productLogger, analysisOwner: 'engine', bridgeAdapter: new BridgeAdapter({ dataDir: process.env.KB_DATA_DIR, modulePath: process.env.AI_CODING_EVENT_BRIDGE_MODULE }) });
  await shellRuntime.settingsStore.initialize({ knowledge: { rootPath: path.join(root, 'knowledge') } });
  await shellRuntime.registryStore.initialize();
  shellRuntime.moduleBridge = new ModuleBridge({ dataDir: process.env.KB_DATA_DIR, settingsStore: shellRuntime.settingsStore, registryStore: shellRuntime.registryStore, projectStore: shellRuntime.projectStore, logger: shellRuntime.logger, runtimeToken: token, terminalUrl: url(workbench.server), vectorHubUrl: url(vectors), eventBridgeUrl: url(events), engineUrl: url(engine.server) });
  let shellPort = Number(process.env.KB_PRODUCT_TEST_PORT || 5801);
  if (shellPort === 0) {
    const probe = http.createServer(); await listen(probe); shellPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
  }
  const shell = await startServer({ runtime: shellRuntime, rootDir: shellPackage, port: shellPort, host: '127.0.0.1' });
  const details = { pid: process.pid, url: `http://127.0.0.1:${shell.port}`, root, repositories, knowledgeRoot: path.join(root, 'knowledge'), agentConfiguration: realProfile ? process.env.KB_ACCEPTANCE_USER_AGENT_CONFIG === '1' ? 'existing user configuration' : 'isolated control configuration' : 'test double', installationSource: installation?.schema || 'source checkouts', installationReport: process.env.KB_PRODUCT_INSTALLATION_REPORT || null, runtimeRoots: { shell: shellPackage, engine: installation ? path.join(shellPackage, '_modules/knowledge-engine') : path.join(family, 'knowledge-engine'), workbench: workbenchPackage, vector: vectorPackage, events: bridgePackage }, modules: { engine: url(engine.server), workbench: url(workbench.server), events: url(events), vectors: url(vectors) }, model: realProfile ? realEmbeddingSettings ? 'real Agent and real embeddings; original provider stores are read-only' : 'real Agent; embedding remains a controlled substitute' : 'controlled substitute; not real Agent acceptance' };
  AtomicFile.writeJsonAtomic(path.join(root, 'acceptance-environment.json'), details);
  process.stdout.write(JSON.stringify(details) + '\n');
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await shell.stop('acceptance-stop'); await engine.close();
    await workbench.service.destroy();
    for (const server of [workbench.server, vectors, events]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await manager.close?.(); process.exit(0);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdin.setEncoding('utf8'); process.stdin.on('data', input => { if (input.trim() === 'stop') stop(); });
}
main().catch(error => { process.stderr.write(`${error.code || 'START_FAILED'}: ${error.message}\n`); process.exit(1); });
