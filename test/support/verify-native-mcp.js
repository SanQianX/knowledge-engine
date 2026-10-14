'use strict';
// Acceptance support: the real Codex plugin manifest for the actually installed
// global npm package must launch project-knowledge MCP exactly as declared -
// no direct-bin, source-tree or plugin-root shortcuts, no skipped checks.
// Native Codex hooks/mcpServerStatus acceptance stays in real-codex-automatic-context.js.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const AtomicFile = require('../../src/runtime/atomic-file');

const PACKAGE_NAME = '@sanqianx/project-knowledge';
const SERVER_KEY = 'project-knowledge';
// The offline local-node launcher ships from 5.0.16-rc.1; earlier plugin
// caches only ever held the original npx manifest.
const NODE_LOCAL_FLOOR = '5.0.16-rc.1';
const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 20000;
const OUTPUT_DIR = path.resolve(__dirname, '../../.agent-state/acceptance/glm-plan-5.0.16/N1');
const KNOWN_FAILURE_CODES = ['USAGE', 'ENV_APPDATA_REQUIRED', 'GLOBAL_PACKAGE_MISSING', 'OFFICIAL_MANIFEST_UNAVAILABLE', 'PLUGIN_MANIFEST_MISSING', 'MANIFEST_INVALID_JSON', 'MANIFEST_INVALID', 'MANIFEST_ARGS_INVALID', 'MANIFEST_ENV_INVALID', 'NODE_LOCAL_COMMAND_EXPECTED', 'NODE_LOCAL_ARGS_INVALID', 'LEGACY_NPX_COMMAND_EXPECTED', 'LEGACY_MANIFEST_NOT_ORIGINAL', 'MANIFEST_CONTENT_MISMATCH', 'CONNECT_TIMEOUT', 'LIST_TOOLS_TIMEOUT', 'CALL_TIMEOUT', 'SERVER_VERSION_MISMATCH', 'TOOL_COUNT_MISMATCH', 'TOOL_CALL_ERROR', 'RESOLVE_NO_PROJECT', 'HEALTH_NOT_OK', 'SEARCH_NO_CURRENT_RESULT', 'GET_REFERENCE_MISMATCH', 'UNEXPECTED'];
const originalNpxArgs = version => ['-y', '--package', PACKAGE_NAME + '@' + version, SERVER_KEY + '-mcp'];

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version));
  if (!match) return null;
  return { core: [+match[1], +match[2], +match[3]], pre: match[4] ? match[4].split('.') : [] };
}

function semverCompare(left, right) {
  const a = parseSemver(left), b = parseSemver(right);
  if (!a || !b) return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const classifyContract = version => (semverCompare(version, NODE_LOCAL_FLOOR) >= 0 ? 'node-local' : 'legacy-npx');

const pluginManifestPath = (homeDir, version, cacheRoot) => path.join(cacheRoot || path.join(homeDir, '.codex', 'plugins', 'cache', SERVER_KEY, SERVER_KEY), version, '.mcp.json');

function validateManifest(definition, version) {
  const contract = classifyContract(version);
  const reject = code => ({ ok: false, code, contract });
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return reject('MANIFEST_INVALID');
  if (definition.type !== undefined && definition.type !== 'stdio') return reject('MANIFEST_INVALID');
  if (!Array.isArray(definition.args) || definition.args.some(arg => typeof arg !== 'string')) return reject('MANIFEST_ARGS_INVALID');
  if (definition.env !== undefined) {
    if (!definition.env || typeof definition.env !== 'object' || Array.isArray(definition.env)) return reject('MANIFEST_ENV_INVALID');
    if (Object.values(definition.env).some(value => typeof value !== 'string')) return reject('MANIFEST_ENV_INVALID');
  }
  if (contract === 'node-local') {
    if (definition.command !== 'node') return reject('NODE_LOCAL_COMMAND_EXPECTED');
    if (definition.args.length !== 2 || definition.args[0] !== '-e' || !definition.args[1]) return reject('NODE_LOCAL_ARGS_INVALID');
    return { ok: true, contract };
  }
  if (definition.command !== 'npx') return reject('LEGACY_NPX_COMMAND_EXPECTED');
  if (definition.args.join(' ') !== originalNpxArgs(version).join(' ')) return reject('LEGACY_MANIFEST_NOT_ORIGINAL');
  return { ok: true, contract };
}

// Semantic comparison against the same-version definition shipped inside the
// globally installed official package: command, args and declared env must all
// agree (env key order is irrelevant). The cache manifest's own values stay in
// use; the official definition is only the expectation, never a substitute.
function compareDefinitions(definition, official) {
  const envOf = value => value && typeof value === 'object' && value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : {};
  const manifestEnv = envOf(definition), officialEnv = envOf(official);
  const manifestKeys = Object.keys(manifestEnv), officialKeys = Object.keys(officialEnv);
  const commandEqual = !!definition && !!official && definition.command === official.command;
  const argsEqual = !!definition && !!official && Array.isArray(definition.args) && Array.isArray(official.args) && definition.args.length === official.args.length && definition.args.every((arg, index) => arg === official.args[index]);
  const envEqual = manifestKeys.length === officialKeys.length && manifestKeys.every(key => manifestEnv[key] === officialEnv[key]);
  return { equal: !!(commandEqual && argsEqual && envEqual), commandEqual, argsEqual, envEqual, envOnlyInManifest: manifestKeys.filter(key => !(key in officialEnv)), envOnlyInOfficial: officialKeys.filter(key => !(key in manifestEnv)) };
}

// The child inherits the real user environment unchanged - knowledge data dir,
// engine URL and plugin roots included - so existing wiring problems surface
// instead of being masked by a synthetic clean environment. Declared manifest
// env merges on top exactly as a real client would. Nothing is injected or
// rewritten, and no environment value is ever logged. A clean-environment
// control, if ever needed, must be an explicitly separate marked run and can
// never be borrowed as the native pass.
function buildChildEnv(processEnv, declaredEnv) {
  return { ...processEnv, ...(declaredEnv || {}) };
}

function buildLaunch(definition, contract, runtime) {
  if (contract === 'node-local') return { command: definition.command, args: definition.args.slice() };
  // npx is npm exec: Node runs the real npm implementation with the unchanged
  // arguments of the original manifest, for pre-5.0.16 caches only.
  return { command: runtime.execPath, args: [runtime.npmCli, 'exec', ...definition.args] };
}

function parseArgs(argv) {
  const parsed = { query: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--query' && index + 1 < argv.length && argv[index + 1]) { parsed.query = argv[index + 1]; index += 1; }
    else throw Object.assign(new Error('USAGE'), { code: 'USAGE' });
  }
  return parsed;
}

// Failures expose one of the fixed known codes only. Truncation is not
// redaction, so unexpected errors never echo raw messages or raw codes.
function failureFromError(error) {
  const code = error && typeof error.code === 'string' && KNOWN_FAILURE_CODES.includes(error.code) ? error.code : 'UNEXPECTED';
  return { code };
}

// The original index health gate stays: only health.index === 'ok' together
// with a current result row passes.
function searchGate(searched) {
  if (!searched || typeof searched !== 'object') return { ok: false, code: 'SEARCH_NO_CURRENT_RESULT' };
  if (searched.health?.index !== 'ok') return { ok: false, code: 'HEALTH_NOT_OK' };
  const hit = searched.results?.[0];
  if (!hit?.entry_id || typeof hit.commitSha !== 'string' || !hit.commitSha) return { ok: false, code: 'SEARCH_NO_CURRENT_RESULT' };
  return { ok: true, hit };
}

// Entry identity and reference metadata must be self-consistent; legal entry
// bodies are not required to quote the commit sha.
function getReferenceGate(entry, hit, projectId) {
  const entryId = entry?.entryId ?? entry?.entry_id;
  const posixId = value => String(value).split(String.fromCharCode(92)).join('/');
  if (!entryId || posixId(entryId) !== hit.entry_id) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
  if (entry.projectId !== undefined && entry.projectId !== projectId) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
  if (!Array.isArray(entry.chunks) || entry.chunks.length === 0) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
  for (const chunk of entry.chunks) {
    if (!chunk || typeof chunk.chunk_text !== 'string' || !chunk.chunk_text) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
    if (chunk.entry_id !== undefined && posixId(chunk.entry_id) !== hit.entry_id) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
    if (hit.space_id && chunk.space_id !== undefined && chunk.space_id !== hit.space_id) return { ok: false, code: 'GET_REFERENCE_MISMATCH' };
  }
  return { ok: true };
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const coded = code => Object.assign(new Error(code), { code });
  if (!process.env.APPDATA) throw coded('ENV_APPDATA_REQUIRED');
  const core = path.join(process.env.APPDATA, 'npm', 'node_modules', PACKAGE_NAME);
  if (!fs.existsSync(path.join(core, 'package.json'))) throw coded('GLOBAL_PACKAGE_MISSING');
  const load = createRequire(path.join(core, 'package.json'));
  const version = load('./package.json').version;
  const { redactValue } = load('./_site/lib/structured-logger');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, 'native-mcp-' + Date.now() + '.json');
  const manifestPath = pluginManifestPath(os.homedir(), version);
  const report = { passed: false, schema: 'native-plugin-mcp-acceptance/v3', version, manifestPath, at: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(output, redactValue(report));
  const fail = code => { report.failure = { code }; save(); throw coded(code); };
  try { report.cacheVersions = fs.readdirSync(path.dirname(path.dirname(manifestPath)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { report.cacheVersions = null; }
  // A stale or absent plugin cache is recorded as incomplete; another
  // version's manifest must never be borrowed to force a pass.
  if (!fs.existsSync(manifestPath)) fail('PLUGIN_MANIFEST_MISSING');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fail('MANIFEST_INVALID_JSON'); }
  const definition = manifest && typeof manifest === 'object' && manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers[SERVER_KEY] : null;
  const verdict = validateManifest(definition, version);
  report.contract = verdict.contract;
  if (!verdict.ok) fail(verdict.code);
  report.declaredEnvKeys = Object.keys(definition.env || {}).sort();
  // The cache manifest must also equal the same-version definition shipped in
  // the installed official package before anything is executed.
  const officialManifestPath = path.join(core, 'plugins', SERVER_KEY, '.mcp.json');
  report.officialManifestPath = officialManifestPath;
  let officialDefinition = null;
  try { const parsed = JSON.parse(fs.readFileSync(officialManifestPath, 'utf8')); officialDefinition = parsed && parsed.mcpServers ? parsed.mcpServers[SERVER_KEY] : null; } catch { officialDefinition = null; }
  if (!officialDefinition || typeof officialDefinition !== 'object') fail('OFFICIAL_MANIFEST_UNAVAILABLE');
  const comparison = compareDefinitions(definition, officialDefinition);
  report.manifestComparison = comparison;
  if (!comparison.equal) fail('MANIFEST_CONTENT_MISMATCH');
  save();
  const { Client } = load('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = load('@modelcontextprotocol/sdk/client/stdio.js');
  const launch = buildLaunch(definition, verdict.contract, { execPath: process.execPath, npmCli: path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') });
  report.launch = { command: launch.command, argsCount: launch.args.length, arg0: launch.args[0] };
  save();
  const client = new Client({ name: 'native-plugin-mcp-acceptance', version: '3' });
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: buildChildEnv(process.env, definition.env), stderr: 'pipe' });
  let stderrBytes = 0;
  transport.stderr?.on('data', chunk => { stderrBytes += chunk.length; });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'CONNECT_TIMEOUT');
    report.server = client.getServerVersion();
    if (report.server?.version !== version) fail('SERVER_VERSION_MISMATCH');
    const listed = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, 'LIST_TOOLS_TIMEOUT');
    report.tools = listed.tools.map(tool => tool.name).sort();
    if (listed.tools.length !== 6) fail('TOOL_COUNT_MISMATCH');
    const call = async (name, args) => {
      report.lastTool = name;
      const result = await withTimeout(client.callTool({ name: 'project_knowledge_' + name, arguments: args }), CALL_TIMEOUT_MS, 'CALL_TIMEOUT');
      if (result.isError) fail('TOOL_CALL_ERROR');
      return result.structuredContent || JSON.parse(result.content[0].text);
    };
    // The originally registered project repo is this repository itself.
    const project = await call('resolve', { repoPath: path.resolve(__dirname, '../..') });
    if (!project?.projectId) fail('RESOLVE_NO_PROJECT');
    report.projectId = project.projectId;
    // Default query follows the resolved project's own name; --query targets
    // Leader-specified existing knowledge. No entry is pre-pinned.
    const query = options.query || project.name || 'project-knowledge';
    const searched = await call('search', { projectId: project.projectId, query, scope: 'project', limit: 1 });
    report.searchQuery = query;
    report.searchIndexHealth = searched.health?.index ?? null;
    const gate = searchGate(searched);
    if (!gate.ok) fail(gate.code);
    const hit = gate.hit;
    // Entry identity and reference metadata must be self-consistent; legal
    // bodies are not required to quote the commit sha.
    const entry = await call('get', { projectId: project.projectId, entry: hit.entry_id });
    if (!getReferenceGate(entry, hit, project.projectId).ok) fail('GET_REFERENCE_MISMATCH');
    Object.assign(report, { passed: true, citation: { entryId: hit.entry_id, commitSha: hit.commitSha }, stderrBytes, finishedAt: new Date().toISOString() });
    save();
    console.log('NATIVE_PLUGIN_MCP_PASSED ' + output);
  } catch (error) {
    report.stderrBytes = stderrBytes;
    if (!report.failure) report.failure = failureFromError(error);
    save();
    throw coded(report.failure.code);
  } finally {
    await client.close().catch(() => transport.close().catch(() => {}));
  }
}

if (require.main === module) main().catch(error => { console.error('NATIVE_PLUGIN_MCP_FAILED', failureFromError(error).code); process.exitCode = 1; });

module.exports = { NODE_LOCAL_FLOOR, KNOWN_FAILURE_CODES, parseSemver, semverCompare, classifyContract, pluginManifestPath, validateManifest, compareDefinitions, buildChildEnv, buildLaunch, parseArgs, failureFromError, searchGate, getReferenceGate, withTimeout };
