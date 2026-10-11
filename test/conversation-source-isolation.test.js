'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineServer } = require('../src/server');

test('raw commit conversations are evidence, not searchable knowledge or get results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-knowledge-source-'));
  const knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledgePath, 'dev-conversations', 'commits'), { recursive: true });
  const raw = path.join(knowledgePath, 'dev-conversations', 'commits', 'raw.md');
  fs.writeFileSync(raw, '# raw-only-journal-marker\n\nUnverified conversation text.');
  fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# maintained-fact\n\nAuthoritative knowledge.');
  const engine = createEngineServer({ dataDir: path.join(root, 'data'), consume: false, vectorUrl: 'http://127.0.0.1:1' });
  await engine.ready;
  await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${engine.server.address().port}`;
  engine.store.addProject({ projectId: 'project-test', repoPath: path.join(root, 'code'), knowledgePath });
  const read = async (action, input) => { const response = await fetch(base + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-test', ...input }) }); return { status: response.status, body: await response.json() }; };
  try {
    const result = await read('search', { query: 'raw-only-journal-marker' });
    assert.equal(result.status, 200); assert.equal(result.body.results.length, 0);
    const allowed = await read('get', { entryId: 'README.md' });
    assert.equal(allowed.status, 200); assert.ok(allowed.body.chunks[0].chunk_text.includes('maintained-fact'));
    for (const entryId of ['dev-conversations/commits/raw.md', 'DEV-CONVERSATIONS/commits/raw.md', '.private/key.md', '.secret.md', '_backup/original.md']) assert.equal((await read('get', { entryId })).status, 403);
    assert.ok(fs.readFileSync(raw, 'utf8').includes('raw-only-journal-marker'));
  } finally { await engine.close(); }
});
