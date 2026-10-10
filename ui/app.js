'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const viewMeta = {
  overview: ['knowledge control plane', '知识脉搏'],
  runs: ['generation pipeline', '生成流水线'],
  knowledge: ['canonical knowledge', '知识状态'],
  retrieval: ['retrieval verification', '检索验证'],
  projects: ['integration diagnostics', '项目接线'],
  events: ['immutable evidence stream', '事件流'],
};
let currentView = 'overview';
let scopedProjectId = '';
let toastTimer;
let runPollTimer;
let selectedRunId = null;
let viewEpoch = 0;
const embedParams = new URLSearchParams(location.search);
const embedded = embedParams.get('embed') === '1';
let embedVisible = !embedded;
const apiBase = embedParams.get('apiBase') || '/api';
const parentOrigin = document.referrer ? new URL(document.referrer).origin : location.origin;
document.body.classList.toggle('kb-embedded', embedded);

async function api(path, options = {}) {
  const init = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const response = await fetch(path.replace(/^\/api(?=\/|$)/, apiBase), init);
  const payload = await response.json().catch(() => ({ ok: false, error: 'BAD_JSON' }));
  if (!response.ok || payload.ok === false) {
    toast(payload.message || payload.error || `HTTP ${response.status}`);
    throw new Error(payload.error || 'API_ERROR');
  }
  return payload;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function fmtTime(iso) {
  if (!iso) return '–';
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
function fmtDuration(ms) { return ms == null ? '–' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function shortSha(sha) { return sha ? sha.slice(0, 7) : '–'; }
function stateBadge(state) { return `<span class="badge ${escapeHtml(state)}">${escapeHtml(({ queued: '排队', running: '运行中', succeeded: '可检索', failed: '失败', 'index-pending': '索引待修复', cancelled: '已取消' })[state] || state)}</span>`; }
function typeBadge(type) { return `<span class="badge type">${escapeHtml(type)}</span>`; }
function scopedPath(path) { return scopedProjectId ? `${path}${path.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(scopedProjectId)}` : path; }
function successfulRun(runs) { return runs.find(run => run.promotedAt) || null; }

function setView(view) {
  currentView = view;
  viewEpoch++;
  const [kicker, title] = viewMeta[view];
  $('#viewKicker').textContent = kicker;
  $('#viewTitle').textContent = title;
  $$('.nav-item').forEach(button => button.classList.toggle('on', button.dataset.view === view));
  $$('.view').forEach(section => section.classList.toggle('on', section.id === `view-${view}`));
  refreshView(view);
}

$$('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-goto]').forEach(button => button.addEventListener('click', () => setView(button.dataset.goto)));
$('#scopeProject').addEventListener('change', () => { scopedProjectId = $('#scopeProject').value; selectedRunId = null; viewEpoch++; refreshView(currentView); });

async function pollHealth() {
  try {
    const health = await api('/api/health');
    document.body.classList.toggle('engine-debug', health.debug === true);
    $('#healthDot').classList.add('up');
    $('#healthText').textContent = `v${health.version} · 游标 ${health.journal.cursor}`;
    return health;
  } catch {
    $('#healthDot').classList.remove('up');
    $('#healthText').textContent = '服务离线';
    return null;
  }
}

async function loadProjectScope() {
  const { projects } = await api('/api/projects');
  const select = $('#scopeProject');
  const previous = scopedProjectId || select.value;
  select.innerHTML = '<option value="">全部项目</option>' + projects.map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`).join('');
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  else { select.value = ''; scopedProjectId = ''; }
  return projects;
}

async function refreshView(view) {
  if (view === 'overview') loadOverview();
  if (view === 'runs') { await loadProjectSelects(); loadRuns(); }
  if (view === 'knowledge') loadKnowledge();
  if (view === 'retrieval') loadProjectSelects();
  if (view === 'projects') loadProjects();
  if (view === 'events') loadEvents();
}

function setFlowState(id, className) {
  const element = $(id);
  element.classList.remove('is-active', 'is-done');
  if (className) element.classList.add(className);
}

async function loadOverview() {
  const epoch = viewEpoch;
  const [health, projects, runPayload, eventPayload] = await Promise.all([
    pollHealth(), loadProjectScope().catch(() => []), api(scopedPath('/api/runs')).catch(() => null), api('/api/events?limit=20').catch(() => null),
  ]);
  if (!health || !runPayload || epoch !== viewEpoch) return;
  const runs = runPayload.runs;
  const events = (eventPayload?.events || []).filter(event => !scopedProjectId || event.projectId === scopedProjectId);
  const succeeded = runs.filter(run => run.promotedAt);
  const failed = runs.filter(run => run.state === 'failed' || run.state === 'index-pending');
  const running = runs.filter(run => run.state === 'queued' || run.state === 'running');
  const latestSuccess = successfulRun(runs);
  const latestEvent = events[0];
  $('#statProjects').textContent = scopedProjectId ? '1' : projects.length;
  $('#statProjectsDetail').textContent = scopedProjectId ? '当前选定项目' : '已登记的引擎接线';
  $('#statRunning').textContent = running.length;
  $('#statRunningDetail').textContent = running.length ? '正在推进生成链路' : '没有待处理运行';
  $('#statSucceeded').textContent = succeeded.length;
  $('#statSucceededDetail').textContent = latestSuccess ? `最近 ${shortSha(latestSuccess.commitSha)}` : '尚未晋升知识';
  $('#statFailed').textContent = failed.length;
  $('#statFailedDetail').textContent = failed.length ? '打开运行记录处理' : '没有失败运行';
  setFlowState('#flowJournal', health.journal.enabled && !health.journal.error ? 'is-done' : '');
  $('#flowJournalText').textContent = health.journal.error || (health.journal.enabled ? `${Object.keys(health.journal.cursors).length} 份日志正在消费` : '尚未移交自动维护所有权');
  setFlowState('#flowReconcile', latestEvent ? 'is-done' : '');
  $('#flowReconcileText').textContent = latestEvent ? `${latestEvent.type} · ${fmtTime(latestEvent.at)}` : '等待 commit boundary';
  setFlowState('#flowAnalyze', running.length ? 'is-active' : latestSuccess ? 'is-done' : '');
  $('#flowAnalyzeText').textContent = running.length ? `${running.length} 个运行正在分析` : latestSuccess ? `最近完成 ${shortSha(latestSuccess.commitSha)}` : '没有运行中的分析';
  setFlowState('#flowPromote', latestSuccess ? 'is-done' : '');
  $('#flowPromoteText').textContent = latestSuccess ? `${latestSuccess.staging?.operations?.length || 0} 项知识变更已晋升` : '尚未生成暂存产物';
  setFlowState('#flowIndex', latestSuccess?.indexState === 'succeeded' ? 'is-done' : latestSuccess?.indexState === 'running' ? 'is-active' : '');
  $('#flowIndexText').textContent = latestSuccess?.indexState === 'succeeded' ? '知识与派生索引一致' : latestSuccess ? '知识已更新，索引尚未完成' : '等待首次知识晋升';
  $('#flowPhase').textContent = health.journal.enabled ? '日志消费已启用' : '自动维护待切换';
  $('#overviewRuns').innerHTML = runs.slice(0, 6).map(run => `<tr class="click" data-open-run="${escapeHtml(run.runId)}"><td class="mono">${shortSha(run.commitSha)}</td><td>${escapeHtml(run.projectId)}</td><td>${stateBadge(run.state)}</td><td class="mono">${run.staging?.operations?.length || 0} 项</td><td class="mono">${fmtDuration(run.durationMs)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无知识运行。</td></tr>';
  $$('[data-open-run]').forEach(row => row.addEventListener('click', () => { selectedRunId = row.dataset.openRun; setView('runs'); }));
  if (failed.length) {
    $('#attentionTitle').textContent = `${failed.length} 个运行需要处理`;
    $('#attentionBody').textContent = `最近异常 ${shortSha(failed[0].commitSha)}：${failed[0].error?.message || '未提供错误详情'}。`;
  } else if (running.length) {
    $('#attentionTitle').textContent = '知识正在生成';
    $('#attentionBody').textContent = `${running.length} 个 commit 已被认领。打开流水线可查看当前阶段和暂存产物。`;
  } else if (latestSuccess) {
    $('#attentionTitle').textContent = '链路目前稳定';
    $('#attentionBody').textContent = `最近已为 ${shortSha(latestSuccess.commitSha)} 晋升 ${latestSuccess.staging?.operations?.length || 0} 项知识变更。`;
  } else {
    $('#attentionTitle').textContent = '等待第一份知识证据';
    $('#attentionBody').textContent = '引擎已就绪；提交 commit boundary 后，对账器会创建首个分析运行。';
  }
  $('#serviceInfo').innerHTML = `<div><dt>服务版本</dt><dd class="mono">${health.version}</dd></div><div><dt>服务 uptime</dt><dd class="mono">${Math.floor(health.uptimeSec / 60)}m ${health.uptimeSec % 60}s</dd></div><div><dt>事件消费者</dt><dd>${escapeHtml(health.journal.consumer)}</dd></div><div><dt>状态目录</dt><dd class="mono">${escapeHtml(health.dataDir)}</dd></div>`;
}

async function loadProjectSelects() {
  const { projects } = await api('/api/projects');
  const options = projects.map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`).join('');
  for (const select of [$('#triggerProject'), $('#retrievalProject'), $('#runProjectFilter')]) {
    const previous = select.value;
    const isFilter = select === $('#runProjectFilter');
    select.innerHTML = (isFilter ? '<option value="">全部项目</option>' : '') + options;
    const preferred = previous || (!isFilter ? scopedProjectId : '');
    if ([...select.options].some(option => option.value === preferred)) select.value = preferred;
  }
}

async function loadRuns() {
  const epoch = viewEpoch;
  const selectedProject = $('#runProjectFilter').value;
  const selectedState = $('#runStateFilter').value;
  const { runs } = await api(selectedProject ? `/api/runs?projectId=${encodeURIComponent(selectedProject)}` : scopedPath('/api/runs'));
  if (epoch !== viewEpoch) return;
  const visibleRuns = selectedState ? runs.filter(run => run.state === selectedState) : runs;
  $('#runsBody').innerHTML = visibleRuns.map(run => `<tr class="click ${run.runId === selectedRunId ? 'sel' : ''}" data-run="${escapeHtml(run.runId)}"><td class="mono">${shortSha(run.commitSha)}</td><td>${escapeHtml(run.projectId)}</td><td class="mono">${escapeHtml(run.trigger)}</td><td>${stateBadge(run.state)}</td><td class="mono">${fmtTime(run.startedAt)}</td><td class="mono">${fmtDuration(run.durationMs)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">没有符合条件的运行。</td></tr>';
  $$('[data-run]').forEach(row => row.addEventListener('click', () => { selectedRunId = row.dataset.run; showRunDetail(selectedRunId); loadRuns(); }));
  if (selectedRunId) showRunDetail(selectedRunId).catch(() => {});
  clearTimeout(runPollTimer);
  if (embedVisible && runs.some(run => run.state === 'queued' || run.state === 'running') && currentView === 'runs') runPollTimer = setTimeout(loadRuns, 800);
}

function runTimeline(run) {
  const stages = ['排队', '冻结证据', '分析会话', '校验晋升', '更新索引', '可检索'];
  const activeIndex = ({ queued: 0, recovering: 1, preparing: 1, analyzing: 2, promoting: 3, promoted: 4, indexing: 4, 'index-pending': 4, ready: 6 })[run.phase] ?? 2;
  return stages.map((stage, index) => `<li class="${['failed', 'index-pending'].includes(run.state) && index === activeIndex ? 'failed' : index < activeIndex ? 'done' : index === activeIndex ? 'current' : ''}">${stage}</li>`).join('');
}

async function showRunDetail(runId) {
  const { run } = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (runId !== selectedRunId || (scopedProjectId && run.projectId !== scopedProjectId)) return;
  $('#runDetail').classList.remove('hidden');
  $('#runDetailId').textContent = run.runId;
  $('#runTimeline').innerHTML = runTimeline(run);
  $('#runMeta').innerHTML = `<div><dt>状态</dt><dd>${stateBadge(run.state)}</dd></div><div><dt>项目 / commit</dt><dd>${escapeHtml(run.projectId)} · <span class="mono">${shortSha(run.commitSha)}</span></dd></div><div><dt>触发入口</dt><dd class="mono">${escapeHtml(run.trigger)}</dd></div><div><dt>错误</dt><dd>${run.error ? escapeHtml(run.error.message) : '–'}</dd></div>${run.error?.details ? `<div><dt>索引原因</dt><dd>${escapeHtml(run.error.details.upstreamMessage)}<br>${escapeHtml(run.error.details.failureKind)} · HTTP ${escapeHtml(run.error.details.httpStatus ?? '–')} · ${escapeHtml(run.error.details.upstreamCode)}<br>请求 ${escapeHtml(run.error.details.requestId || '–')} · 尝试 ${escapeHtml(run.error.details.attempt)}</dd></div>` : ''}${run.error?.retryable ? '<div><dt>恢复</dt><dd><button class="btn" id="retryRun">重试失败阶段</button></dd></div>' : ''}`;
  $('#retryRun')?.addEventListener('click', async () => { await api(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }); loadRuns(); });
  $('#runStaging').textContent = run.staging ? JSON.stringify(run.staging, null, 2) : '该运行没有 staging 产物。';
}

$('#runProjectFilter').addEventListener('change', loadRuns);
$('#runStateFilter').addEventListener('change', loadRuns);
$('#btnShowTrigger').addEventListener('click', async () => { $('#triggerForm').classList.toggle('hidden'); if (!$('#triggerForm').classList.contains('hidden')) await loadProjectSelects(); });
$('#btnCancelTrigger').addEventListener('click', () => $('#triggerForm').classList.add('hidden'));
$('#triggerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.simulateFailure = event.target.simulateFailure.checked;
  await api('/api/runs', { method: 'POST', body: data });
  event.target.reset(); $('#triggerForm').classList.add('hidden'); toast('已加入真实维护队列。'); loadRuns();
});

async function loadKnowledge() {
  const epoch = viewEpoch;
  const [projects, payload] = await Promise.all([api('/api/projects'), api(scopedPath('/api/runs'))]);
  if (epoch !== viewEpoch) return;
  const project = scopedProjectId ? projects.projects.find(item => item.projectId === scopedProjectId) : projects.projects[0];
  const runs = scopedProjectId ? payload.runs : payload.runs.filter(run => !project || run.projectId === project.projectId);
  const latest = successfulRun(runs);
  $('#knowledgeProjectName').textContent = project ? project.name : '尚未登记项目';
  $('#knowledgePath').textContent = project?.knowledgePath || '等待 project-knowledge-base 外壳投递 knowledgePath';
  $('#knowledgeLastCommit').textContent = latest ? shortSha(latest.commitSha) : '–';
  $('#knowledgeLastAt').textContent = latest ? `${fmtTime(latest.promotedAt)} · ${latest.staging?.operations?.length || 0} 项已晋升` : '尚无晋升记录';
  $('#knowledgeIndexState').textContent = latest?.indexState === 'succeeded' ? '可检索' : latest ? '待同步' : '等待运行';
  const operations = latest?.staging?.operations || [];
  $('#knowledgeOperationCount').textContent = `${operations.length} 项`;
  $('#knowledgeOperations').innerHTML = operations.map(operation => `<article class="knowledge-operation"><span class="operation-kind">${escapeHtml(operation.operation)}</span><div><strong>${escapeHtml(operation.path)}</strong><small>${escapeHtml(operation.reason)}</small></div><em>${escapeHtml(operation.evidenceReferences?.[0] || '无证据')}</em></article>`).join('') || '<p class="empty">成功运行后，暂存清单会在这里展示知识树将受到的影响。</p>';
}

async function loadProjects() {
  const { projects } = await api('/api/projects');
  $('#projectsBody').innerHTML = projects.map(project => `<tr><td><strong>${escapeHtml(project.name)}</strong><br><span class="mono">${escapeHtml(project.projectId)}</span></td><td class="mono wrap">${escapeHtml(project.repoPath || '–')}</td><td class="mono wrap">${escapeHtml(project.knowledgePath || '–')}</td><td class="mono">${shortSha(project.lastCommitSha)}</td><td><button class="btn danger" data-del="${escapeHtml(project.projectId)}">摘除接线</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">尚无来自外壳的项目接线。</td></tr>';
  $$('[data-del]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm(`摘除项目 ${button.dataset.del} 的引擎接线？知识树与运行历史会保留。`)) return;
    await api(`/api/projects/${encodeURIComponent(button.dataset.del)}`, { method: 'DELETE' });
    if (scopedProjectId === button.dataset.del) scopedProjectId = '';
    loadProjects();
  }));
}

$('#btnShowRegister').addEventListener('click', () => $('#registerForm').classList.toggle('hidden'));
$('#btnCancelRegister').addEventListener('click', () => $('#registerForm').classList.add('hidden'));
$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  await api('/api/projects', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) });
  event.target.reset(); $('#registerForm').classList.add('hidden'); loadProjects();
});

$('#btnSearch').addEventListener('click', async () => {
  const projectId = $('#retrievalProject').value;
  const query = $('#retrievalQuery').value.trim();
  if (!projectId || !query) return toast('先选择项目并输入查询。');
  const { results } = await api('/api/search', { method: 'POST', body: { projectId, query, limit: Number($('#retrievalLimit').value) || 5 } });
  $('#searchBody').innerHTML = results.map(hit => `<tr><td class="mono">${escapeHtml(hit.path)}</td><td>${escapeHtml(hit.title)}</td><td class="score">${hit.score}</td><td class="wrap">${escapeHtml(hit.snippet)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">没有命中的知识文档。</td></tr>';
});
$('#btnAsk').addEventListener('click', async () => {
  const projectId = $('#retrievalProject').value;
  const query = $('#retrievalQuery').value.trim();
  if (!projectId || !query) return toast('先选择项目并输入查询。');
  const result = await api('/api/ask', { method: 'POST', body: { projectId, query } });
  $('#askPanel').classList.remove('hidden');
  $('#askAnswer').textContent = result.answer;
  $('#askCitations').innerHTML = result.citations.map(citation => `<li><span class="mono">${escapeHtml(citation.path)}</span> · ${escapeHtml(citation.title)} · <span class="score">${citation.score}</span></li>`).join('') || '<li>无引用</li>';
});

async function loadEvents() {
  const { events } = await api('/api/events?limit=100');
  const visible = events.filter(event => !scopedProjectId || event.projectId === scopedProjectId);
  $('#eventCursor').textContent = `游标 ${events[0]?.seq || 0}`;
  $('#eventsBody').innerHTML = visible.map(event => `<tr><td class="mono">${event.seq}</td><td>${typeBadge(event.type)}</td><td>${escapeHtml(event.projectId || '–')}</td><td class="wrap">${escapeHtml(event.summary)}</td><td class="mono">${fmtTime(event.at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无事件。</td></tr>';
}
$('#btnInjectEvent').addEventListener('click', async () => { await api('/api/events', { method: 'POST', body: { type: 'commit-boundary', projectId: scopedProjectId || null, summary: '手动注入的测试事件' } }); loadEvents(); });

window.addEventListener('message', async event => {
  if (!embedded || event.source !== parent || event.origin !== parentOrigin || !event.data) return;
  const message = event.data;
  if (message.type === 'kb:theme') document.body.dataset.kbTheme = message.theme === 'dark' ? 'dark' : 'light';
  if (message.type === 'kb:visibility') {
    embedVisible = message.visible === true;
    clearTimeout(runPollTimer);
    if (embedVisible) refreshView(currentView);
  }
  if (message.type === 'kb:select-project') {
    scopedProjectId = message.projectId || ''; selectedRunId = null; viewEpoch++;
    await loadProjectScope(); await refreshView(currentView);
    parent.postMessage({ type: 'kb:project-selected', projectId: scopedProjectId, requestId: message.requestId }, parentOrigin);
  }
  if (message.type === 'kb:refresh') refreshView(currentView);
});
if (embedded) { document.body.dataset.kbTheme = 'light'; parent.postMessage({ type: 'kb:ready', module: 'engine' }, parentOrigin); }
pollHealth();
loadOverview();
setInterval(() => { if (embedVisible && currentView === 'overview') loadOverview(); }, 5000);
