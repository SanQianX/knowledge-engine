'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');

test('unassigned projects share no implicit domain; explicit domain and brain ranges remain inclusive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-retrieval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = [
    { projectId: 'project-a', brainId: 'brain-one', domainId: null },
    { projectId: 'project-b', brainId: 'brain-one', domainId: null },
    { projectId: 'project-c', brainId: 'brain-one', domainId: 'domain-other' },
    { projectId: 'project-d', brainId: 'brain-two', domainId: null },
  ].map(project => {
    const knowledgePath = path.join(root, project.projectId); fs.mkdirSync(knowledgePath);
    fs.writeFileSync(path.join(knowledgePath, 'README.md'), `# Scope principle ${project.projectId}\n\nKnowledge writer boundary scope principle.\n`);
    return { ...project, knowledgePath, enabled: true };
  });
  const sharedScopes = [
    { id: 'brain-one', brainId: 'brain-one', kind: 'brain' },
    { id: 'domain-tools', brainId: 'brain-one', domainId: 'domain-tools', kind: 'domain' },
    { id: 'domain-other', brainId: 'brain-one', domainId: 'domain-other', kind: 'domain' },
  ].map(scope => {
    const knowledgePath = path.join(root, scope.id); fs.mkdirSync(knowledgePath);
    fs.writeFileSync(path.join(knowledgePath, 'README.md'), `# Scope principle ${scope.id}\n\nKnowledge writer boundary scope principle.\n`);
    return { ...scope, knowledgePath };
  });
  const store = { state: { sharedScopes }, getProject: id => projects.find(project => project.projectId === id), listProjects: () => projects, readRuntime: () => ({ index: {} }), listRuns: () => [] };
  const retrieval = new EngineRetrieval({ layout: new RuntimeLayout(root), store, projectStore: { readState: () => ({ index: {} }) } });
  retrieval.recallIndex = async (scopes, query, candidates, health) => { health.index = 'unavailable'; };
  const ids = async scope => [...new Set((await retrieval.search({ projectId: 'project-a', query: 'scope principle', scope, limit: 30 })).results.map(result => result.scope_project_id))].sort();
  assert.deepEqual(await ids('project'), ['project-a']);
  assert.deepEqual(await ids('domain'), ['brain-one', 'project-a']);
  assert.deepEqual(await ids('brain'), ['brain-one', 'domain-other', 'domain-tools', 'project-a', 'project-b', 'project-c']);
  projects[0].domainId = projects[1].domainId = 'domain-tools';
  assert.deepEqual(await ids('domain'), ['brain-one', 'domain-tools', 'project-a', 'project-b']);
  projects[0].domainId = null;
  assert.deepEqual(await ids('domain'), ['brain-one', 'project-a']);
});

test('known commit SHA and prefix cannot be crowded out by unrelated vector chunks or stale provenance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-retrieval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const knowledgePath = path.join(root, 'knowledge'); fs.mkdirSync(path.join(knowledgePath, 'changes'), { recursive: true });
  const project = { projectId: 'project-search', knowledgePath, enabled: true, brainId: 'brain-default', domainId: 'domain-default' };
  const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40);
  fs.writeFileSync(path.join(knowledgePath, 'changes', 'old.md'), `# Old semantic document\n\n${Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\nUnrelated historical knowledge.\n`).join('\n')}`);
  fs.writeFileSync(path.join(knowledgePath, 'changes', 'new.md'), '# New change\n\nEvidence-backed current change without a literal SHA in the body.\n');
  fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# Current overview\n\nLatest facts replace an earlier version.\n');
  const runs = [
    { projectId: project.projectId, commitSha: newSha, promotedAt: '2026-10-10T02:00:00Z', staging: { operations: [{ path: 'changes/new.md' }, { path: 'README.md' }] } },
    { projectId: project.projectId, commitSha: oldSha, promotedAt: '2026-10-10T01:00:00Z', staging: { operations: [{ path: 'changes/old.md' }, { path: 'README.md' }] } },
  ];
  const store = { state: { sharedScopes: [] }, getProject: id => id === project.projectId ? project : null, listProjects: () => [project], readRuntime: () => ({ index: {} }), listRuns: id => id && id !== project.projectId ? [] : runs };
  const retrieval = new EngineRetrieval({ layout: new RuntimeLayout(root), store, projectStore: { readState: () => ({ index: {} }) } });
  retrieval.recallIndex = async (scopes, query, candidates, health) => {
    health.index = 'ok';
    for (const candidate of candidates.values()) { candidate.indexScore = candidate.entryId === 'changes/old.md' ? 100000 : 0; candidate.indexChannels = ['vector-hub']; }
  };
  fs.mkdirSync(path.join(knowledgePath, 'dev-conversations'));
  fs.writeFileSync(path.join(knowledgePath, 'dev-conversations', 'raw.md'), `# Raw transcript\n\nExplain knowledge for submission ${newSha}.\n`.repeat(20));
  for (const query of [newSha, newSha.slice(0, 8), newSha.toUpperCase(), `Explain knowledge for submission ${newSha}.`, `提交${newSha}的知识写入边界`, `参考 ${newSha.slice(0, 8)} 的知识`]) {
    const result = await retrieval.search({ projectId: project.projectId, query, limit: 1 });
    assert.equal(result.results.length, 1); assert.equal(result.results[0].commitSha, newSha); assert.ok(result.results[0].match_channels.includes('exact-commit'));
  }
  const old = await retrieval.search({ projectId: project.projectId, query: oldSha, limit: 30 });
  assert.ok(old.results.length); assert.ok(old.results.every(row => row.entry_id === 'changes/old.md'), 'replaced README cannot be attributed to its former commit');
  const compared = await retrieval.search({ projectId: project.projectId, query: `Compare ${oldSha} and ${newSha}`, limit: 30 });
  assert.deepEqual([...new Set(compared.results.map(row => row.commitSha))].sort(), [oldSha, newSha].sort());
  assert.ok(compared.results.every(row => !row.entry_id.startsWith('dev-conversations/')), 'raw transcripts containing a SHA are not promoted commit facts');
  const ordinary = await retrieval.search({ projectId: project.projectId, query: 'semantic historical knowledge', limit: 1 });
  assert.equal(ordinary.results[0].entry_id, 'changes/old.md'); assert.ok(!ordinary.results[0].match_channels.includes('exact-commit'));
});
