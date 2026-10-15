'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EngineStore } = require('./store');
const { EngineCoordinator } = require('./coordinator');
const AtomicFile = require('./runtime/atomic-file');

const VERSION = require('../package.json').version;
const UI_DIR = path.resolve(__dirname, '..', 'ui');
const STATIC_FILES = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/app.css', ['app.css', 'text/css']]]);

function createEngineServer(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data-v3');
  const store = options.store || new EngineStore(dataDir, { deferLoad: true });
  let releaseLease;
  const coordinator = new EngineCoordinator(store, { ...options, initializeHook: async () => {
    try { releaseLease = await AtomicFile.acquireFileLock(path.join(store.dataDir, 'engine-runtime.lock'), { timeoutMs: 0 }); }
    catch (error) { throw Object.assign(new Error('此数据目录已有引擎运行，请勿启动第二个知识写入者。'), { code: 'ENGINE_ALREADY_RUNNING', cause: error }); }
    try { if (!options.store) store.load(); } catch (error) { await releaseLease(); releaseLease = null; throw error; }
  } });
  const startedAt = Date.now();
  const connections = new Set();
  const runtimeToken = options.runtimeToken || process.env.KB_ENGINE_RUNTIME_TOKEN;
  function trusted(req) {
    const value = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const address = req.socket.remoteAddress;
    return !req.headers.origin && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) && runtimeToken && Buffer.byteLength(value) === Buffer.byteLength(runtimeToken) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(runtimeToken));
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw httpError(403, 'FORBIDDEN_ORIGIN', '不允许跨来源访问。');
    if (pathname === '/api/progress' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      connections.add(res);
      const projectId = url.searchParams.get('projectId');
      res.write(`event: snapshot\ndata: ${JSON.stringify({ cursor: store.state.cursor, ...(url.searchParams.get('summary') === '1' ? {} : { runs: store.listRuns(projectId || null) }) })}\n\n`);
      const listener = event => { if ((!projectId || event.projectId === projectId) && !res.destroyed) res.write(`id: ${event.seq || store.state.cursor}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`); };
      coordinator.on('progress', listener);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      res.on('close', () => { clearInterval(heartbeat); coordinator.off('progress', listener); connections.delete(res); });
      return;
    }
    if (pathname.startsWith('/api/')) {
      const body = await readBody(req);
      if (pathname === '/api/runtime-auth' && req.method === 'GET') {
        if (!trusted(req)) throw httpError(403, 'RUNTIME_AUTH_REQUIRED', '仅允许受信任外壳检查连接。');
        send(res, 200, { ok: true, dataSchemaVersion: store.state.schemaVersion }); return;
      }
      if (pathname === '/api/control' && req.method === 'POST') {
        if (!trusted(req)) throw httpError(403, 'RUNTIME_AUTH_REQUIRED', '仅允许受信任外壳切换运行所有权。');
        if (body.enabled !== true) throw httpError(400, 'INVALID_ARGUMENT', '只支持外壳完成接线后的启用操作。');
        if (body.projectIds !== undefined && (!Array.isArray(body.projectIds) || body.projectIds.some(id => typeof id !== 'string' || !store.getProject(id)))) throw httpError(400, 'INVALID_ARGUMENT', '启用项目未登记。');
        await coordinator.activate(body.projectIds); send(res, 200, { ok: true }); return;
      }
      if (pathname === '/api/runtime-config' && req.method === 'POST') {
        if (!trusted(req)) throw httpError(403, 'RUNTIME_AUTH_REQUIRED', '仅允许受信任本地服务解析配置。');
        coordinator.setProfile(body.projectId || 'default', body.profile);
        send(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/scopes' && req.method === 'POST') {
        if (!trusted(req)) throw httpError(403, 'RUNTIME_AUTH_REQUIRED', '仅允许外壳登记共享范围。');
        const scopes = await coordinator.memories.configure(body.scopes);
        coordinator.syncSharedIndexes();
        send(res, 200, { ok: true, scopes }); return;
      }
      send(res, 200, { ok: true, ...await api(req.method, pathname, url.searchParams, body, store, coordinator, { dataDir, startedAt, debug: options.debug === true }) });
      return;
    }
    const entry = STATIC_FILES.get(pathname);
    if (entry && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8` });
      res.end(fs.readFileSync(path.join(UI_DIR, entry[0])));
      return;
    }
    throw httpError(404, 'NOT_FOUND', '页面不存在。');
  }
  const server = http.createServer((req, res) => handle(req, res).catch(error => {
    if (!res.headersSent) send(res, error.status || 500, { ok: false, error: error.code || 'INTERNAL', message: error.message });
    else res.destroy();
  }));
  server.store = store;
  server.coordinator = coordinator;
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await coordinator.ready.catch(() => {});
      await coordinator.close();
      for (const response of connections) response.end(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await releaseLease?.(); releaseLease = null;
    })();
    return closing;
  }
  server.on('close', () => { if (!closing) close(); });
  return { server, store, coordinator, ready: coordinator.ready, close };
}

async function api(method, pathname, search, body, store, coordinator, ctx) {
  if (method === 'GET' && pathname === '/api/health') return { name: 'knowledge-engine', version: VERSION, dataSchemaVersion: store.state.schemaVersion, debug: ctx.debug, executionEnabled: coordinator.executionEnabled, uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000), dataDir: ctx.dataDir, counts: { projects: store.state.projects.length, runs: store.state.runs.length, running: coordinator.active.size }, journal: { cursor: store.state.cursor, cursors: store.state.journalCursors, consumer: 'knowledge-engine', enabled: coordinator.consume, error: coordinator.journalError || null, failures: [...coordinator.journalFailures.values()] }, concurrency: coordinator.concurrency };
  if (method === 'GET' && pathname === '/api/projects') return { projects: store.listProjects() };
  if (method === 'GET' && pathname === '/api/memories') return { memories: coordinator.memories.list(Object.fromEntries(search)) };
  if (method === 'POST' && pathname === '/api/memories') {
    const memory = await coordinator.memories.create(body);
    coordinator.emit('progress', store.addEvent({ type: 'memory.created', summary: '已手动添加长期记忆' }));
    return { memory };
  }
  const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (method === 'PATCH' && memoryMatch) {
    const memory = await coordinator.memories.update(decodeURIComponent(memoryMatch[1]), body);
    coordinator.emit('progress', store.addEvent({ type: 'memory.updated', summary: memory.status === 'confirmed' ? '已确认长期记忆' : memory.status === 'ignored' ? '已忽略记忆候选' : '已编辑记忆候选' }));
    return { memory };
  }
  if (method === 'POST' && pathname === '/api/projects') {
    const result = store.addProject(body);
    if (!result.reused) store.addEvent({ type: 'project.register', projectId: body.projectId, summary: `登记 ${result.project.name}` });
    return result;
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (method === 'DELETE' && projectMatch) {
    const result = await coordinator.removeProject(decodeURIComponent(projectMatch[1]));
    if (!result.removed) throw httpError(404, 'NOT_FOUND', '项目未登记。');
    return { ...result, keptData: true };
  }
  if (method === 'GET' && pathname === '/api/runs') return search.get('summary') === '1' ? store.listRunPage({ projectId: search.get('projectId'), limit: search.get('limit') || 50, before: search.get('before') }) : { runs: store.listRuns(search.get('projectId')) };
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)(\/retry)?$/);
  if (runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    if (method === 'POST' && runMatch[2]) return { run: await coordinator.retry(id) || store.getRun(id) };
    if (method === 'GET' && !runMatch[2]) { const run = store.getRun(id); if (!run) throw httpError(404, 'NOT_FOUND', '运行不存在。'); return { run }; }
  }
  if (method === 'POST' && pathname === '/api/runs') {
    if (!ctx.debug) throw httpError(403, 'DEBUG_DISABLED', '正式运行只消费提交事件，手工运行仅在调试模式中可用。');
    return { run: coordinator.enqueue({ projectId: body.projectId, commitSha: body.commitSha, trigger: 'manual-debug', debugFailure: ctx.debug && body.simulateFailure === true }) };
  }
  if (method === 'POST' && ['/api/search', '/api/ask', '/api/get', '/api/history'].includes(pathname)) return coordinator.retrieval[pathname.slice(5)](body);
  if (method === 'POST' && pathname === '/api/context') return coordinator.context.prepare(body);
  if (method === 'GET' && ['/api/get', '/api/history'].includes(pathname)) return coordinator.retrieval[pathname.slice(5)](Object.fromEntries(search));
  if (method === 'GET' && pathname === '/api/events') return { events: store.listEvents(search.get('limit')).filter(e => !search.get('projectId') || e.projectId === search.get('projectId')) };
  if (method === 'POST' && pathname === '/api/events' && ctx.debug) return { event: store.addEvent(body) };
  if (method === 'POST' && pathname === '/api/bridge/notify') { if (coordinator.consume) coordinator.drain(); return { accepted: true }; }
  if (method === 'GET' && pathname === '/api/snapshot') return { projects: store.listProjects(), ...(search.get('summary') === '1' ? store.listRunPage({ projectId: search.get('projectId'), limit: search.get('limit') || 50, before: search.get('before') }) : { runs: store.listRuns(search.get('projectId')) }), events: store.listEvents(50), memories: coordinator.memories.list(), sharedScopes: store.state.sharedScopes };
  throw httpError(404, 'NOT_FOUND', '接口不存在。');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { reject(httpError(413, 'BODY_TOO_LARGE', '请求过大。')); req.resume(); } else chunks.push(chunk); });
    req.on('end', () => { if (!size) return resolve({}); try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body'); resolve(value); } catch { reject(httpError(400, 'INVALID_ARGUMENT', '请求必须为 JSON 对象。')); } });
    req.on('error', reject);
  });
}
function send(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
function httpError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
module.exports = { createEngineServer };
