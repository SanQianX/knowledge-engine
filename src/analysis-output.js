'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('./runtime/atomic-file');
const { RuntimeLayout } = require('./runtime/layout');
const { canonicalRelativePath, validateMarkdown, MAX_KNOWLEDGE_FILE_BYTES } = require('./runtime/knowledge-promotion');
const { requireAnalysisOutput } = require('./analysis-contract');

function finalize(input) {
  requireAnalysisOutput(input.manifestPath);
  const manifest = AtomicFile.readJsonStrict(input.manifestPath);
  if (manifest.schema !== 'knowledge-staging-manifest/v1' || manifest.projectId !== input.projectId || manifest.runId !== input.claim.runId || manifest.commitSha !== input.claim.commitSha || !Array.isArray(manifest.operations) || !manifest.operations.length) throw Object.assign(new Error('知识维护清单与当前提交不匹配。'), { code: 'ANALYSIS_MANIFEST_INVALID' });
  const layout = new RuntimeLayout(input.stagingPath);
  const normalized = [];
  for (const operation of manifest.operations) {
    const relative = canonicalRelativePath(operation.path);
    if (operation.operation === 'delete') continue;
    if (!['create', 'replace'].includes(operation.operation)) throw Object.assign(new Error('知识维护操作类型无效。'), { code: 'ANALYSIS_MANIFEST_INVALID' });
    const file = path.join(input.stagingPath, 'files', ...relative.split('/'));
    if (!layout.isPathInside(input.stagingPath, file, { realpath: true }) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('分析产物越界或不是普通文件。'), { code: 'PATH_OUTSIDE_ROOT' });
    let bytes = fs.readFileSync(file);
    if (bytes.length > MAX_KNOWLEDGE_FILE_BYTES) throw Object.assign(new Error(`分析文档超过大小限制：${relative}`), { code: 'INVALID_ARGUMENT' });
    const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    if (operation.sha256 != null && operation.sha256 !== hash(bytes)) throw Object.assign(new Error(`分析文档哈希不匹配：${relative}`), { code: 'DATA_CORRUPT' });
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error(`分析文档不是有效 UTF-8：${relative}`), { code: 'INVALID_ARGUMENT' }); }
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/^#{1,6}[ \t]+.*$/gm, '').trim();
    if (!body) throw Object.assign(new Error(`知识文档正文为空：${relative}。未写入知识库。`), { code: 'ANALYSIS_EMPTY_DOCUMENT', retryable: true });
    if (!/^#\s+\S+/m.test(content)) {
      const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (/^---\r?\n/.test(content) && !frontmatter) throw Object.assign(new Error(`Markdown frontmatter is incomplete: ${relative}.`), { code: 'INVALID_ARGUMENT' });
      const title = relative.startsWith('changes/') ? `提交 ${input.claim.commitSha.slice(0, 12)} 变更记录` : ({ 'README.md': '项目概览', 'GOAL.md': '项目目标', 'ARCHITECTURE.md': '项目架构' }[relative] || `模块知识：${path.posix.basename(relative, '.md')}`);
      const offset = frontmatter ? frontmatter[0].length : 0;
      content = content.slice(0, offset) + `# ${title}\n\n` + content.slice(offset);
      validateMarkdown(content, relative);
      bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_KNOWLEDGE_FILE_BYTES) throw Object.assign(new Error(`分析文档超过大小限制：${relative}`), { code: 'INVALID_ARGUMENT' });
      AtomicFile.writeFileAtomic(file, bytes);
      normalized.push(relative);
    } else validateMarkdown(content, relative);
    operation.sha256 = hash(bytes);
  }
  AtomicFile.writeJsonAtomic(input.manifestPath, manifest);
  return normalized;
}
function finalizeAnalysisOutput(input) {
  try { return finalize(input); }
  catch (error) { error.phase = 'validating'; throw error; }
}
module.exports = { finalizeAnalysisOutput };
