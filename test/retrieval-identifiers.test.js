'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineRetrieval } = require('../src/retrieval');
const { RuntimeLayout } = require('../src/runtime/layout');

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
  for (const query of [newSha, newSha.slice(0, 8), newSha.toUpperCase()]) {
    const result = await retrieval.search({ projectId: project.projectId, query, limit: 1 });
    assert.equal(result.results.length, 1); assert.equal(result.results[0].commitSha, newSha); assert.ok(result.results[0].match_channels.includes('exact-commit'));
  }
  const old = await retrieval.search({ projectId: project.projectId, query: oldSha, limit: 30 });
  assert.ok(old.results.length); assert.ok(old.results.every(row => row.entry_id === 'changes/old.md'), 'replaced README cannot be attributed to its former commit');
  const ordinary = await retrieval.search({ projectId: project.projectId, query: 'semantic historical knowledge', limit: 1 });
  assert.equal(ordinary.results[0].entry_id, 'changes/old.md'); assert.ok(!ordinary.results[0].match_channels.includes('exact-commit'));
});
