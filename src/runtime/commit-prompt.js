const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_COMMIT_PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_VERSION,
  normalizeAutomationConfig,
  renderTemplate,
} = require('./automation-config');

const REQUIREMENT_UNAVAILABLE = '需求上下文未记录。只能记录代码可以证明的变化，不得猜测业务目的。';
const REQUIRED_SECTIONS = Object.freeze([
  ['userRequirement', '用户需求'],
  ['aiConversationEvidence', 'AI 对话证据'],
  ['commitMetadata', 'Commit 信息'],
  ['actualChanges', 'Commit 实际变更文件'],
  ['actualPatch', 'Commit 实际 Patch'],
  ['existingKnowledge', '现有相关知识'],
]);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function formatRequirements(records) {
  if (!Array.isArray(records) || records.length === 0) return REQUIREMENT_UNAVAILABLE;
  return records.map(record => [
    `- requirementId: ${record.id}`,
    `  client/session: ${record.client}/${record.sessionId}`,
    `  recordedAt: ${record.ts}`,
    '  requirement: |',
    ...String(record.requirement || '').split(/\r?\n/).map(line => `    ${line}`),
  ].join('\n')).join('\n');
}

function formatConversationUserTruth(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.turns) || snapshot.turns.length === 0) return REQUIREMENT_UNAVAILABLE;
  return snapshot.turns.flatMap(turn => turn.userEvents.map(event => [
    `- turnId: ${turn.turnId}`,
    `  eventId: ${event.eventId}`,
    `  source/session: ${turn.source}/${turn.sessionId || '(unavailable)'}`,
    `  binding: ${turn.bindingKind}`,
    `  capturedAt: ${event.capturedAt}`,
    '  userPrompt: |',
    ...String(event.content || '').split(/\r?\n/).map(line => `    ${line}`),
  ].join('\n'))).join('\n');
}

function formatAssistantEvidence(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.turns)) return '(no assistant conversation evidence was frozen)';
  const entries = snapshot.turns.flatMap(turn => turn.assistantEvents.map(event => [
    `- turnId: ${turn.turnId}`,
    `  eventId: ${event.eventId}`,
    `  capturedAt: ${event.capturedAt}`,
    '  assistantResponse: |',
    ...String(event.content || '').split(/\r?\n/).map(line => `    ${line}`),
  ].join('\n')));
  return entries.length ? entries.join('\n') : '(no assistant conversation evidence was frozen)';
}

function formatCommitMetadata(evidence) {
  return [
    `fullSha: ${evidence.commitSha}`,
    `parents: ${(evidence.parents || []).join(', ') || '(root commit)'}`,
    `author: ${evidence.author || ''}`,
    `date: ${evidence.date || ''}`,
    `subject: ${evidence.subject || ''}`,
    `branchAtScan: ${evidence.branch || '(detached/unavailable)'}`,
    `patchMode: ${evidence.patchMode}`,
    `patchHash: ${evidence.patchHash}`,
    `patchBytes: ${evidence.patchBytes}`,
  ].join('\n');
}

function formatChanges(evidence) {
  if (!evidence.files || evidence.files.length === 0) return '(no changed paths reported by Git)';
  return evidence.files.map(file => {
    const rename = file.oldPath ? ` ${file.oldPath} -> ${file.path}` : ` ${file.path}`;
    const stats = file.binary ? ' binary' : ` +${file.added == null ? '?' : file.added}/-${file.deleted == null ? '?' : file.deleted}`;
    return `- ${file.status}${rename}${stats}`;
  }).join('\n');
}

function formatPatch(evidence) {
  if (!evidence.patchChunked) return evidence.patch || '(empty patch)';
  const bundle = evidence.evidenceBundle || {};
  return [
    '[EXACT PATCH AVAILABLE AS READ-ONLY CHUNKS]',
    `fullPatchHash: ${evidence.patchHash}`,
    `fullPatchBytes: ${evidence.patchBytes}`,
    `patchManifestHash: ${bundle.manifestHash || '(unavailable)'}`,
    `patchManifestPath: ${bundle.manifestPath || '(unavailable)'}`,
    `chunkCount: ${bundle.chunkCount == null ? '(unavailable)' : bundle.chunkCount}`,
    'Read patch-manifest.json, then Read exact patch chunks in manifest sequence. The chunks cover the full Git diff.',
    'Do not read the source worktree and do not infer unread evidence.',
  ].join('\n');
}

function formatExistingKnowledge(existing) {
  if (!existing || !Array.isArray(existing.entries) || existing.entries.length === 0) {
    return '(no existing project knowledge was available)';
  }
  const sections = existing.entries.map(entry => `--- ${entry.path} (${entry.hash}) ---\n${entry.content}`);
  if (existing.omitted && existing.omitted.length) {
    sections.push(`[EXISTING KNOWLEDGE OMITTED: ${existing.omitted.join(', ')}]`);
  }
  return sections.join('\n\n');
}

function ensureRequiredSections(template, rendered, vars) {
  const missing = REQUIRED_SECTIONS.filter(([name]) => !new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i').test(template));
  if (!missing.length) return rendered;
  const footer = missing.map(([name, label]) => `${label}：\n${vars[name]}`).join('\n\n');
  return `${rendered.trimEnd()}\n\n${footer}`;
}

function renderCommitPrompt(input = {}) {
  const config = input.config || {};
  const evidence = input.evidence || {};
  const automation = normalizeAutomationConfig(config.automation);
  const template = automation.commitPromptTemplate || DEFAULT_COMMIT_PROMPT_TEMPLATE;
  const vars = {
    userRequirement: input.conversationSnapshot
      ? formatConversationUserTruth(input.conversationSnapshot)
      : formatRequirements(input.requirements),
    aiConversationEvidence: formatAssistantEvidence(input.conversationSnapshot),
    commitMetadata: formatCommitMetadata(evidence),
    actualChanges: formatChanges(evidence),
    actualPatch: formatPatch(evidence),
    existingKnowledge: formatExistingKnowledge(input.existingKnowledge),
    projectId: config.projectId || input.projectId || '',
    displayName: config.displayName || config.projectId || '',
    knowledgePath: config.knowledgePath || '',
    repoPath: config.repoPath || '',
    commitHash: evidence.commitSha || '',
    commitSubject: evidence.subject || '',
    commitAuthor: evidence.author || '',
    commitDate: evidence.date || '',
    branch: evidence.branch || '',
    changedFiles: formatChanges(evidence),
    diffSummary: formatPatch(evidence),
  };
  const rendered = ensureRequiredSections(template, renderTemplate(template, vars), vars).trimEnd() + '\n';
  return {
    prompt: rendered,
    promptHash: sha256(rendered),
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    promptLength: rendered.length,
    vars,
  };
}

class KnowledgeEvidenceReader {
  constructor(options = {}) {
    this.maxBytes = Number(options.maxBytes || 256 * 1024);
    this.maxFiles = Number(options.maxFiles || 24);
  }

  read(config) {
    const root = config && config.knowledgePath ? path.resolve(config.knowledgePath) : '';
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { entries: [], omitted: [] };
    const realRoot = fs.realpathSync(root);
    const files = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
      }
    };
    walk(root);
    let used = 0;
    const entries = [];
    const omitted = [];
    for (const file of files) {
      const realFile = fs.realpathSync(file);
      const relativeBoundary = path.relative(realRoot, realFile);
      if (relativeBoundary.startsWith('..') || path.isAbsolute(relativeBoundary)) continue;
      const relativePath = path.relative(root, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (entries.length >= this.maxFiles || used + bytes > this.maxBytes) {
        omitted.push(relativePath);
        continue;
      }
      used += bytes;
      entries.push({ path: relativePath, hash: sha256(content), content });
    }
    return { entries, omitted, totalBytes: used, limitBytes: this.maxBytes, limitFiles: this.maxFiles };
  }
}

module.exports = {
  REQUIREMENT_UNAVAILABLE,
  KnowledgeEvidenceReader,
  formatRequirements,
  formatConversationUserTruth,
  formatAssistantEvidence,
  renderCommitPrompt,
  sha256,
};
