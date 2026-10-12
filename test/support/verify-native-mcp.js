'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const core = path.join(process.env.APPDATA, 'npm/node_modules/@sanqianx/project-knowledge');
  const load = createRequire(path.join(core, 'package.json'));
  const { Client } = load('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = load('@modelcontextprotocol/sdk/client/stdio.js');
  const { redactValue } = load('./_site/lib/structured-logger');
  const manifestPath = path.join(os.homedir(), '.codex/plugins/cache/project-knowledge/project-knowledge', load('./package.json').version, '.mcp.json');
  const definition = JSON.parse(fs.readFileSync(manifestPath)).mcpServers['project-knowledge'];
  assert.equal(definition.command, 'npx');
  const output = path.resolve(__dirname, '../../.agent-state/acceptance/existing-v5', 'native-mcp-' + Date.now() + '.json');
  const report = { passed: false, version: load('./package.json').version, manifestPath, command: definition, at: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report));
  const client = new Client({ name: 'native-plugin-mcp-acceptance', version: '1' });
  // Node invokes npm's actual exec implementation with the unchanged manifest
  // arguments. No SDK direct-bin shortcut, fresh-cache override or source root.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [npmCli, 'exec', ...definition.args], env: process.env, stderr: 'pipe' });
  let stderr = '';
  try {
    const connecting = client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    await connecting;
    assert.equal(client.getServerVersion().version, report.version);
    const listed = await client.listTools(); assert.equal(listed.tools.length, 6);
    const call = async (name, input) => {
      const result = await client.callTool({ name: 'project_knowledge_' + name, arguments: input });
      assert.notEqual(result.isError, true); return result.structuredContent || JSON.parse(result.content[0].text);
    };
    const project = await call('resolve', { repoPath: path.resolve(__dirname, '../..') });
    const result = await call('search', { projectId: project.projectId, query: 'c0d2a46', scope: 'project', limit: 1 });
    assert.equal(result.health.index, 'ok'); assert.ok(result.results[0]?.commitSha?.startsWith('c0d2a46'));
    const entry = await call('get', { projectId: project.projectId, entry: result.results[0].entry_id });
    assert.ok(entry.chunks.some(chunk => chunk.chunk_text.includes(result.results[0].commitSha)));
    Object.assign(report, { passed: true, projectId: project.projectId, actualServer: client.getServerVersion(), tools: listed.tools.map(tool => tool.name), citation: { entryId: result.results[0].entry_id, commitSha: result.results[0].commitSha }, stderr, finishedAt: new Date().toISOString() }); save();
    console.log('NATIVE_PLUGIN_MCP_PASSED ' + output);
  } catch (error) { Object.assign(report, { stderr, failure: { code: error.code || '', message: error.message } }); save(); throw error; }
  finally { await client.close().catch(() => {}); }
}
main().catch(error => { console.error('NATIVE_PLUGIN_MCP_FAILED', error.message); process.exitCode = 1; });
