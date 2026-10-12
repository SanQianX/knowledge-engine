# knowledge-engine

正式知识检索（包括 `get`）排除 `dev-conversations`、内部会话、备份与隐藏目录。提交会话只作为分析证据，不直接充当已晋升知识；原始证据仍由事件模块保留。

> 开发前读 [AGENTS.md](AGENTS.md)。该指南中的脚手架状态是历史背景；当前运行契约及实现状态以本 README 为准。

`project-knowledge` 模块家族的第四块：**知识引擎**。owns 两个职责面，shell 只负责连接与投影（"The shell owns no features"）：

- **触发面**：消费 event-bridge journal 的 commit boundary 与关联会话事件 → CommitReconciler 对账/认领 → 无头 Claude Agent SDK 会话分析 → staging 校验 → 晋升知识树（README / GOAL / ARCHITECTURE / modules / changes）。
- **检索面**：search / ask / get / history，供开发期辅助检索。对外入口：MCP server 与 `project-knowledge-kb` CLI 直接指向本服务。

## 家族关系

| 模块 | 端口 | 职责 |
|---|---|---|
| claude-ai-workbench | 5760 | Agent Terminal |
| vector-hub | 8787 | 知识树向量索引 |
| ai-coding-event-bridge | 8790 | 会话/commit 事件总线 |
| **knowledge-engine** | **5790** | **知识生成（触发面）+ 知识检索（检索面）** |

数据流：任意 IDE（claude / codex / opencode / zcode）→ bridge hooks → journal → **knowledge-engine（注册消费者）** → 分析运行 → 知识树 → vector-hub 派生向量索引 → 检索面/MCP 供开发 agent 查询。

## 与 shell 的接线契约（模块契约）

- **env**：`KB_KNOWLEDGE_ENGINE_URL`（默认 `http://127.0.0.1:5790`）、`KB_KNOWLEDGE_ENGINE_COMMAND`（显式命令行覆盖）、随家族一起受 `KB_MODULES_AUTOSTART=0` 约束。
- **supervisor**：shell `_supervisedSpecs()` 增加本模块条目（vendored runtime 位于 `project-knowledge-base/_modules/knowledge-engine/`），探测已监听则不重复拉起，退出指数退避重启。
- **反代**：`/api/engine/<rest>` → 本服务 `/api/<rest>`，浏览器同源，无 CORS。
- **注册扇出**：项目导入时随 terminal/vector-hub/event-bridge 一并登记（`repoPath` + `knowledgePath`），wiring 写入 `state.modules.engine`，摘除走 keep-data 语义（知识树与运行历史不删）。

## 运行

```bash
node src/bin.js serve [--port 5790] [--host 127.0.0.1] [--data DIR]
```

打开 `http://127.0.0.1:5790` 即调试台。默认绑定 loopback：运行历史包含 commit 证据与知识内容，不出本机。

首次启动为空，不创建演示项目。`--debug` 才开放手工运行、事件注入和模拟失败。独立运行默认只提供读取与诊断；设置 `KNOWLEDGE_ENGINE_CONSUME=1` 开始消费。外壳守护使用 `KB_ENGINE_MANAGED=1`，确认服务身份、运行期鉴权、项目接线及配置后启用消费与执行；不再导入旧外壳任务。

0.2.0 使用全新 schemaVersion 3，独立运行默认目录为 `./data-v3`。旧版状态目录明确拒绝读取，原文件保持不变；不备份后重置、不迁移、不创建 `upgrade-recovery`。同一新版数据目录内的崩溃恢复仍保留。

本模块零新增 npm 依赖、CommonJS、Node ≥18；无头 Agent SDK 由宿主已安装的 Workbench/SDK 提供，缺失时明确失败，不退回假分析。完整产品的 Node 门槛为 ≥22。

隔离无头分析只读冻结证据、只写 staging，不以开发工作树的前后变化判定失败。用户可以在分析中继续编辑或提交；当前任务仍归属冻结提交，后续提交按项目 FIFO 执行。未声明隔离冻结证据能力的自定义分析器仍保留源码变更检查；目录越界、工具权限和晋升校验不变。

每次真实分析在只读证据区冻结已有知识的目标路径与哈希清单，覆盖未被检索选中的文件；重试复用该清单。Agent 不得把“未检索到”当作“文件不存在”，也不得用部分片段覆盖完整旧文档；无法保留原文时只追加当前提交的变更记录。已有目标仍由晋升校验拒绝非法 create，不自动改为覆盖。清单仅保存元数据，不把整个知识树复制到每次运行中。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 版本 / dataSchemaVersion / uptime / 计数 / journal 游标 |
| GET / POST | `/api/projects` | 项目列表 / 注册（按 projectId 幂等） |
| DELETE | `/api/projects/:id` | 摘除登记，取消未开始任务；实际运行或写入租约未释放时返回 409；保留代码、知识和证据 |
| GET | `/api/runs?projectId=` | 分析运行列表（新→旧） |
| POST | `/api/runs` | 仅调试模式手工运行；必填完整 `commitSha` |
| GET | `/api/runs/:id` | 运行详情（含 staging manifest） |
| POST | `/api/runs/:id/retry` | 只恢复失败阶段；索引失败不重新分析 |
| POST | `/api/search` | `{ projectId 或 repoPath, query, limit, scope }` → 带项目、文件、commit 的结果 |
| POST | `/api/ask` | `{ projectId, query }` → 确定性答案 + 引用（非 LLM 生成） |
| GET / POST | `/api/get`、`/api/history` | 当前知识文件 / 变更历史，保留 CLI/MCP 输出字段 |
| GET | `/api/snapshot`、`/api/progress` | 持久化快照 / 快照先行的 SSE 更新 |
| GET / POST | `/api/events` | 真实事件查询 / 仅调试模式注入事件 |
| POST | `/api/bridge/notify` | 唤醒 journal 消费；通知丢失仍由轮询恢复 |
| GET / PATCH | `/api/memories`、`/api/memories/:id` | 按 status/scopeType/scopeId 筛选；一次编辑内容、适用范围和确认状态；来源证据只读 |
| POST | `/api/scopes` | 外壳投影智脑、领域共享目录；受运行期鉴权保护 |
| POST | `/api/runtime-config` | 运行期模型配置，仅保留在内存；受鉴权保护 |
| GET | `/api/runtime-auth` | 本机服务确认运行期鉴权；受鉴权保护，不对浏览器反代 |
| POST | `/api/control` | 外壳完成接线后启用；受鉴权保护。旧 `/api/migrate` 已删除 |

鉴权接口只接受无浏览器 Origin 的本机服务调用，使用 `KB_ENGINE_RUNTIME_TOKEN` 的 Bearer token。外壳不能把这些接口或解析后的凭据转发到浏览器。登记投影只接受白名单元数据，API key 不写入 EngineStore、任务记录或日志。

## 真实运行与恢复边界

- journal 游标按来源隔离；证据投影及可恢复任务先落盘，再 ACK。不等待模型才能消费下一条事件。
- 会话来源接受 bridge 的四客户端契约（Claude Code、Codex、OpenCode、ZCode）。单个 journal 的非法证据不被跳过或 ACK，但不阻塞其他项目；失败位置和错误码写入日志，健康接口提供 `journal.failures`，重复轮询不刷屏，恢复后续接原游标。
- 不同项目最多并发 2 个分析，同项目按提交顺序执行。未晋升的失败提交会阻挡本项目后续提交，不阻挡其他项目。
- 无头分析在隔离进程中运行，只读冻结证据，只写本次 staging。产物必须通过路径、内容 hash 和依据校验，只有晋升路径写最终项目知识。
- 归档对话和检索内容只作证据，不能覆盖后台维护指令。SDK 返回成功文字但未生成 manifest 时，记录 `ANALYSIS_OUTPUT_MISSING` 并保留证据供重试，不误报晋升完成。
- 空知识库是正常首用状态。输出合同明确 UTF-8、一级标题和非空正文；仅缺标题的非空文档在 staging 中确定性补齐并重新封印哈希，空正文、非法路径、占位内容或不匹配哈希仍拒绝晋升。
- 具体失败原因、失败步骤和提交依据进入运行详情及 `log/v2` 诊断。受外壳守护时通过 IPC 交给外壳现有日志系统；独立运行保存在 `<data>/logs/`，不写模型凭据和原始证据。升级不会重新运行已失败提交，用户可显式重试失败阶段。
- 数据目录有单实例租约，目标知识目录有写入锁。关闭或超时等待子进程实际退出，再释放写入锁。
- 晋升与索引分别记录。索引失败保留已晋升知识并显示待修复，不重新调用模型。
- 索引错误保留兼容的 `INDEX_FAILED` 及可选 `error.details`（类别、HTTP 状态、上游代码/脱敏原因、请求标识、耗时和尝试次数）；项目和共享索引均写入 `log/v2`。响应仅解析有界 JSON，不记录原始 body 或认证头。只重试索引保留原分析运行、晋升时间和知识字节。
- 项目、领域、智脑检索使用包含范围。未分配领域不是共享领域：领域范围只包含当前项目与智脑共享知识；显式加入同一领域后才包含其他项目。整个智脑范围仍包含全部同智脑项目。向量只提供排序，显示内容必须来自当前真实文件；索引不可用时降级为文件检索。
- 已晋升提交的 SHA 或短 SHA 在自然语言查询中仍作为标识符匹配，只返回当前文件的晋升依据；仅在原始会话中提到相同 SHA 不构成知识晋升引用。多个提交标识符可以一起查询。
- 候选必须有已晋升文件中的引用依据，未确认候选不能进入任务。确认记录原子持久化后写共享记忆文件，派生索引异步更新，索引失败不会撤销有效记忆。
- 候选的 `entryId` 必须等于本次晋升清单中实际文档的 `operations[].path`，不是候选编号；引用必须与该文档原文匹配。无效候选不会伪造来源或阻塞有效知识更新，运行的 `memoryCapture` 与 `knowledge.memory.candidate_rejected` 日志记录安全的计数、序号和原因代码。
- 记忆的适用范围为 `global/domain/project`，目标用 `scopeId` 指定；来源项目/领域不等于适用范围。新候选默认来源项目，分析器只有明确证据时才建议领域/全局；用户审核时可以编辑内容并选择当前智脑中的其他已有目标。原始总结与证据保持不变，同一范围内容去重，忽略和编辑后的原候选不会重复生成。
- 长期记忆统一保存在已绑定的智脑共享目录：`memories/confirmed.md`（全局）、`memories/domains/<id>.md`、`memories/projects/<id>.md`。不创建第二份项目知识目录。现有 v5 缺少范围字段的记忆仍按全局解释；不读取 pre-v5 状态、不重扫历史。
- 任务检索只允许当前项目、当前所属领域与全局的已确认记忆，即使检索整个智脑也不放宽专属记忆范围。过滤在排名之前完成，`get` 同样校验；向量旧内容不能绕过当前状态和文件一致性校验。已确认记录修改范围会同步清理旧投影；写入失败显示待同步并自动重试，未同步文件不能进入上下文。
- 旧格式不读取、不自动迁移。损坏的正式状态不覆盖、不清空。
- 引擎状态复用受控原子写入：独占随机临时文件、文件同步、Windows 短暂共享冲突有界重试；永久失败保留原状态并清理本次临时文件，绝不先删正式状态。

## 验证与尚未验收项

`npm test` 覆盖真实 Git/Hook、真实分项目 journal、真实 vector-hub 文件索引、晋升、重复抑制、FIFO/并发、记忆、旧格式拒绝、新版恢复及进程隔离。自动测试中的模型和 embedding 是可控替身。

`npm run test:web` 使用兄弟源码仓库启动隔离的五服务网页环境，只有模型与 embedding 是替身。单一 1920×1080 视口验证双目录 UI 导入、真实 Hook 到自动刷新、原生消息流与中止、快速项目切换/草稿/历史、迟到检索及文件响应、领域检索、记忆落盘、四 iframe 身份与主题、唯一进度连接、诊断关闭和保留数据解绑；不会在用户代码仓库提交。该脚本是开发验收工具，不属于引擎生产运行依赖。

`npm run test:web:faults` 从真实网页重试模型超时和索引失败，验证同项目 FIFO 恢复、不同项目继续运行、非法产物不写最终知识、浏览器离线时后台仍完成维护、恢复连接后自动恢复快照及唯一订阅，并检查私有接口鉴权及公开状态不含测试凭据。故障注入只存在于明确启用的验收替身，不进入生产管道。

`test/support/product-preview.js` 提供隔离的四模块加外壳验收环境，绝不使用用户代码仓库进行测试提交。显式设置 `KB_ACCEPTANCE_REAL_PROFILE_ID` 才会从本机 Workbench 只读复制所选模型配置；`real-agent-acceptance.js` 验证真实模型提交和并发，并保留失败记录。默认 embedding 是替身；`KB_ACCEPTANCE_REAL_EMBEDDING=1` 才会只读复制实际向量供应商配置，`verify-real-embedding.js` 检查实际向量维度、语义查询及来源。

已完成真实 MiniMax-M3 分析、单项目提交、双项目并发、知识晋升、真实 embo-01 索引/检索，以及原生工作台流式回答和引用抽测。`verify-real-capture.js` 另检查实际工作台输入/最终回答经过鉴权 bridge 进入提交归档和引擎冻结证据，不把注入的上下文伪装成用户输入。

本地 npm 候选包已在隔离安装目录启动四模块，校验包内 UI 与运行文件，不依赖兄弟源码仓库。本轮按用户确认仅交付网页版本，Windows 安装包、安装器和桌面自动更新不在实施或验收范围内。新版外壳完整回归与五服务网页核心验收已通过；剩余故障组合及最终切换验收单独记录。远程发布及 Git 跟踪门禁也单独记录，不以工作树校验代替发布通过。此前使用替身 embedding 的真实模型记录，与本轮真实模型加真实 embedding 记录分别保存。详见 [实施与验收记录](docs/unified-product-implementation.md)，不得据此宣称五仓库改造已全部交付。
