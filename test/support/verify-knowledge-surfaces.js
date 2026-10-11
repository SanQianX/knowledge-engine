'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  const override = process.argv.indexOf('--core-root');
  const core = override < 0 ? environment.runtimeRoots.shell : path.resolve(process.argv[override + 1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json')));
  const runtimeModule = require(path.join(core, '_site/lib/knowledge-tool-runtime'));
  const runtime = new runtimeModule.KnowledgeToolRuntime({ dataDir: path.join(environment.root, 'shell') });
  const project = runtime.resolveProject({ repoPath: environment.repositories[0] });
  const brain = await (await fetch(new URL('/api/brain', environment.url))).json();
  const activeIndexPath = brain.configuration?.indexStorage?.actualPath;
  assert.ok(activeIndexPath && brain.configuration.indexStorage.status === 'ready');
  const api = async (action, input) => {
    const response = await fetch(new URL(`/api/engine/${action}`, environment.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.projectId, ...input }) });
    assert.equal(response.status, 200); return response.json();
  };
  const runs = await (await fetch(new URL('/api/engine/runs', environment.url))).json();
  const run = runs.runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
  assert.ok(run?.commitSha, 'real promoted commit is required');
  const env = { ...process.env, KB_DATA_DIR: path.join(environment.root, 'shell'), KB_KNOWLEDGE_ENGINE_URL: '', NODE_PATH: '' };
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(core, 'bin/project-knowledge-kb.js'), ...args, '--project', project.projectId, '--json'], { env, windowsHide: true });
    let out = '', err = ''; child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
    child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (error) { reject(error); } });
  });
  const load = createRequire(path.join(core, 'package.json'));
  const { Client } = load('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = load('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'installed-surface-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(core, 'bin/project-knowledge-mcp.js')], env, stderr: 'pipe' });
  const normalized = result => ({ backend: result.backend, results: (result.results || []).map(r => ({ projectId: r.scope_project_id, entryId: r.entry_id, commitSha: r.commitSha, contentHash: crypto.createHash('sha256').update(r.chunk_text).digest('hex') })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  const proof = { version: pkg.version, core, mode: override < 0 ? 'installed npm runtime' : 'source read adapter against installed services', projectId: project.projectId, commitSha: run.commitSha, cases: [], at: new Date().toISOString() };
  try {
    await client.connect(transport);
    const mcp = async (action, input) => {
      const result = await client.callTool({ name: `project_knowledge_${action}`, arguments: { projectId: project.projectId, ...input } });
      assert.ok(!result.isError, result.content[0]?.text); return JSON.parse(result.content[0].text);
    };
    const resolutions = [project, await mcp('resolve', {})];
    assert.ok(resolutions.every(result => result.indexPath === activeIndexPath), 'UI, runtime and MCP must agree on the active vector directory');
    proof.resolution = { activeIndexPath, surfaces: ['runtime', 'MCP'], passed: true };
    for (const scope of ['project', 'domain', 'brain']) {
      const input = { query: run.commitSha, scope, limit: 8 };
      const web = await api('search', input);
      assert.equal(web.health.index, 'ok', 'not text fallback or an empty vector index');
      assert.ok(web.results.length && web.results.every(r => r.commitSha === run.commitSha));
      for (const [surface, result] of [['runtime', await runtime.search({ projectId: project.projectId, ...input })], ['CLI', await cli(['search', '--query', run.commitSha, '--scope', scope, '--limit', '8'])], ['MCP', await mcp('search', input)]]) {
        assert.deepEqual(normalized(result), normalized(web), `${surface} ${scope} facts and provenance must match the UI`);
        proof.cases.push({ surface, scope, passed: true, ...normalized(result) });
      }
    }
    const ask = await api('ask', { query: run.commitSha });
    for (const result of [await cli(['ask', '--query', run.commitSha]), await mcp('ask', { query: run.commitSha })]) {
      assert.deepEqual(result.citations, ask.citations); assert.equal(result.answer, ask.answer);
    }
    const entry = ask.citations[0].entryId;
    const get = await api('get', { entry });
    for (const result of [await cli(['get', '--entry', entry, '--space', `project:${project.projectId}`]), await mcp('get', { entry, space: `project:${project.projectId}` })]) assert.deepEqual(result, get);
    const history = await api('history', {});
    for (const result of [await cli(['history']), await mcp('history', {})]) assert.deepEqual(result, history);
    proof.otherReads = ['ask citations and answer', 'get file bytes and space alias', 'history ordering']; proof.passed = true;
    const file = path.join(environment.root, `knowledge-surfaces-${Date.now()}.json`); AtomicFile.writeJsonAtomic(file, proof);
    process.stdout.write(`KNOWLEDGE_SURFACES_PASSED ${file}\n`);
  } catch (error) {
    proof.passed = false; proof.failure = error.message; AtomicFile.writeJsonAtomic(path.join(environment.root, `knowledge-surfaces-failed-${Date.now()}.json`), proof); throw error;
  } finally { await client.close(); await runtime.close(); }
}
main().catch(error => { process.stderr.write(`${error.code || 'SURFACES_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
