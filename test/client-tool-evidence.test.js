'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyClientToolEvidence } = require('./support/client-tool-evidence');
const commitSha = 'a'.repeat(40), projectId = 'project-a';
const sample = (backend = 'hybrid+markdown-truth') => [
  { type: 'claude/tool-use', id: 'call-1', input: { command: `node "D:/prefix/bin/project-knowledge-kb.js" search --project ${projectId} --query ${commitSha} --scope project --json` } },
  { type: 'claude/tool-result', id: 'call-1', isError: false, output: JSON.stringify({ ok: true, projectId, backend, source: 'knowledge-retrieval-service', results: [{ entry_id: 'changes/aaaaaaaaaaaa.md', scope_project_id: projectId, commitSha, chunk_text: 'Fact actually returned by the knowledge service.' }] }) },
];
const verify = events => verifyClientToolEvidence(events, { projectId, commitSha });
test('native client accepts authoritative exact-commit facts without claiming vector success', () => {
  assert.equal(verify(sample('markdown-hybrid-fallback')).backend, 'markdown-hybrid-fallback');
  assert.equal(verify(sample()).entryId, 'changes/aaaaaaaaaaaa.md');
});
test('OpenCode 4000-byte UI display prefix still contains a complete first citation', () => {
  const events = sample('markdown-hybrid-fallback');
  const body = JSON.parse(events[1].output);
  body.results.push({ chunk_text: 'x'.repeat(5000) });
  events[1].output = JSON.stringify(body).slice(0, 4000);
  assert.equal(verify(events).projection, 'display-prefix');
});
test('display prefix handles escaped braces in text but never accepts a clipped citation', () => {
  const events = sample('markdown-hybrid-fallback'), body = JSON.parse(events[1].output);
  body.results[0].chunk_text = 'A quoted brace: " } { \\ end';
  body.results.push({ chunk_text: 'x'.repeat(5000) });
  events[1].output = JSON.stringify(body).slice(0, 4000);
  assert.equal(verify(events).projection, 'display-prefix');
  body.results[0].chunk_text = 'x'.repeat(5000);
  events[1].output = JSON.stringify(body).slice(0, 4000);
  assert.throws(() => verify(events), /complete citation/);
});
test('actual tool result must follow its matching successful tool call', () => {
  let events = sample(); events[1].id = 'other'; assert.throws(() => verify(events));
  events = sample(); events[1].isError = true; assert.throws(() => verify(events));
  events = sample().reverse(); assert.throws(() => verify(events));
  events = sample(); events[0].input.command = 'echo project-knowledge-kb.js ' + commitSha; assert.throws(() => verify(events));
});
test('unrelated or unsupported knowledge output cannot pass by loose substrings', () => {
  for (const change of [
    body => { body.projectId = 'other'; },
    body => { body.source = 'untrusted'; },
    body => { body.ok = false; },
    body => { body.results = []; },
    body => { body.results[0].commitSha = 'b'.repeat(40); },
    body => { body.results[0].scope_project_id = 'other'; },
    body => { body.results[0].entry_id = '../secret.md'; },
    body => { body.backend = 'unknown'; },
  ]) {
    const events = sample(), body = JSON.parse(events[1].output); change(body); events[1].output = JSON.stringify(body);
    assert.throws(() => verify(events));
  }
});
test('arbitrary short malformed text is not the documented display prefix', () => {
  const events = sample(); events[1].output = events[1].output.slice(0, -1); assert.throws(() => verify(events));
});
