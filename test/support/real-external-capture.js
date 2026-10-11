'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(environment.model.startsWith('real Agent and real embeddings'));
  const core = environment.runtimeRoots.shell;
  const { IntegrationManager } = require(path.join(core, '_site/lib/integration-installer'));
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const { ProfileStore } = require(path.join(environment.runtimeRoots.workbench, 'packages/server/lib/profile-store'));
  const profile = new ProfileStore({ dataDir: path.join(environment.root, 'workbench') }).runtimeProfile('acceptance-model');
  const read = async route => { const response = await fetch(new URL(route, environment.url), { signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, route); return response.json(); };
  const project = (await read('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
  const run = (await read('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
  assert.ok(run?.commitSha);
  const doctor = await read('/api/terminal/system/doctor');
  const cli = doctor.agents['claude-code'].resolvedExecutable;
  assert.ok(doctor.agents['claude-code'].versionProbe.ok && path.isAbsolute(cli));
  const sessionId = crypto.randomUUID();
  const directory = path.join(environment.root, `external-cli-${sessionId}`);
  const settingsFile = path.join(directory, 'settings.json');
  const manager = new IntegrationManager({ rootDir: core, homeDir: directory, env: {}, bridgeHomeDir: path.join(environment.root, 'events'), claudeSettingsFile: settingsFile });
  const installed = await manager.installCaptureClaude(); assert.ok(installed.installed && !installed.conflict);
  const command = `node ${JSON.stringify(path.join(core, 'bin/project-knowledge-kb.js').replace(/\\/g, '/'))} search --project ${project.projectId} --query ${run.commitSha} --scope project --json`;
  const prompt = `这是外部 CLI（非工作台）的只读采集验收。请实际执行 ${command}，从工具结果引用完整提交号与知识条目，最后回答 EXTERNAL_CAPTURE_OK。不得写文件、提交、读取凭据或调用其他服务。`;
  const report = { passed: false, method: 'actual discovered Claude Code CLI outside Workbench, installed capture hooks, real MiniMax, project journal', version: require(path.join(core, 'package.json')).version, sessionId, cli, cliVersion: doctor.agents['claude-code'].versionProbe.version, projectId: project.projectId, commitSha: run.commitSha, rawPrompt: prompt, startedAt: new Date().toISOString() };
  const output = path.join(environment.root, `real-external-capture-${Date.now()}.json`);
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report, { secrets: [profile.apiKey] })); save();
  const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose', '--settings', settingsFile, '--session-id', sessionId, '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', profile.models.default];
  let stdout = '', stderr = '';
  const child = spawn(/\.[cm]?js$/i.test(cli) ? process.execPath : cli, /\.[cm]?js$/i.test(cli) ? [cli, ...args] : args, { cwd: project.workspacePath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: directory, ANTHROPIC_AUTH_TOKEN: profile.apiKey, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: profile.baseUrl, KB_DATA_DIR: path.join(environment.root, 'shell'), KB_KNOWLEDGE_ENGINE_URL: environment.modules.engine, NODE_PATH: '' } });
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8 * 1024 * 1024); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-12000); });
  const timer = setTimeout(() => child.kill(), 240000);
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    report.exitCode = exitCode; report.stderr = stderr;
    const events = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { type: 'text', text: line }; } });
    report.cliEvents = events; save(); assert.equal(exitCode, 0, 'real external CLI must complete');
    const result = events.findLast(item => item.type === 'result');
    assert.ok(result && !result.is_error && result.result.includes('EXTERNAL_CAPTURE_OK') && result.result.includes(run.commitSha));
    const eventText = JSON.stringify(events);
    assert.ok(eventText.includes('tool_use') && eventText.includes('project-knowledge-kb.js') && eventText.includes('hybrid+markdown-truth'), 'native CLI must actually retrieve knowledge');
    const { projectRegistry } = require(path.join(environment.runtimeRoots.events, 'src/bridge'));
    const journal = projectRegistry.listProjects(path.join(environment.root, 'events')).find(item => path.resolve(item.path).toLowerCase() === path.resolve(project.workspacePath).toLowerCase());
    assert.ok(journal?.store);
    const journalFile = path.join(journal.store, 'journal/events.jsonl');
    const captured = fs.readFileSync(journalFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(item => item.sessionId === sessionId);
    assert.ok(captured.some(item => item.type === 'user' && item.content === prompt), 'native UserPromptSubmit must preserve exact original prompt');
    assert.ok(captured.some(item => item.type === 'assistant' && item.content.includes('EXTERNAL_CAPTURE_OK')), 'native Stop must capture actual final answer');
    assert.ok(captured.every(item => item.source === 'claude-code'));
    Object.assign(report, { passed: true, journalFile, captured, finishedAt: new Date().toISOString() }); save();
    console.log(`REAL_EXTERNAL_CAPTURE_PASSED ${output}`);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { clearTimeout(timer); }
}
main().catch(error => { console.error(`${error.code || 'EXTERNAL_CAPTURE_FAILED'}: ${error.message}`); process.exitCode = 1; });
