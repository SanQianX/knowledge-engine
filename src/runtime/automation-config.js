const path = require('path');

const PERMISSION_MODES = new Set(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
const PROMPT_TEMPLATE_VERSION = 2;

const DEFAULT_COMMIT_PROMPT_TEMPLATE = `你正在根据一个 Git Commit 的冻结证据维护项目知识库。

用户需求：
{{userRequirement}}

Commit 信息：
{{commitMetadata}}

Commit 实际变更文件：
{{actualChanges}}

Commit 实际 Patch：
{{actualPatch}}

现有相关知识：
{{existingKnowledge}}

请完成以下判断，并只输出符合 staging manifest 合同的知识变更：
1. 比较用户需求与实际实现是否一致；没有可靠需求时不得猜测业务目的。
2. 只记录 Commit、Patch 和现有知识能够证明的事实。
3. 明确需要新增、更新或删除哪些知识；删除必须有实际变更证据。
4. 不得修改源码、最终知识目录、其他项目或派生索引。
5. Patch 使用 chunk evidence 时，必须从只读 manifest 按序读取所需 chunk；不得从源码工作树补读或猜测。`;

const READ_TOOLS = ['Read'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];

function normalizePermissionMode(value) {
  return PERMISSION_MODES.has(value) ? value : 'default';
}

function normalizeAutomationConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const explicit = typeof source.commitPromptTemplate === 'string' && source.commitPromptTemplate.trim();
  const legacy = typeof source.hookPromptTemplate === 'string' && source.hookPromptTemplate.trim();
  return {
    enabled: source.enabled !== false,
    commitPromptTemplate: explicit || legacy || DEFAULT_COMMIT_PROMPT_TEMPLATE,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    legacyPromptOverride: !explicit && Boolean(legacy),
  };
}

function normalizeClaudeWorkbenchConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  return { permissionMode: normalizePermissionMode(source.permissionMode) };
}

function renderTemplate(template, vars) {
  const source = typeof template === 'string' && template.trim() ? template : DEFAULT_COMMIT_PROMPT_TEMPLATE;
  const safeVars = vars && typeof vars === 'object' ? vars : {};
  return source.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(safeVars, name)) return match;
    const value = safeVars[name];
    return value == null ? '' : String(value);
  });
}

function normalizePathForCompare(value) {
  if (!value || typeof value !== 'string') return '';
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsReferToSameLocation(leftValue, rightValue) {
  const left = normalizePathForCompare(leftValue);
  const right = normalizePathForCompare(rightValue);
  return Boolean(left && right && left === right);
}

function isInsidePath(root, target) {
  if (!root || !target) return false;
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target);
  const relative = path.relative(rootAbs, targetAbs);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function extractToolPaths(toolName, input) {
  if (!input || typeof input !== 'object') return [];
  const candidates = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string') candidates.push(input[key]);
  }
  if (toolName === 'MultiEdit' && typeof input.file_path === 'string') candidates.push(input.file_path);
  return [...new Set(candidates)];
}

function buildAutomationToolPolicy(options = {}) {
  const stagingPath = options.stagingPath || options.kbPath || '';
  const evidenceRoot = options.evidenceRoot || '';
  return {
    kind: 'knowledge-staging',
    stagingPath,
    evidenceRoot,
    readRoots: [evidenceRoot, stagingPath].filter(Boolean),
    writeRoot: stagingPath,
    allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
    canWriteKb: false,
    canWriteStaging: true,
    allowReadOnlyBash: false,
  };
}

function evaluateAutomationToolUse(policy, toolName, input) {
  if (!policy || policy.kind !== 'knowledge-staging') return { behavior: 'ask', reason: 'no staging policy' };
  if (!policy.allowedTools.includes(toolName)) return { behavior: 'deny', reason: `tool is not allowed: ${toolName}` };
  const paths = extractToolPaths(toolName, input);
  if (!paths.length) return { behavior: 'deny', reason: `${toolName} has no explicit file path` };
  for (const filePath of paths) {
    if (toolName === 'Read') {
      if (!(policy.readRoots || []).some(root => isInsidePath(root, filePath))) {
        return { behavior: 'deny', reason: `path outside read-only evidence/output roots: ${filePath}` };
      }
    } else if (!isInsidePath(policy.writeRoot || policy.stagingPath, filePath)) {
      return { behavior: 'deny', reason: `path outside writable run output: ${filePath}` };
    }
  }
  return { behavior: 'allow', reason: toolName === 'Read' ? 'path is inside an isolated read root' : 'path is inside the isolated writable output root' };
}

module.exports = {
  PERMISSION_MODES,
  PROMPT_TEMPLATE_VERSION,
  DEFAULT_COMMIT_PROMPT_TEMPLATE,
  normalizePermissionMode,
  normalizeAutomationConfig,
  normalizeClaudeWorkbenchConfig,
  renderTemplate,
  normalizePathForCompare,
  pathsReferToSameLocation,
  isInsidePath,
  buildAutomationToolPolicy,
  evaluateAutomationToolUse,
};
