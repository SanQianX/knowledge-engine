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

test('accepts the real 532d maintenance document essence with bare factual placeholder terminology', () => {
  accept([
    '# 修复占位校验误判：区分带引号的 UI placeholder 事实与未完成知识',
    '',
    '- 事实性 UI placeholder 描述放行：带引号样例需要同句 UI 字段/属性上下文，判定不跨段借用。',
    '- 同句裸 placeholder 与空样例仍拒绝：`输入框的 placeholder 说明待补`、`placeholder「」`、`placeholder「…`。',
    '',
    '> 只在有同句明确 UI 字段/属性上下文时豁免带引号的 placeholder；其余仍按未完成知识处理。',
    '',
    '## 本次未涉及',
    '',
    'TODO/TBD、控制字符、标题、围栏闭合、frontmatter、manifest 与路径校验均未改动。',
    'TODO/TBD 正则之外不再有其它提交依据、边界或 manifest 校验变化。',
    '',
  ].join('\n'));
});

test('accepts factual sentences that describe the placeholder attribute itself', () => {
  accept('# 表单\n\nplaceholder 属性描述：输入框的提示文案由该字段提供。\n');
  accept('# 规则\n\n界面字段校验说明：裸 placeholder 术语出现在事实句中时按属性名理解。\n');
});

test('still rejects technical wording without UI context or with explicit to-be-filled intent', () => {
  reject('# 草稿\n\n校验规则说明：裸 placeholder 术语出现在事实句中，不构成未完成内容。\n');
  reject('# 草稿\n\n结论：TBD。\n');
  reject('# 草稿\n\n正则待补：TBD 方案尚未确定。\n');
  reject('# 表单\n\n输入框 placeholder 样例待补：事实描述随后给出。\n');
  reject('# 表单\n\nplaceholder 描述：输入框的提示文案后续补充。\n');
});

test('still rejects TBD planning predicates even beside technical nouns', () => {
  reject('# 规则维护\n\n正则解析器实现 TBD。\n');
  reject('# 规则维护\n\n围栏识别逻辑 TBD。\n');
  reject('# 规则维护\n\nfrontmatter处理 TBD。\n');
  reject('# 规则维护\n\nTODO/TBD 属于待定的技术名词。\n');
  reject('# 规则维护\n\nTODO/TBD 清单计划下一版补充。\n');
});

test('accepts complete English factual statements about the placeholder attribute', () => {
  accept('# UI controls\n\nThe input placeholder attribute describes the project-name hint shown in the dialog.\n');
  accept('# Forms\n\nThe dialog input keeps its placeholder behavior specified by the UI field contract.\n');
});

test('still rejects unfinished English placeholders and empty or ellipsis quotes beside UI explanations', () => {
  reject('# UI\n\nThe input placeholder text is TBD.\n');
  reject('# UI\n\nThe input placeholder attribute description comes later.\n');
  reject('# 表单\n\n输入框的 placeholder 属性说明「」完整。\n');
  reject('# 表单\n\n输入框的 placeholder 属性说明「…」后续补齐。\n');
});

test('rejects TBD completion facts borrowed from a neighbouring clause', () => {
  reject('# 规则维护\n\n配置保持原样，正则解析器实现 TBD，最后再做功能。\n');
});

test('rejects pending and to-be-refined placeholder wording beside UI context', () => {
  reject('# UI\n\nThe dialog input describes placeholder pending implementation.\n');
  reject('# 表单\n\n输入框 placeholder 属性说明待完善。\n');
});

test('accepts a factual placeholder clause beside another field with an empty value', () => {
  accept('# UI\n\nThe input placeholder attribute describes the hint, and a separate field has value \'\'. \n');
});

test('accepts a factual placeholder sentence when the other empty value shares the clause', () => {
  accept('# UI\n\nThe input placeholder attribute describes the hint and a separate field has value \'\'.\n');
});

test('accepts a Chinese factual placeholder sentence with another field empty value in the same clause', () => {
  accept('# 表单\n\n输入框的 placeholder 属性描述提示文案而另一字段值为「」。\n');
});

test('still rejects an unclosed quote opening right beside the placeholder', () => {
  reject('# 表单\n\n输入框的 placeholder「Enter 未闭合。\n');
});
