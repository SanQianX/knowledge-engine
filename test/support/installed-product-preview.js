'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');
let ownedShell;
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function main() {
  const reportFile = path.resolve(process.argv[2]); const installation = JSON.parse(fs.readFileSync(reportFile));
  assert.ok(installation.integrityPassed && ['project-knowledge/installed-candidates/v1', 'project-knowledge/installed-registry/v1'].includes(installation.schema));
  assert.equal(path.dirname(installation.installedRoot), path.resolve(os.tmpdir()));
  assert.ok(/^(kb-installed-product-|kb-registry-product-)/.test(path.basename(installation.installedRoot)));
  const root = path.join(installation.installedRoot, 'acceptance-data');
  fs.mkdirSync(root, { recursive: true });
  const claudeFixture = process.argv.includes('--verify-claude') ? path.join(root, 'Claude 入口验收', 'cli.cjs') : null;
  if (claudeFixture) {
    AtomicFile.writeFileAtomic(claudeFixture, "require('./removed-cli.js')\n");
    process.env.CLAUDE_CODE_EXECPATH = claudeFixture;
  }
  const [terminal, vector, events, engine] = await Promise.all(Array.from({ length: 4 }, freePort));
  Object.assign(process.env, {
    KB_DATA_DIR: path.join(root, 'shell'), KB_MODULES_AUTOSTART: '1', KB_MODULES_REGISTER: '1',
    AGENT_TERMINAL_DATA_DIR: path.join(root, 'workbench'), AI_CODING_EVENT_BRIDGE_HOME: path.join(root, 'events'),
    VECTOR_HUB_CONFIG: path.join(root, 'vector-config.json'), VECTOR_HUB_DISABLE_PICKER: '1', KB_WORKBENCH_DISABLE_PICKER: '1',
    VECTOR_HUB_LEGACY_CONFIG: path.join(root, 'unused-legacy-config.json'),
    KB_TERMINAL_URL: `http://127.0.0.1:${terminal}`, KB_VECTORHUB_URL: `http://127.0.0.1:${vector}`,
    KB_EVENTBRIDGE_URL: `http://127.0.0.1:${events}`, KB_KNOWLEDGE_ENGINE_URL: `http://127.0.0.1:${engine}`,
    MINIMAX_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', NODE_PATH: '',
  });
  delete process.env.AI_CODING_EVENT_BRIDGE_MODULE;
  const { startServer } = require(path.join(installation.core, '_site/lib/server-app'));
  const shellPort = process.env.KB_INSTALLED_ACCEPTANCE_PORT === '0' ? await freePort() : Number(process.env.KB_INSTALLED_ACCEPTANCE_PORT || 5803);
  const shell = await startServer({ rootDir: installation.core, dataDir: path.join(root, 'shell'), port: shellPort, host: '127.0.0.1' });
  ownedShell = shell;
  const url = `http://127.0.0.1:${shell.port}`;
  const read = async route => { const response = await fetch(new URL(route, url)); assert.ok(response.ok, route); return response; };
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !Object.values((await (await read('/api/modules/health')).json()).modules).every(module => module.up)) await new Promise(resolve => setTimeout(resolve, 200));
  const health = (await (await read('/api/modules/health')).json()).modules;
  assert.ok(Object.values(health).every(module => module.up), 'all four installed services must start');
  // A listening child is not yet proof that authentication and consumption are ready.
  const configuredAtStartup = await fetch(url + '/api/modules/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(configuredAtStartup.ok); await configuredAtStartup.json();
  while (Date.now() < deadline && !(await (await read('/api/modules/health')).json()).ownership.ready) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await (await read('/api/modules/health')).json()).ownership.ready, true, 'the engine must be authenticated and activated, not merely listening');
  const content = await (await read('/')).text(); assert.ok(content.includes('src="/product.js"') && !content.includes('srcdoc'));
  for (const route of ['/modules/terminal/agent-terminal/app.js', '/modules/terminal/agent-terminal/app.css', '/modules/vectorhub/', '/modules/eventbridge/', '/modules/engine/']) await read(route);
  const snapshot = await (await read('/api/engine/snapshot')).json();
  if (!process.argv.includes('--existing-data')) { assert.equal(snapshot.projects.length, 0); assert.equal(snapshot.runs.length, 0); }
  await shell.runtime.moduleBridge.syncEngineConfiguration();
  const progress = { schema: 'project-knowledge/installed-startup/v1', installationSource: installation.schema, mode: 'real installed modules; no Agent request during startup', url, installedRoot: installation.installedRoot, core: installation.core, integrityPassed: true, modules: Object.fromEntries(Object.entries(health).map(([key, value]) => [key, { up: value.up, url: value.url }])), emptyState: snapshot.projects.length === 0 && snapshot.runs.length === 0, registeredProjects: snapshot.projects.length, checkedAt: new Date().toISOString(), pid: process.pid };
  AtomicFile.writeJsonAtomic(path.join(root, 'installed-startup-acceptance.json'), progress);
  process.stdout.write(`INSTALLED_PRODUCT_READY ${url}\n`);
  if (claudeFixture) {
    const agents = await (await read('/api/terminal/agents')).json();
    const claude = agents.agents.find(agent => agent.id === 'claude-code');
    assert.equal(claude.available, false); assert.match(claude.reason, /Cannot find module/);
    const failedDoctor = await (await read('/api/terminal/system/doctor')).json();
    assert.equal(failedDoctor.agents['claude-code'].resolvedExecutable, claudeFixture);
    assert.equal(failedDoctor.agents['claude-code'].versionProbe.ok, false);
    await shell.runtime.logger.flush();
    const records = (await (await read('/api/logs?q=agent.discovery.failed')).json()).entries;
    assert.ok(records.some(record => record.component === 'claude-ai-workbench' && record.error.message.includes('Cannot find module')));
    const directory = path.join(root, 'shell', 'logs', 'system');
    assert.ok(fs.readdirSync(directory).some(name => fs.readFileSync(path.join(directory, name), 'utf8').includes('agent.discovery.failed')), 'supervised module error must be durable on disk');
    AtomicFile.writeFileAtomic(claudeFixture, "console.log('Claude Code 2.1.99 regression fixture')\n");
    const recovered = await (await read('/api/terminal/system/doctor')).json();
    assert.equal(recovered.agents['claude-code'].versionProbe.ok, true);
    assert.equal(recovered.agents['claude-code'].versionProbe.version, '2.1.99');
    AtomicFile.writeJsonAtomic(path.join(root, 'installed-claude-diagnostics-acceptance.json'), { passed: true, moduleVersion: installation.modules.terminal.version, resolvedExecutable: claudeFixture, brokenEntryReported: true, durableProductLog: true, realNodeVersionProbe: true, agentCalls: 'none; CLI fixture only', checkedAt: new Date().toISOString() });
    process.stdout.write('INSTALLED_CLAUDE_DIAGNOSTICS_PASSED (real supervised module, IPC, HTTP, disk and Node; CLI fixture)\n');
  }
  if (process.argv.includes('--verify-restart')) {
    const originalChildren = [...shell.runtime.moduleBridge.supervised];
    assert.equal(originalChildren.length, 4, 'restart verification owns only its isolated module processes');
    const specs = shell.runtime.moduleBridge._supervisedSpecs();
    const restarts = [];
    for (const [index, original] of originalChildren.entries()) {
      const name = specs[index].name;
      const healthUrl = specs[index].url + (name === 'terminal' ? '/api/claude-workbench/v1/health' : '/api/health');
      assert.ok(original.pid && original.exitCode === null);
      original.kill();
      const deadline = Date.now() + 20000;
      let replacement;
      while (Date.now() < deadline) {
        replacement = shell.runtime.moduleBridge.supervised.find(child => child.pid !== original.pid && JSON.stringify(child.spawnargs) === JSON.stringify(original.spawnargs));
        if (replacement) {
          try { const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(replacement && replacement.pid !== original.pid && replacement.exitCode === null, `${name} must restart once under its supervisor`);
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) }); assert.ok(response.ok, `${name} health after restart`); await response.json();
      restarts.push({ name, exitedPid: original.pid, recoveredPid: replacement.pid });
    }
    const configured = await fetch(url + '/api/modules/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.ok(configured.ok); await configured.json();
    const restored = await (await read('/api/engine/snapshot')).json();
    assert.deepEqual(restored.projects.map(p => p.projectId).sort(), snapshot.projects.map(p => p.projectId).sort());
    assert.equal(restored.runs.length, snapshot.runs.length, 'service recovery does not duplicate maintenance');
    const engineHealth = await (await read('/api/engine/health')).json(); assert.equal(engineHealth.executionEnabled, true); assert.equal(engineHealth.journal.enabled, true);
    AtomicFile.writeJsonAtomic(path.join(root, 'installed-restart-acceptance.json'), { passed: true, restarts, projectIds: restored.projects.map(p => p.projectId), runs: restored.runs.length, checkedAt: new Date().toISOString() });
    process.stdout.write('INSTALLED_FOUR_MODULE_RESTART_PASSED\n');
  }
  if (process.argv.includes('--verify-shutdown') || process.argv.includes('--verify-cli-stop')) {
    const children = [...shell.runtime.moduleBridge.supervised];
    assert.equal(children.length, 4, 'verification must own all four module processes');
    if (process.argv.includes('--verify-cli-stop')) {
      const { spawn } = require('node:child_process');
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(installation.core, 'bin/project-knowledge.js'), 'STOP', '--port', String(shell.port)], { cwd: os.tmpdir(), env: { ...process.env, KB_DATA_DIR: path.join(root, 'different-selected-data') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Installed CLI stop timed out')); }, 50000);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      assert.equal(result.code, 0, result.stderr); assert.ok(result.stdout.includes(`:${shell.port}`));
      process.stdout.write('INSTALLED_UPPERCASE_TARGETED_CLI_STOP_PASSED\n');
    } else await shell.stop('installed-shutdown-verification');
    const processExits = children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
    assert.ok(processExits.every(child => child.exitCode === 0 && child.signal === null), `owned services must exit normally: ${JSON.stringify(processExits)}`);
    for (const module of Object.values(health)) {
      let up = true;
      const deadline = Date.now() + 7000;
      while (up && Date.now() < deadline) { try { await fetch(module.url + '/api/health', { signal: AbortSignal.timeout(500) }); } catch { up = false; } if (up) await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.equal(up, false, 'owned module process must exit with the shell');
    }
    AtomicFile.writeJsonAtomic(path.join(root, 'installed-shutdown-acceptance.json'), { passed: true, processExits, moduleUrls: Object.values(health).map(module => module.url), checkedAt: new Date().toISOString() });
    process.stdout.write('INSTALLED_GRACEFUL_SHUTDOWN_PASSED\n'); return;
  }
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await shell.stop('installed-acceptance-stop'); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdin.on('data', input => { if (String(input).trim() === 'stop') stop(); });
}
main().catch(async error => { process.stderr.write(`${error.code || 'INSTALLED_ACCEPTANCE_FAILED'}: ${error.message}\n`); await ownedShell?.stop('installed-acceptance-failed'); process.exit(1); });
