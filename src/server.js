'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { EngineStore } = require('./store');
const { seedState, knowledgeCorpus } = require('./seed');

const VERSION = require('../package.json').version;
const UI_DIR = path.resolve(__dirname, '..', 'ui');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);

/**
 * knowledge-engine 服务：触发面（commit boundary -> 分析运行 -> 晋升）与
 * 检索面（search / ask）的统一 HTTP 入口，附带调试台静态页。
 *
 * 脚手架阶段（v0.1）：API 面与调试页全通；管道内部为 stub ——
 *   - POST /api/runs        模拟 认领 -> 分析 -> 晋升 的状态机（阶段 2 接真 reconciler + Agent SDK）
 *   - POST /api/search|ask  内置语料上的确定性检索（阶段 1 接真 BM25 + 向量运行时）
 *   - 事件流                本地 store（阶段 3 改为 event-bridge journal 的注册消费者游标）
 * 每个 stub 的注释都标了对应的接线阶段。
 */
function createEngineServer(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const store = new EngineStore(dataDir);
  if (store.isEmpty()) store.replace(seedState());
  const startedAt = Date.now();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const body = await readBody(req);
      try {
        const payload = await api(req.method, pathname, url.searchParams, body, store, { dataDir, startedAt });
        send(res, 200, { ok: true, ...payload });
      } catch (error) {
        const status = error.status || 500;
        send(res, status, { ok: false, error: error.code || 'INTERNAL', message: error.message });
      }
      return;
    }

    const entry = STATIC_FILES.get(pathname);
    if (entry && req.method === 'GET') {
      const [file, type] = entry;
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(path.join(UI_DIR, file)));
      return;
    }
    send(res, 404, { ok: false, error: 'NOT_FOUND' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      send(res, 500, { ok: false, error: 'INTERNAL', message: error.message });
    });
  });
  server.store = store;
  return { server, store };
}

async function api(method, pathname, search, body, store, ctx) {
  if (method === 'GET' && pathname === '/api/health') {
    return {
      name: 'knowledge-engine',
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      dataDir: ctx.dataDir,
      counts: {
        projects: store.state.projects.length,
        runs: store.state.runs.length,
        running: store.state.runs.filter(r => r.state === 'running' || r.state === 'queued').length,
      },
      journal: { cursor: store.state.cursor, consumer: 'knowledge-engine (stub: local store, journal pending phase 3)' },
    };
  }

  if (method === 'GET' && pathname === '/api/projects') {
    return { projects: store.listProjects() };
  }

  if (method === 'POST' && pathname === '/api/projects') {
    if (!body.projectId) throw httpError(400, 'INVALID_ARGUMENT', 'projectId is required');
    const { project, reused } = store.addProject(body);
    if (!reused) store.addEvent({ type: 'project.register', projectId: project.projectId, summary: `注册项目 ${project.name}` });
    return { project, reused };
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (method === 'DELETE' && projectMatch) {
    const removed = store.removeProject(decodeURIComponent(projectMatch[1]));
    if (!removed) throw httpError(404, 'NOT_FOUND', 'project not found');
    return { removed: true };
  }

  if (method === 'GET' && pathname === '/api/runs') {
    return { runs: store.listRuns(search.get('projectId') || null) };
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch) {
    const run = store.getRun(decodeURIComponent(runMatch[1]));
    if (!run) throw httpError(404, 'NOT_FOUND', 'run not found');
    return { run };
  }

  if (method === 'POST' && pathname === '/api/runs') {
    const project = store.getProject(body.projectId);
    if (!project) throw httpError(400, 'INVALID_ARGUMENT', 'unknown projectId');
    const run = store.addRun({
      projectId: body.projectId,
      commitSha: body.commitSha,
      trigger: 'manual-debug',
      note: body.note || '',
    });
    store.addEvent({ type: 'commit-boundary', projectId: run.projectId, summary: `${run.commitSha.slice(0, 7)} 手动触发分析` });
    // stub：真实现 = CommitReconciler 认领 -> 无头 Agent SDK 会话分析 -> staging 校验晋升。
    setTimeout(() => store.updateRun(run.runId, { state: 'running' }), 400).unref?.();
    setTimeout(() => {
      if (body.simulateFailure) {
        store.updateRun(run.runId, { state: 'failed', finishedAt: new Date().toISOString(), error: 'Knowledge analyzer timed out. (模拟失败，用于调试失败态展示)' });
        store.addEvent({ type: 'knowledge.run', projectId: run.projectId, summary: `${run.runId} 失败：模拟超时` });
      } else {
        store.updateRun(run.runId, { state: 'succeeded', finishedAt: new Date().toISOString(), staging: buildStaging(run, project) });
        store.addEvent({ type: 'knowledge.run', projectId: run.projectId, summary: `${run.runId} 完成：${buildStaging(run, project).operations.length} 个操作晋升` });
      }
    }, 1600).unref?.();
    return { run };
  }

  if (method === 'POST' && pathname === '/api/search') {
    if (!body.projectId || !body.query) throw httpError(400, 'INVALID_ARGUMENT', 'projectId and query are required');
    const limit = Math.max(1, Math.min(Number(body.limit) || 8, 30));
    return { query: body.query, results: stubSearch(body.projectId, body.query, limit) };
  }

  if (method === 'POST' && pathname === '/api/ask') {
    if (!body.projectId || !body.query) throw httpError(400, 'INVALID_ARGUMENT', 'projectId and query are required');
    const hits = stubSearch(body.projectId, body.query, 3);
    // stub：确定性 top-3 拼接，与真 ask 语义一致（非 LLM 生成）。
    const answer = hits.length
      ? hits.map((h, i) => `[${i + 1}] ${h.snippet}`).join('\n\n')
      : '知识库中没有找到与问题相关的内容。';
    return { query: body.query, answer, citations: hits.map((h, i) => ({ ref: i + 1, path: h.path, title: h.title, score: h.score })) };
  }

  if (method === 'GET' && pathname === '/api/events') {
    return { events: store.listEvents(search.get('limit')) };
  }

  if (method === 'POST' && pathname === '/api/events') {
    if (!body.type) throw httpError(400, 'INVALID_ARGUMENT', 'type is required');
    return { event: store.addEvent(body) };
  }

  throw httpError(404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
}

/** 检索面 stub：CJK 双字 + 拉丁词的词频打分（真实现 = BM25 + 向量，阶段 1 接线）。 */
function stubSearch(projectId, query, limit) {
  const corpus = knowledgeCorpus[projectId] || [];
  const tokens = tokenize(query);
  const scored = corpus
    .map(doc => {
      const hay = doc.title + '\n' + doc.body;
      let score = 0;
      for (const token of tokens) {
        const hits = hay.split(token).length - 1;
        if (hits > 0) score += hits * (doc.title.includes(token) ? 2 : 1);
      }
      return { path: doc.path, title: doc.title, score, snippet: snippetAround(hay, tokens) };
    })
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function tokenize(query) {
  const normalized = String(query || '').trim().toLowerCase();
  const tokens = normalized.match(/[a-z0-9_:-]+/gu) || [];
  for (const segment of normalized.match(/[\u4e00-\u9fff]+/gu) || []) {
    for (let i = 0; i < segment.length - 1; i += 1) tokens.push(segment.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}

function snippetAround(text, tokens) {
  for (const token of tokens) {
    const i = text.indexOf(token);
    if (i >= 0) return '…' + text.slice(Math.max(0, i - 20), i + 80).trim() + '…';
  }
  return text.slice(0, 100);
}

function buildStaging(run, project) {
  return {
    schema: 'knowledge-staging-manifest/v1',
    projectId: run.projectId,
    commitSha: run.commitSha,
    operations: [
      { path: `changes/${run.commitSha.slice(0, 7)}.md`, operation: 'create', reason: run.note || 'commit 分析', evidenceReferences: [`commit:${run.commitSha.slice(0, 7)}`] },
      { path: 'modules/commit-pipeline.md', operation: 'update', reason: '管道知识随 commit 更新', evidenceReferences: [`commit:${run.commitSha.slice(0, 7)}`] },
    ],
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'INVALID_ARGUMENT', 'body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = { createEngineServer };
