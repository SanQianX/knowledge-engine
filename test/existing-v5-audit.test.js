'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify } = require('./support/existing-v5-audit');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('frozen v5 upgrade verifies existing knowledge, history bytes and completed maintenance identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-frozen-audit-'));
  try {
    const knowledge = path.join(root, 'knowledge.md'), history = path.join(root, 'history.json');
    fs.writeFileSync(knowledge, 'old knowledge'); fs.writeFileSync(history, 'old history');
    const before = { dataDir: root, projects: [{ projectId: 'p', repoPath: root, knowledgePath: root, brainId: 'b', domainId: 'd', trackingStartCommit: 'baseline', knowledgeFiles: [{ file: knowledge, sha256: sha256('old knowledge') }] }], protectedFiles: [], historyFiles: [{ file: history, sha256: sha256('old history') }], runs: [{ runId: 'run', commitSha: 'commit', state: 'succeeded', indexState: 'succeeded', promotedAt: 'original promotion', analysisRunId: 'original analysis', indexAttempts: 1 }] };
    const after = JSON.parse(JSON.stringify(before));
    verify(before, after, { frozen: true });
    fs.writeFileSync(knowledge, 'rewritten');
    assert.throws(() => verify(before, after, { frozen: true }), /changed existing knowledge/);
    fs.writeFileSync(knowledge, 'old knowledge'); fs.writeFileSync(history, 'rewritten');
    assert.throws(() => verify(before, after, { frozen: true }), /rewrote existing history/);
    fs.writeFileSync(history, 'old history'); after.runs[0].analysisRunId = 'replayed';
    assert.throws(() => verify(before, after, { frozen: true }), /replayed completed maintenance/);
    after.runs[0].analysisRunId = 'original analysis'; before.runs[0].state = 'running';
    assert.throws(() => verify(before, after, { frozen: true }), /freeze an idle/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
