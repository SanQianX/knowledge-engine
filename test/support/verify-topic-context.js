'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const environment = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-'));
  assert.equal(environment.installationSource, 'project-knowledge/installed-registry/v1');
  const commitSha = '9aec087aa15574a3a9aecd9945ed0d62aba82d9b';
  const entryId = 'changes/9aec087aa155.md';
  const expected = 'Knowledge has one writer: the engine promotion path.';
  const query = `请先参考注入的项目知识，简要说明知识库为什么由引擎统一写入，并引用提交 ${commitSha} 对应的真实知识依据。不要调用工具或修改文件。查询关键词：知识、提交、单写者、${commitSha}。`;
  const api = async (action, input) => {
    const response = await fetch(new URL('/api/engine/' + action, environment.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); return response.json();
  };
  const projects = await fetch(new URL('/api/projects/aggregated', environment.url)).then(r => r.json());
  const project = projects.projects.find(p => p.projectId === 'project-real-a');
  assert.ok(project?.knowledgePath);
  const file = path.join(project.knowledgePath, entryId), before = fs.readFileSync(file, 'utf8');
  assert.ok(before.includes(expected), 'the actual retained knowledge must already contain the evidence');
  const output = path.join(environment.root, 'topic-context-' + Date.now() + '.json');
  const report = { passed: false, version: require(path.join(environment.runtimeRoots.shell, 'package.json')).version, entryId, commitSha, query, existingKnowledgeContainsEvidence: true, at: new Date().toISOString() };
  try {
    const search = await api('search', { projectId: project.projectId, scope: 'project', query, limit: 5 });
    const context = await api('context', { projectId: project.projectId, scope: 'project', query, client: 'workbench' });
    report.search = search.results.map(r => ({ entry: r.entry_id, commit: r.commitSha, containsEvidence: r.chunk_text.includes(expected), heading: r.heading_path, channels: r.match_channels }));
    report.context = context.facts.map(r => ({ entry: r.entryId, commit: r.commitSha, containsEvidence: r.text.includes(expected) }));
    assert.ok(report.search.some(r => r.entry === entryId && r.commit === commitSha && r.containsEvidence), 'search omitted the existing topical Patch evidence');
    assert.ok(report.context.some(r => r.entry === entryId && r.commit === commitSha && r.containsEvidence), 'the first task context must include the evidence, not only commit metadata');
    assert.ok(context.prompt.length <= 8000);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    report.passed = true;
  } catch (error) { report.failure = error.message; throw error; }
  finally { AtomicFile.writeJsonAtomic(output, report); console.log('TOPIC_CONTEXT_EVIDENCE ' + output); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
