'use strict';
// Entire query families are assigned to one split; paraphrases never leak
// between calibration and held-out evaluation. Labels are document-level.
const topics = [
  { id: 'export', split: 'train', file: 'modules/json-export.md', title: 'JSON 导出参数校验', text: 'exportRecords 校验 records 数组参数。JSON 导出拒绝非法参数，并返回 records 与 memoryLabel 字段。argument validation validates array inputs.', queries: ['JSON 导出怎么校验参数', 'exportRecords 的输入约束', 'JSON export argument validation', '导出 records 时如何拒绝错误参数', '导出结果的 memoryLabel 字段是什么'] },
  { id: 'alignment', split: 'train', file: 'modules/alignment.md', title: '多点对齐数组', text: '对齐点使用 alignmentPoints 数组，画布与对象树同步。alignment point arrays support selection and deletion.', queries: ['对齐点数组如何编辑', 'alignmentPoints 的选择删除', 'alignment point arrays', '画布怎样同步多个对齐点', '对齐点和对象树如何联动'] },
  { id: 'schema', split: 'train', file: 'modules/recipe-schema.md', title: '配方格式兼容旧版', text: 'Plate 配方 JSON schema 将 lightAdjustPoint 单点转换为 lightAdjustPoints 数组。读取旧字段，保存为新格式。schema migration preserves legacy recipes.', queries: ['旧配方的 lightAdjustPoint 怎么兼容', '配方 schema 格式迁移', 'lightAdjustPoints 和旧单点有什么区别', 'legacy recipe schema migration', 'Plate 调光点如何转换成多点数组'] },
  { id: 'heartbeat', split: 'train', file: 'modules/tcp-heartbeat.md', title: 'TCP 心跳连接超时', text: 'TCP connection heartbeat 监测连接超时，断开后指数退避重连。心跳不回复时发送连接异常。', queries: ['TCP 心跳不回复怎么处理', 'connection heartbeat timeout', 'TCP 连接超时怎样重连', '心跳监测连接异常', '断线后的 TCP 指数退避'] },
  { id: 'import', split: 'train', file: 'modules/project-import.md', title: '项目双目录导入', text: '项目导入绑定代码目录 repoPath 和知识目录 knowledgePath。校验 Git 仓库身份和目录写入冲突，取消选择保持路径不变。', queries: ['双目录导入是什么', 'repoPath 和 knowledgePath 怎么绑定', '导入目录冲突如何校验', '导入时取消选择是否保留路径', '导入如何识别 Git 仓库身份'] },
  { id: 'index', split: 'train', file: 'modules/vector-storage.md', title: '向量索引跟随知识根目录', text: 'vector 向量索引位于知识根目录的 .indexes 派生目录，不能放到 C 盘长期积累。索引失败只重试索引，不再次分析。', queries: ['向量索引保存在哪里', '.indexes 是什么目录', 'vector 索引失败能否只重试索引', '知识根目录和向量存储的关系', '如何防止向量索引占满 C 盘'] },
  { id: 'hooks', split: 'train', file: 'modules/native-context.md', title: '原生开发前知识读取 Hook', text: 'UserPromptSubmit context-hook.cjs 读取项目知识和适用的已确认长期记忆。bridge-hook.cjs 只采集对话，采集不等于读取。', queries: ['UserPromptSubmit 怎样读取长期记忆', 'context-hook.cjs 的作用', '采集 Hook 和知识读取有什么区别', '开发前自动知识上下文入口', 'bridge-hook.cjs 是否负责检索'] },
  { id: 'stream', split: 'train', file: 'modules/message-stream.md', title: '工作台流式消息与会话恢复', text: 'Agent 工作台通过 SSE 游标恢复流式消息。切换项目保留草稿，不重新创建 iframe，不把迟到的 A 会话消息画到 B 项目。', queries: ['工作台 SSE 怎么恢复消息', '切换项目如何保留草稿', 'iframe 为什么不能重建', 'A 会话的迟到消息怎么隔离', 'Agent 流式消息断线恢复'] },
  { id: 'station', split: 'train', project: 'project-review', file: 'modules/station-transform.md', title: 'A→B 工位坐标变换', text: 'MaskScanReview 使用 StationTransform 将 A 工位坐标转换到 B 工位。标定中心和旋转角度决定映射结果，禁止用于 Plate 未保存状态。', queries: ['A→B 工位坐标怎么变换', 'StationTransform 标定中心', '工位旋转角度如何影响映射', 'MaskScanReview 坐标转换的背景', 'B 工位标定映射规则'] },
  { id: 'quantum', split: 'train', expected: null, queries: ['量子纠缠如何预测天气', '星际飞船曲率推进系统', '黑洞辐射频谱测量', '深海鲸鱼迁徙路线', '火星农业收成预测'] },
  { id: 'greeting', split: 'train', expected: null, queries: ['你好', 'hello', 'Hi!', '早上好', '在吗？'] },
  { id: 'absent', split: 'train', expected: null, queries: ['不存在的 zzzImaginarySymbol', 'zzMissingQuantum.cjs', 'totallyAbsentOpcode', 'unknownInterstellarModule', 'neverSeenGalaxyContract'] },
  { id: 'loss-guard', split: 'test', file: 'changes/ef123b6058ea.md', title: '首次进入 Plate 误弹未保存提醒', text: '首次进入 Plate 编辑器没有修改却误弹未保存弹窗。m_isNewPlate 初始为 false，历史加载恢复 isPlateSaved。尚无真正 dirty 编辑追踪，用户修改后离开仍需要完善提醒。', queries: ['第一次进入 Plate 为什么提示未保存', '没改配方就出现未保存弹窗', 'm_isNewPlate 初始值修复', 'isPlateSaved 历史加载状态', 'Plate 未保存提醒还缺什么 dirty 追踪'] },
  { id: 'recent', split: 'test', expected: 'changes/ef123b6058ea.md', queries: ['当前项目最近的进度是什么', '最近一次开发的东西是什么', 'hello 当前项目最新提交做了什么', 'latest project development progress', '上次开发修改了哪些东西'] },
  { id: 'plc', split: 'test', file: 'modules/plc-calibration.md', title: 'PLC 标定数据读取', text: 'AB PLC 标定通过 calibrationLink 读取标定点和设备寄存器。校验寄存器长度，遇到设备错误保留先前标定数据。', queries: ['PLC 标定点如何读取', 'calibrationLink 的读取约束', 'PLC 寄存器长度怎么校验', '设备错误时标定数据是否保留', 'AB PLC 标定寄存器'] },
  { id: 'foreign-domain', split: 'test', expected: null, queries: ['财务领域 creditLedger 核算', 'creditLedger 账本结转', 'creditLedger 凭证审计', 'creditLedger 会计期末', 'creditLedger 财务余额'] },
];
const documents = topics.filter(t => t.file).map(t => ({ projectId: t.project || 'project-recipe', entry: t.file, text: `# ${t.title}\n\n${t.text}\n` }));
documents.push({ projectId: 'project-other', entry: 'modules/finance.md', text: '# 财务 creditLedger\n\ncreditLedger 财务账本、凭证、审计与期末核算。\n' });
const cases = topics.flatMap(t => t.queries.map((query, i) => ({ id: `${t.id}-${i}`, family: t.id, split: t.split, query, projectId: 'project-recipe', scope: 'domain',
  expected: t.expected === null ? [] : [{ projectId: t.project || 'project-recipe', entry: t.expected || t.file }] })));
module.exports = { documents, cases };
