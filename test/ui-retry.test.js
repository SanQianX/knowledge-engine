'use strict';

// Real-logic UI regression for the retry surface of ui/app.js, executed under
// node:test via test/support/engine-ui-dom.js (no browser): the actual
// ui/app.js source is loaded and its own handlers run against a controlled
// fetch router. Covers the P-ENGINE-REVIEW-R3 contract:
//   1) 同一意图不会重复派发 — double click on the same button dispatches once.
//   2) 重渲染/切回后仍防重 — loadRuns()/showRunDetail() rebuild the button;
//      the in-flight guard must be stable per runId, not per DOM element.
//      Includes the 800ms poll re-render path (响应超过800ms轮询).
//   3) API 明确拒绝后可恢复重试 — a 409 releases the lock (no permanent
//      lockout) and a subsequent click dispatches again.
//   4) 请求结果未知先查询 — TypeError (connection refused) and BAD_JSON
//      (truncated response) both query the run FIRST and never re-dispatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createUiWorld, flush } = require('./support/engine-ui-dom.js');

const APP_SOURCE = process.env.KB_UI_APP_SOURCE || path.join(__dirname, '..', 'ui', 'app.js');

const failedRun = (runId, commitSha) => ({
  runId, projectId: 'project-ui', commitSha, trigger: 'git-hook', state: 'failed', phase: 'promoting',
  indexState: 'succeeded', startedAt: '2026-10-23T10:00:00Z', durationMs: 1200,
  error: { code: 'DEBUG_SIMULATED_FAILURE', message: '调试模拟失败', retryable: true },
});
const succeededRun = run => ({ ...run, state: 'succeeded', phase: 'ready', error: undefined, promotedAt: '2026-10-23T10:01:00Z', durationMs: 2400 });

async function bootWorld(runsState) {
  const world = createUiWorld({ appSource: APP_SOURCE });
  world.state = runsState;
  world.route('GET', /^\/api\/health$/, () => ({ status: 200, body: { ok: true, debug: true, version: '0.0.0-ui-test', journal: { enabled: false, cursor: 0, cursors: {}, error: null, consumer: 'test' }, uptimeSec: 1, dataDir: '/tmp' } }));
  world.route('GET', /^\/api\/projects(\?.*)?$/, () => ({ status: 200, body: { ok: true, projects: [] } }));
  world.route('GET', /^\/api\/events/, () => ({ status: 200, body: { ok: true, events: [] } }));
  world.route('GET', /^\/api\/runs(\?.*)?$/, () => ({ status: 200, body: { ok: true, runs: world.state.runs } }));
  world.route('GET', /^\/api\/runs\/[^/]+$/, call => {
    const runId = call.url.split('/').pop();
    const run = world.state.runs.find(entry => entry.runId === runId);
    return { status: 200, body: { ok: true, run: run || failedRun(runId, '0000000000000000000000000000000000000000') } };
  });
  await flush(20); // settle the initial overview load
  world.clickNav('runs');
  await flush(20);
  return world;
}

const retryPosts = world => world.calls.filter(call => call.method === 'POST' && /\/api\/runs\/[^/]+\/retry$/.test(call.url));
const currentRetryButton = world => world.document.querySelectorAll('#retryRun')[0] || null;
const rowFor = (world, runId) => world.document.querySelectorAll('[data-run]').find(element => element.dataset.run === runId);

async function openRun(world, runId) {
  const row = rowFor(world, runId);
  assert.ok(row, `run row rendered for ${runId}`);
  row.dispatch('click');
  await flush(20);
  return currentRetryButton(world);
}

test('同一按钮双击只派发一次重试意图', async () => {
  const world = await bootWorld({ runs: [failedRun('run-A', 'aaaa000000000000000000000000000000000000')] });
  try {
    const button = await openRun(world, 'run-A');
    assert.ok(button, 'retry button rendered for the failed run');
    assert.equal(button.disabled, false, 'button starts enabled');

    let releasePost;
    const gate = new Promise(resolve => { releasePost = resolve; });
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, () => gate);

    button.click(); // first native click of a double click
    await flush();
    assert.equal(retryPosts(world).length, 1, 'first click dispatches the retry POST');
    assert.equal(button.disabled, true, 'button disables in flight');

    button.click(); // second click of the double click lands on the disabled button
    await flush();
    assert.equal(retryPosts(world).length, 1, 'the disabled button cannot re-dispatch');

    button.dispatch('click'); // raw dispatch pins the JS-level guard behind the disabled attr
    await flush();
    assert.equal(retryPosts(world).length, 1, 'the per-runId in-flight guard blocks re-dispatch');

    releasePost({ status: 200, body: { ok: true } });
    await flush(20);
    assert.equal(retryPosts(world).length, 1, 'exactly one retry POST for the whole double click');
  } finally { world.dispose(); }
});

test('detail 重绘与切回后同一在途意图仍只派发一次', async () => {
  const world = await bootWorld({ runs: [
    failedRun('run-A', 'aaaa000000000000000000000000000000000000'),
    failedRun('run-B', 'bbbb000000000000000000000000000000000000'),
  ] });
  try {
    const button1 = await openRun(world, 'run-A');
    assert.ok(button1);

    let releasePost;
    const gate = new Promise(resolve => { releasePost = resolve; });
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, () => gate);
    button1.click();
    await flush();
    assert.equal(retryPosts(world).length, 1, 'retry intent in flight');

    // Switch to another failed run while the intent is in flight.
    const buttonB = await openRun(world, 'run-B');
    assert.ok(buttonB, 'the other failed run renders its own retry button');
    assert.notEqual(buttonB, button1, 'the button element was rebuilt by the re-render');
    assert.equal(buttonB.disabled, false, 'an unrelated run is NOT blocked (no over-blocking)');

    // Switch back to the in-flight run: a NEW button exists for the SAME intent.
    const buttonA2 = await openRun(world, 'run-A');
    assert.ok(buttonA2);
    assert.notEqual(buttonA2, button1, 'switching back rebuilt the button');
    assert.equal(buttonA2.disabled, true, 'the rebuilt button reflects the per-runId in-flight state');

    buttonA2.dispatch('click'); // even a forced click on the rebuilt button must not re-dispatch
    await flush();
    assert.equal(retryPosts(world).length, 1, 'the stable per-runId guard survives the re-render');

    releasePost({ status: 200, body: { ok: true } });
    world.state.runs = world.state.runs.map(run => run.runId === 'run-A' ? succeededRun(run) : run);
    await flush(20);
    assert.equal(retryPosts(world).length, 1, 'still exactly one retry POST end to end');
    assert.equal(currentRetryButton(world), null, 'the succeeded run no longer renders a retry button');
  } finally { world.dispose(); }
});

test('响应超过800ms时轮询重绘后仍只派发一次', async () => {
  const world = await bootWorld({ runs: [
    failedRun('run-A', 'aaaa000000000000000000000000000000000000'),
    { ...failedRun('run-B', 'bbbb000000000000000000000000000000000000'), state: 'running' },
  ] });
  try {
    const detailCallsBefore = world.calls.filter(call => call.method === 'GET' && call.url === '/api/runs/run-A').length;
    const button1 = await openRun(world, 'run-A');
    assert.ok(button1);

    let releasePost;
    const gate = new Promise(resolve => { releasePost = resolve; });
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, () => gate);
    button1.click();
    await flush();
    assert.equal(retryPosts(world).length, 1);

    // The runs view polls every 800ms while any run is queued/running; with the
    // retry response held, the engine still reports run-A as failed, so every
    // poll re-renders a FRESH retry button for the SAME in-flight intent.
    await new Promise(resolve => setTimeout(resolve, 1000));
    await flush(20);
    const detailCallsAfter = world.calls.filter(call => call.method === 'GET' && call.url === '/api/runs/run-A').length;
    assert.ok(detailCallsAfter > detailCallsBefore + 1, `the 800ms poll really re-rendered the detail (detail calls ${detailCallsBefore} -> ${detailCallsAfter})`);

    const polledButton = currentRetryButton(world);
    assert.ok(polledButton, 'the poll re-rendered the retry button');
    assert.notEqual(polledButton, button1, 'the poll rebuilt the button element');
    assert.equal(polledButton.disabled, true, 'the polled rebuilt button reflects the in-flight state');

    polledButton.dispatch('click');
    await flush();
    assert.equal(retryPosts(world).length, 1, 'a click on the polled rebuilt button does not re-dispatch');

    releasePost({ status: 200, body: { ok: true } });
    world.state.runs = world.state.runs.map(run => run.runId === 'run-A' ? succeededRun(run) : run);
    await flush(20);
    assert.equal(retryPosts(world).length, 1);
  } finally { world.dispose(); }
});

test('API 明确拒绝(409)后锁释放且可再次重试', async () => {
  const world = await bootWorld({ runs: [failedRun('run-A', 'aaaa000000000000000000000000000000000000')] });
  try {
    let attempts = 0;
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, () => {
      attempts += 1;
      if (attempts === 1) return { status: 409, body: { ok: false, error: 'RUN_NOT_RETRYABLE', message: '该运行当前不可重试' } };
      world.state.runs = world.state.runs.map(run => run.runId === 'run-A' ? succeededRun(run) : run);
      return { status: 200, body: { ok: true } };
    });

    const button1 = await openRun(world, 'run-A');
    button1.click();
    await flush(20);
    assert.equal(retryPosts(world).length, 1, 'the rejected attempt really was dispatched');
    const { text, shown } = world.toastState();
    assert.equal(shown, true, 'the explicit rejection is surfaced to the user');
    assert.equal(text, '该运行当前不可重试');

    const button2 = await openRun(world, 'run-A'); // re-select re-renders the detail
    assert.notEqual(button2, button1);
    assert.equal(button2.disabled, false, 'an explicit API rejection must NOT leave the retry locked');

    button2.click();
    await flush(20);
    assert.equal(retryPosts(world).length, 2, 'retry recovers after the explicit rejection');
    assert.equal(currentRetryButton(world), null, 'the succeeded run no longer renders a retry button');
  } finally { world.dispose(); }
});

test('连接拒绝(TypeError)时先查询运行状态且不重复派发', async () => {
  const world = await bootWorld({ runs: [failedRun('run-A', 'aaaa000000000000000000000000000000000000')] });
  try {
    const button = await openRun(world, 'run-A');
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, call => {
      call.rejectWith(new world.TypeError('Failed to fetch'));
      return null; // already settled
    });
    button.click();
    await flush(20);

    assert.equal(retryPosts(world).length, 1, 'exactly one retry POST was dispatched');
    const post = retryPosts(world)[0];
    const afterPost = world.calls.filter(call => call.seq > post.seq && call.url.startsWith('/api/'));
    assert.ok(afterPost.length >= 1, 'the client acts after the unknown result');
    assert.equal(afterPost[0].method, 'GET', 'the FIRST API call after the unknown result is a query');
    assert.equal(afterPost[0].url, '/api/runs/run-A', 'the query targets the specific run');
    assert.equal(retryPosts(world).length, 1, 'the unknown result never triggers a re-dispatch');
    const toast = world.toastState();
    assert.equal(toast.shown, true);
    assert.equal(toast.text, '重试结果未知，正在查询运行状态…');

    const refreshed = await openRun(world, 'run-A'); // query shows still failed -> retry stays available
    assert.equal(refreshed.disabled, false, 'the unknown result must not permanently lock the run');
  } finally { world.dispose(); }
});

test('截断响应(BAD_JSON)时先查询运行状态且不重复派发', async () => {
  const world = await bootWorld({ runs: [failedRun('run-A', 'aaaa000000000000000000000000000000000000')] });
  try {
    const button = await openRun(world, 'run-A');
    world.route('POST', /\/api\/runs\/[^/]+\/retry$/, () => ({ status: 200, badJson: true, body: null }));
    button.click();
    await flush(20);

    assert.equal(retryPosts(world).length, 1);
    const post = retryPosts(world)[0];
    const afterPost = world.calls.filter(call => call.seq > post.seq && call.url.startsWith('/api/'));
    assert.equal(afterPost[0].method, 'GET', 'query first after the truncated response');
    assert.equal(afterPost[0].url, '/api/runs/run-A', 'the query targets the specific run');
    assert.equal(retryPosts(world).length, 1, 'no re-dispatch after the truncated response');
    assert.equal(world.toastState().text, '重试结果未知，正在查询运行状态…');
  } finally { world.dispose(); }
});
