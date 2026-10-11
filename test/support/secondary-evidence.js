'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function citedEntry(source) {
  const entryId = source.match(/\b(?:changes|modules)\/[a-zA-Z0-9._/-]+\.md\b/)?.[0];
  const commitSha = source.match(/\bcommit(?:Sha)?\s*[:=]?\s*`?([a-f0-9]{40})\b/i)?.[1];
  assert.ok(entryId && commitSha, 'source must cite a knowledge entry and its full commit');
  assert.ok(!entryId.includes('..'), 'citation cannot escape the knowledge tree');
  return { entryId, commitSha };
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
  assert.ok(receipts.some(receipt => receipt.use.input.command.includes(latestCommit) && receipt.result.output?.includes(latestCommit) && receipt.result.output.includes('hybrid+markdown-truth')), 'latest knowledge must actually be queried before edits');
  assert.ok(outputs.includes(citation.entryId) && outputs.includes(citation.commitSha), 'the cited entry and commit must come from actual pre-edit knowledge results');
  assert.equal(entry.ok, true);
  assert.equal(entry.projectId, projectId);
  assert.equal(entry.entryId, citation.entryId);
  const text = (entry.chunks || []).map(chunk => chunk.chunk_text).join('\n');
  assert.ok(text.includes(citation.commitSha) && /Knowledge has one writer: the engine promotion path\./i.test(text), 'cited knowledge must contain the actual single-writer fact and commit');
  const final = events.find(event => event.type === 'claude/result' && event.isError === false && event.result?.includes('SECONDARY_POLICY_OK'));
  assert.ok(final?.result.includes(citation.entryId) && final.result.includes(citation.commitSha), 'final answer must cite the actual knowledge used');
  return { ...citation, latestQueriedCommit: latestCommit, knowledgeHash: crypto.createHash('sha256').update(text).digest('hex'), receipts: receipts.map(receipt => ({ toolId: receipt.use.id, useSequence: receipt.use.sequence, resultSequence: receipt.result.sequence })) };
}

module.exports = { citedEntry, verifySecondaryEvidence };
