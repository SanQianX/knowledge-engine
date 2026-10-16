'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rank } = require('../src/retrieval-ranking');
const candidate = text => ({ recordId: 'one', spaceId: 'project:a', entryId: 'changes/a.md', title: '桌面服务', headingPath: [],
  chunkText: text, contentHash: 'one', scopeReason: 'primary', vectorVerified: true, vectorCalibrated: true, indexScore: 0.99, vectorMinScore: 0.5 });
const identity = () => ({ selectionSignals: [] });
test('calibrated vector similarity cannot supply an absent named technology', () => {
  const rows = [candidate('桌面服务在端口冲突后选择下一空闲地址。')];
  assert.equal(rank(rows, '当前项目 PostgreSQL 主从故障切换与 WAL 归档策略是什么？', identity).length, 0);
  assert.equal(rank(rows, 'OpenTelemetry traces 如何配置？', identity).length, 0);
});
test('documented names and Chinese semantic paraphrases retain calibrated vector recall', () => {
  assert.equal(rank([candidate('PostgreSQL 采用流复制并保留 WAL 归档。')], 'PostgreSQL 如何故障切换？', identity).length, 1);
  assert.equal(rank([candidate('桌面服务在端口冲突后选择下一空闲地址。')], '监听地址被占用之后怎么办？', identity).length, 1);
  assert.equal(rank([candidate('复用已有模块并检查边界。')], '新建 RendererService.js 时需要参考哪些设计？', identity).length, 1, 'a new filename still permits analogous background');
});
