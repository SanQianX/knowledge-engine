'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5757');
  assert.equal(url.hostname, '127.0.0.1');
  const core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const dataDir = path.join(os.homedir(), '.project-knowledge-v5');
  const read = async route => { const res = await fetch(new URL(route, url), { signal: AbortSignal.timeout(20000) }); assert.ok(res.ok, route); return res.json(); };
  const identity = await read('/api/runtime/identity');
  assert.equal(identity.dataDir, dataDir); assert.equal(identity.version, JSON.parse(fs.readFileSync(path.join(core, 'package.json'))).version);
  const repo = path.resolve(__dirname, '../..');
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const before = git(['status', '--porcelain=v1']);
  const project = (await read('/api/projects/aggregated')).projects.find(p => path.resolve(p.workspacePath).toLowerCase() === repo.toLowerCase());
  assert.ok(project);
  const doctor = await read('/api/terminal/system/doctor');
  const cli = doctor.agents['claude-code'].resolvedExecutable;
  const { ProfileStore } = require(path.join(core, 'node_modules/claude-ai-workbench/packages/server/lib/profile-store'));
  const { redactValue } = require(path.join(core, '_site/lib/structured-logger'));
  const profile = new ProfileStore({ dataDir: path.join(dataDir, 'workbench') }).runtimeProfile('minimax');
  const proof = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', 'native-context-' + Date.now()); fs.mkdirSync(proof, { recursive: true });
  const sessionId = crypto.randomUUID(), sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const prompt = '请只读评估这个项目的维护任务恢复、提交归属和运行隔离有哪些约束，以及修改时应该避免什么。不要修改文件，也不要提交。给出简短的开发建议。';
  const requests = [], report = { passed: false, identity, projectId: project.projectId, sessionId, prompt, configuration: 'existing native user plugins; no plugin override, no explicit retrieval reminder, read-only', startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), redactValue(report, { secrets: [profile.apiKey] })); save();
  const proxy = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', b => { if (body.length + b.length > 16 * 1024 * 1024) req.destroy(); else body = Buffer.concat([body, b]); });
    req.on('end', () => {
      if (req.method === 'POST' && /\/v1\/messages(?:\?|$)/.test(req.url)) {
        let parsed = {}; try { parsed = JSON.parse(body); } catch {}
        const texts = []; const walk = v => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(parsed.messages);
        const system = typeof parsed.system === 'string' ? parsed.system : (parsed.system || []).map(p => p.text || '').join('\n');
        requests.push({ number: requests.length + 1, isTitleRequest: !parsed.tools?.length && system.includes('Generate a concise, sentence-case title (3-7 words)'), containsTask: texts.some(t => t.includes(prompt)), containsKnowledge: [...texts, system].some(t => t.includes('<knowledge_context>') && t.includes(project.projectId)), model: parsed.model, toolCount: parsed.tools?.length || 0, bodyHash: crypto.createHash('sha256').update(body).digest('hex') });
      }
      const target = new URL(profile.baseUrl.replace(/\/$/, '') + req.url), headers = { ...req.headers, host: target.host }; delete headers.connection;
      const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); res.on('close', () => upstream.destroy()); upstream.end(body);
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, KB_DATA_DIR: dataDir, ANTHROPIC_AUTH_TOKEN: profile.apiKey, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}` }; delete env.CLAUDECODE; delete env.KB_KNOWLEDGE_CONTEXT;
  const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--permission-mode', 'default', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', profile.models.default];
  const child = spawn(/\.[cm]?js$/i.test(cli) ? process.execPath : cli, /\.[cm]?js$/i.test(cli) ? [cli, ...args] : args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout = (stdout + b).slice(-4 * 1024 * 1024); }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const timer = setTimeout(() => child.kill(), 180000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    Object.assign(report, { code, requests, stderr, events }); save();
    assert.equal(code, 0); assert.ok(events.some(e => e.type === 'result' && !e.is_error));
    const first = requests.find(r => r.containsTask && !r.isTitleRequest); assert.equal(first?.containsKnowledge, true, 'first real development request must contain product context');
    assert.ok(requests.slice(0, requests.indexOf(first)).every(r => r.isTitleRequest));
    const logs = (await read('/api/logs?pageSize=500&event=knowledge.context.prepared')).entries.filter(e => e.projectId === project.projectId && e.context?.sessionHash === sessionHash);
    assert.equal(logs.length, 1); assert.equal(logs[0].context.status, 'ready'); assert.ok(logs[0].context.factCount > 0);
    assert.equal(git(['status', '--porcelain=v1']), before, 'read-only native task preserves user worktree');
    Object.assign(report, { passed: true, operationId: logs[0].operationId, context: logs[0].context, unchangedWorktree: true, finishedAt: new Date().toISOString() }); save(); console.log('EXISTING_NATIVE_CONTEXT_PASSED ' + proof);
  } catch (error) { report.failure = error.message; save(); throw error; }
  finally { clearTimeout(timer); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
}
main().catch(error => { console.error(error.code || 'EXISTING_NATIVE_CONTEXT_FAILED', error.message); process.exitCode = 1; });
