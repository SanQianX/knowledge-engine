'use strict';

/* ---------- 基础设施 ---------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

async function api(path, options = {}) {
  const init = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const res = await fetch(path, init);
  const payload = await res.json().catch(() => ({ ok: false, error: 'BAD_JSON' }));
  if (!res.ok || payload.ok === false) {
    toast(payload.message || payload.error || `HTTP ${res.status}`);
    throw new Error(payload.error || 'API_ERROR');
  }
  return payload;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function shortSha(sha) { return sha ? sha.slice(0, 7) : '–'; }

function stateBadge(state) { return `<span class="badge ${state}">${state}</span>`; }
function typeBadge(type) { return `<span class="badge type">${type}</span>`; }

/* ---------- 视图路由 ---------- */

let currentView = 'overview';

$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.view;
    $$('.nav-item').forEach(b => b.classList.toggle('on', b === btn));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + currentView));
    refreshView(currentView);
  });
});

function refreshView(view) {
  if (view === 'overview') loadOverview();
  else if (view === 'projects') loadProjects();
  else if (view === 'runs') loadRuns();
  else if (view === 'events') loadEvents();
  else if (view === 'retrieval') loadProjectSelects();
}

/* ---------- 健康 ---------- */

async function pollHealth() {
  try {
    const health = await api('/api/health');
    $('#healthDot').classList.add('up');
    $('#healthText').textContent = `v${health.version} · 游标 ${health.journal.cursor}`;
    return health;
  } catch {
    $('#healthDot').classList.remove('up');
    $('#healthText').textContent = '服务离线';
    return null;
  }
}

/* ---------- 概览 ---------- */

async function loadOverview() {
  const [health, runs] = await Promise.all([pollHealth(), api('/api/runs').catch(() => null)]);
  if (!health || !runs) return;
  $('#statProjects').textContent = health.counts.projects;
  $('#statRunning').textContent = health.counts.running;
  $('#statCursor').textContent = health.journal.cursor;
  const succeeded = runs.runs.filter(r => r.state === 'succeeded').length;
  const failed = runs.runs.filter(r => r.state === 'failed').length;
  $('#statSucceeded').textContent = succeeded;
  $('#statFailed').textContent = failed;
  $('#overviewRuns').innerHTML = runs.runs.slice(0, 6).map(run => `
    <tr>
      <td class="mono">${run.runId}</td>
      <td>${escapeHtml(run.projectId)}</td>
      <td class="mono">${shortSha(run.commitSha)}</td>
      <td>${stateBadge(run.state)}</td>
      <td class="mono">${fmtDuration(run.durationMs)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无运行</td></tr>';
  $('#serviceInfo').innerHTML = `
    <div><dt>版本</dt><dd class="mono">${health.version}</dd></div>
    <div><dt>uptime</dt><dd class="mono">${Math.floor(health.uptimeSec / 60)}m ${health.uptimeSec % 60}s</dd></div>
    <div><dt>数据目录</dt><dd class="mono">${escapeHtml(health.dataDir)}</dd></div>
    <div><dt>journal 消费者</dt><dd>${escapeHtml(health.journal.consumer)}</dd></div>`;
}

/* ---------- 项目 ---------- */

async function loadProjects() {
  const { projects } = await api('/api/projects');
  $('#projectsBody').innerHTML = projects.map(p => `
    <tr>
      <td class="mono">${escapeHtml(p.projectId)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td class="mono wrap">${escapeHtml(p.repoPath || '–')}</td>
      <td class="mono wrap">${escapeHtml(p.knowledgePath || '–')}</td>
      <td class="mono">${shortSha(p.lastCommitSha)}</td>
      <td><button class="btn danger" data-del="${escapeHtml(p.projectId)}">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">尚无项目，点击「注册项目」。</td></tr>';
  $$('#projectsBody [data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`删除项目 ${btn.dataset.del}？（知识树与运行历史保留）`)) return;
      await api('/api/projects/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
      loadProjects();
    });
  });
}

$('#btnShowRegister').addEventListener('click', () => $('#registerForm').classList.toggle('hidden'));
$('#btnCancelRegister').addEventListener('click', () => $('#registerForm').classList.add('hidden'));
$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/projects', { method: 'POST', body: data });
  event.target.reset();
  $('#registerForm').classList.add('hidden');
  loadProjects();
});

/* ---------- 分析运行 ---------- */

let runPollTimer;
let selectedRunId = null;

async function loadRuns() {
  const projectId = $('#runProjectFilter').value;
  const state = $('#runStateFilter').value;
  const { runs } = await api('/api/runs' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
  const filtered = state ? runs.filter(r => r.state === state) : runs;
  $('#runsBody').innerHTML = filtered.map(run => `
    <tr class="click ${run.runId === selectedRunId ? 'sel' : ''}" data-run="${run.runId}">
      <td class="mono">${run.runId}</td>
      <td>${escapeHtml(run.projectId)}</td>
      <td class="mono">${shortSha(run.commitSha)}</td>
      <td class="mono">${escapeHtml(run.trigger)}</td>
      <td>${stateBadge(run.state)}</td>
      <td class="mono">${fmtTime(run.startedAt)}</td>
      <td class="mono">${fmtDuration(run.durationMs)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">没有符合条件的运行。</td></tr>';
  $$('#runsBody [data-run]').forEach(tr => {
    tr.addEventListener('click', () => { selectedRunId = tr.dataset.run; showRunDetail(selectedRunId); loadRuns(); });
  });
  const active = runs.some(r => r.state === 'queued' || r.state === 'running');
  clearTimeout(runPollTimer);
  if (active && currentView === 'runs') runPollTimer = setTimeout(loadRuns, 800);
}

async function showRunDetail(runId) {
  const { run } = await api('/api/runs/' + encodeURIComponent(runId));
  $('#runDetail').classList.remove('hidden');
  $('#runDetailId').textContent = run.runId;
  $('#runMeta').innerHTML = `
    <div><dt>状态</dt><dd>${stateBadge(run.state)}</dd></div>
    <div><dt>项目 / commit</dt><dd>${escapeHtml(run.projectId)} · <span class="mono">${shortSha(run.commitSha)}</span></dd></div>
    <div><dt>备注</dt><dd>${escapeHtml(run.note || '–')}</dd></div>
    <div><dt>错误</dt><dd>${run.error ? `<span style="color:var(--red)">${escapeHtml(run.error)}</span>` : '–'}</dd></div>`;
  $('#runStaging').textContent = run.staging
    ? JSON.stringify(run.staging, null, 2)
    : '该运行没有 staging 产物。';
}

$('#runProjectFilter').addEventListener('change', loadRuns);
$('#runStateFilter').addEventListener('change', loadRuns);
$('#btnShowTrigger').addEventListener('click', async () => {
  $('#triggerForm').classList.toggle('hidden');
  if (!$('#triggerForm').classList.contains('hidden')) await loadProjectSelects();
});
$('#btnCancelTrigger').addEventListener('click', () => $('#triggerForm').classList.add('hidden'));
$('#triggerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.simulateFailure = event.target.simulateFailure.checked;
  if (!data.commitSha) delete data.commitSha;
  await api('/api/runs', { method: 'POST', body: data });
  $('#triggerForm').classList.add('hidden');
  toast('已触发，等待状态机推进…');
  loadRuns();
});

/* ---------- 检索调试 ---------- */

async function loadProjectSelects() {
  const { projects } = await api('/api/projects');
  const options = projects.map(p => `<option value="${escapeHtml(p.projectId)}">${escapeHtml(p.name)}</option>`).join('');
  for (const sel of [$('#triggerProject'), $('#retrievalProject'), $('#runProjectFilter')]) {
    const current = sel.value;
    const isFilter = sel === $('#runProjectFilter');
    sel.innerHTML = (isFilter ? '<option value="">全部项目</option>' : '') + options;
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }
}

$('#btnSearch').addEventListener('click', async () => {
  const projectId = $('#retrievalProject').value;
  const query = $('#retrievalQuery').value.trim();
  if (!projectId || !query) return toast('先选择项目并输入查询。');
  const { results } = await api('/api/search', { method: 'POST', body: { projectId, query, limit: Number($('#retrievalLimit').value) || 5 } });
  $('#searchBody').innerHTML = results.map(hit => `
    <tr>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td>${escapeHtml(hit.title)}</td>
      <td class="score">${hit.score}</td>
      <td class="wrap">${escapeHtml(hit.snippet)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">没有命中的知识文档。</td></tr>';
});

$('#btnAsk').addEventListener('click', async () => {
  const projectId = $('#retrievalProject').value;
  const query = $('#retrievalQuery').value.trim();
  if (!projectId || !query) return toast('先选择项目并输入查询。');
  const payload = await api('/api/ask', { method: 'POST', body: { projectId, query } });
  $('#askPanel').classList.remove('hidden');
  $('#askAnswer').textContent = payload.answer;
  $('#askCitations').innerHTML = payload.citations.map(c =>
    `<li><span class="mono">${escapeHtml(c.path)}</span> · ${escapeHtml(c.title)} · <span class="score">${c.score}</span></li>`).join('')
    || '<li>无引用</li>';
});

/* ---------- 事件流 ---------- */

async function loadEvents() {
  const { events } = await api('/api/events?limit=100');
  $('#eventsBody').innerHTML = events.map(event => `
    <tr>
      <td class="mono">${event.seq}</td>
      <td>${typeBadge(event.type)}</td>
      <td>${escapeHtml(event.projectId || '–')}</td>
      <td class="wrap">${escapeHtml(event.summary)}</td>
      <td class="mono">${fmtTime(event.at)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无事件。</td></tr>';
}

$('#btnInjectEvent').addEventListener('click', async () => {
  await api('/api/events', { method: 'POST', body: { type: 'commit-boundary', projectId: null, summary: '手动注入的测试事件' } });
  loadEvents();
});

/* ---------- 工具 ---------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------- 启动 ---------- */

pollHealth();
refreshView('overview');
setInterval(() => { if (currentView === 'overview') loadOverview(); }, 5000);
