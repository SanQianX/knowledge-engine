'use strict';
const assert = require('node:assert/strict');

function decodeResult(text) {
  try { return { body: JSON.parse(text), projection: 'complete' }; } catch {}
  // OpenCode deliberately persists at most 4000 display characters. Only a
  // complete first citation from that exact boundary can vouch for the call.
  assert.equal(text.length, 4000, 'malformed tool output is not a display prefix');
  const match = /"results"\s*:\s*\[\s*/.exec(text);
  assert.ok(match, 'display prefix must contain the actual results array');
  const arrayStart = match.index + match[0].lastIndexOf('[');
  const body = JSON.parse(text.slice(0, arrayStart) + '[]}');
  const start = match.index + match[0].length;
  assert.equal(text[start], '{', 'a complete first citation is required');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      body.results = [JSON.parse(text.slice(start, i + 1))];
      return { body, projection: 'display-prefix' };
    }
  }
  assert.fail('display prefix did not preserve a complete citation');
}

function verifyClientToolEvidence(events, { projectId, commitSha }) {
  assert.match(commitSha, /^[a-f0-9]{40}$/);
  const at = events.findIndex(event => {
    if (event.type !== 'claude/tool-use' || !event.id) return false;
    const command = event.input?.command || '';
    if (!/^(?:node(?:\.exe)?|"[^"]*[/\\]node(?:\.exe)?")\s/.test(command)) return false;
    const tokens = command.replace(/["']/g, '').split(/\s+/);
    return tokens.some(token => /[/\\]project-knowledge-kb\.js$/.test(token))
      && tokens.includes('search') && tokens.includes('--json')
      && tokens[tokens.indexOf('--project') + 1] === projectId
      && tokens[tokens.indexOf('--query') + 1] === commitSha;
  });
  assert.ok(at >= 0, 'actual project-bound knowledge tool command required');
  const result = events.slice(at + 1).find(e => e.type === 'claude/tool-result' && e.id === events[at].id);
  assert.ok(result && result.isError === false, 'matching successful tool result required');
  const { body, projection } = decodeResult(String(result.output || ''));
  assert.equal(body.ok, true); assert.equal(body.projectId, projectId);
  assert.equal(body.source, 'knowledge-retrieval-service');
  assert.ok(['hybrid+markdown-truth', 'markdown-hybrid-fallback'].includes(body.backend), 'supported factual retrieval backend required');
  const row = body.results?.find(r => r.scope_project_id === projectId && r.commitSha === commitSha
    && typeof r.entry_id === 'string' && /^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(r.entry_id)
    && !r.entry_id.split('/').some(segment => segment === '.' || segment === '..'));
  assert.ok(row, 'current-project entry and full commit citation required');
  return { projectId, commitSha, entryId: row.entry_id, backend: body.backend, projection, toolUseId: result.id };
}
module.exports = { verifyClientToolEvidence };
