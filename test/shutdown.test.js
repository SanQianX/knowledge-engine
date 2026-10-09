'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createEngineServer } = require('../src/server');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 5000; while (!fn() && Date.now() < deadline) await delay(10); assert.ok(fn(), 'condition must become true'); }

test('shutdown retains its writer lease until an in-flight journal drain settles', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-drain-shutdown-'));
  let release, reading = false;
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = { async registerConsumer() {}, async listJournals() { return [{ journalId: 'global' }]; }, async readEvents() { reading = true; await gate; return []; }, async ackConsumerCursor() {} };
  const runtime = createEngineServer({ dataDir, managed: true, bridge });
  await runtime.ready;
  const draining = runtime.coordinator.drain();
  await until(() => reading);
  let stopped = false;
  const closing = runtime.close().then(() => { stopped = true; });
  try {
    await delay(30);
    assert.equal(stopped, false, 'cannot release ownership while the consumer is still using the store');
    const second = createEngineServer({ dataDir, managed: true });
    await assert.rejects(second.ready, { code: 'ENGINE_ALREADY_RUNNING' });
    await second.close();
  } finally { release(); await draining; await closing; }
  const restarted = createEngineServer({ dataDir, managed: true });
  await restarted.ready; await restarted.close();
});

test('managed CLI shuts down cleanly with real HTTP traffic and an active journal request', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cli-shutdown-'));
  let registrations = 0, pending, release;
  const bridge = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/journals') { res.end('{"journals":[]}'); return; }
    if (req.url === '/api/consumers/register' && ++registrations > 1) { pending = res; release = () => { if (!res.destroyed) res.end('{"ok":true}'); }; return; }
    res.end('{"ok":true}');
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const token = 'test-runtime-no-credential';
  const child = fork(path.resolve(__dirname, '../src/bin.js'), ['serve', '--port', String(port), '--data', dataDir], { windowsHide: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, KB_ENGINE_MANAGED: '1', KB_ENGINE_RUNTIME_TOKEN: token, KB_EVENT_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`, KNOWLEDGE_ENGINE_CONSUME: '0' } });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  try {
    await until(() => output.includes('listening'));
    const base = `http://127.0.0.1:${port}`;
    const control = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{"enabled":true}' });
    assert.equal(control.status, 200); await control.json();
    const notify = await fetch(`${base}/api/bridge/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await notify.json();
    await until(() => pending);
    child.send({ type: 'kb:shutdown' });
    setTimeout(() => release?.(), 100).unref();
    const [code, signal] = await exited;
    assert.equal(code, 0, errors); assert.equal(signal, null);
    assert.ok(!errors.includes('Assertion failed'), errors);
    assert.ok(!fs.existsSync(path.join(dataDir, 'engine-runtime.lock')), 'graceful shutdown releases the writer lease');
  } finally {
    release?.();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve));
  }
});
