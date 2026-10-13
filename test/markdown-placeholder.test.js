'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMarkdown } = require('../src/runtime/knowledge-promotion');

const accept = content => assert.equal(validateMarkdown(content, 'changes/x.md'), true);
const reject = content => assert.throws(() => validateMarkdown(content, 'changes/x.md'), /Placeholder knowledge is not allowed/);

test('accepts documents that factually describe UI placeholder attributes and samples', () => {
  accept('# 手动记忆\n\n给 `#memoryText` 增加 placeholder「例如：对外错误信息使用中文；优先复用已有模块。」，既有入口不变。\n');
  accept('# 表单\n\n导入对话框的 `#importCode` 保留 placeholder="D:\path\my-project"。\n');
  accept('# 表单\n\n对话框统一使用 PLACEHOLDER="示例文本" 属性。\n');
  accept('# 表单\n\n该属性在源码中拼作 Placeholder=，正文照抄字段名。\n');
  accept('# 表单\n\n字段名见行内代码 `placeholder` 一词，不构成未完成内容。\n');
  accept('# Dialogs\n\nThe Text input keeps its placeholder \'Enter a project name\'.\n');
  accept('# 记忆\n\n记忆对话框的输入字段使用 placeholder「例如：对外错误信息使用中文」。\n');
});

test('rejects unfinished placeholder markers in every casing and quoting', () => {
  reject('# 草稿\n\n这一节 placeholder 后续补充。\n');
  reject('# 草稿\n\n## PLACEHOLDER\n正文还在。\n');
  reject('# 草稿\n\n孤立占位 placeholder「待补」。\n');
  reject('# 草稿\n\n示例仍是 placeholder \'TODO\'。\n');
  reject('# 草稿\n\nPlaceHolder 待完成。\n');
  reject('# 草稿\n\n占位说明 placeholder「…」。\n');
  reject('# 草稿\n\n这一节先写 placeholder「后续再说」。\n');
  reject('# 草稿\n\nsample remains placeholder \'fill this in later\'.\n');
  reject('# 标题\n\n`PLACEHOLDER`\n');
});

test('still rejects TODO and TBD unfinished markers', () => {
  reject('# 草稿\n\nTODO: 补充这一节\n正文。\n');
  reject('# 草稿\n\n[TODO: x] 与 TBD 待定。\n');
});

test('does not lend UI context across paragraphs or into the quoted value', () => {
  reject('# 表单\n\n输入框 placeholder「Enter」。\n\nplaceholder「Enter」。\n');
  reject('# 草稿\n\n孤立 placeholder「这个文案后续再说」。\n');
});

test('rejects bare placeholders beside UI context and empty UI samples', () => {
  reject('# 表单\n\n输入框的 placeholder 说明待补。\n');
  reject('# 表单\n\n输入框 placeholder「」。\n');
  reject('# 表单\n\n输入框 placeholder「…」。\n');
});
