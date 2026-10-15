'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decodeResult } = require('./client-tool-evidence');

function citedEntry(source) {
  const citation = source.replace(/\r?\n[\t ]*\/\/[\t ]*/g, '\n');
  const entryId = citation.match(/\b(?:changes|modules)\/[a-zA-Z0-9._/-]+\.md\b/)?.[0];
  const commitSha = citation.match(/(?:\bcommit(?:Sha)?|提交(?:SHA)?)\s*[:=：]?\s*`?([a-f0-9]{40})\b/i)?.[1];
  assert.ok(entryId && commitSha, 'source must cite a knowledge entry and its full commit');
  assert.ok(!entryId.includes('..'), 'citation cannot escape the knowledge tree');
  return { entryId, commitSha };
}

function verifyCompletedTeardown(events) {
  const states = events.filter(event => event.type === 'claude/state');
  let last = states.length - 1;
  assert.equal(states[last]?.state, 'aborted');
  while (last >= 0 && states[last].state === 'aborted' && states[last].reason === 'no-active-subprocess') last--;
  assert.equal(states[last]?.state, 'idle', 'only an already completed task may survive harness teardown');
  assert.ok(events.some(event => event.type === 'claude/turn-end'));
  assert.equal(events.findLast(event => event.type === 'claude/result')?.isError, false);
}

function verifySecondaryEvidence({ events, source, projectId, latestCommit, file, entry }) {
  const citation = citedEntry(source);
  const writeAt = events.findIndex(event => event.type === 'claude/tool-use' && ['Write', 'Edit'].includes(event.name) && String(event.input?.file_path || '').replace(/\\/g, '/').endsWith('/' + file));
  assert.ok(writeAt >= 0, 'actual Agent write must be recorded');
  const receipts = [];
  for (let i = 0; i < writeAt; i++) {
    const use = events[i];
    if (use.type !== 'claude/tool-use' || !use.input?.command?.includes('project-knowledge-kb.js') || !use.input.command.includes(`--project ${projectId}`)) continue;
    const resultAt = events.findIndex((event, index) => index > i && index < writeAt && event.type === 'claude/tool-result' && event.id === use.id && event.isError === false);
    if (resultAt >= 0) receipts.push({ use, result: events[resultAt] });
  }
  const outputs = receipts.map(receipt => String(receipt.result.output || '')).join('\n');
  const latest = receipts.find(receipt => receipt.use.input.command.includes(latestCommit) && /\bsearch\b/.test(receipt.use.input.command));
  assert.ok(latest, 'latest knowledge must actually be queried before edits');
  const { body, projection } = decodeResult(String(latest.result.output || ''));
  assert.equal(body.ok, true); assert.equal(body.projectId, projectId);
  assert.equal(body.query, latestCommit); assert.equal(body.source, 'knowledge-retrieval-service');
  assert.ok(['hybrid+markdown-truth', 'markdown-hybrid-fallback'].includes(body.backend), 'supported factual retrieval backend required');
  assert.ok(body.results?.some(row => row.scope_project_id === projectId && row.commitSha === latestCommit
    && /^(?:changes|modules)\/[a-zA-Z0-9._/-]+\.md$/.test(row.entry_id || '') && !row.entry_id.split('/').includes('..')), 'latest current-project citation must come from the matching tool result');
  assert.ok(outputs.includes(citation.entryId) && outputs.includes(citation.commitSha), 'the cited entry and commit must come from actual pre-edit knowledge results');
  assert.equal(entry.ok, true);
  assert.equal(entry.projectId, projectId);
  assert.equal(entry.entryId, citation.entryId);
  const text = (entry.chunks || []).map(chunk => chunk.chunk_text).join('\n');
  assert.ok(text.includes(citation.commitSha) && /Knowledge has one writer: the engine promotion path\./i.test(text), 'cited knowledge must contain the actual single-writer fact and commit');
  const final = events.find(event => event.type === 'claude/result' && event.isError === false && event.result?.includes('SECONDARY_POLICY_OK'));
  assert.ok(final?.result.includes(citation.entryId) && final.result.includes(citation.commitSha), 'final answer must cite the actual knowledge used');
  return { ...citation, latestQueriedCommit: latestCommit, latestBackend: body.backend, latestProjection: projection, knowledgeHash: crypto.createHash('sha256').update(text).digest('hex'), receipts: receipts.map(receipt => ({ toolId: receipt.use.id, useSequence: receipt.use.sequence, resultSequence: receipt.result.sequence })) };
}

module.exports = { citedEntry, verifySecondaryEvidence, verifyCompletedTeardown };
