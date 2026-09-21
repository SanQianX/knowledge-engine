# knowledge-engine

> 在本仓库做开发（人或 agent）先读 [AGENTS.md](AGENTS.md)：立项动机、实现状态、四阶段路线图与开发约定都在那里；本 README 只保留对外契约。

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

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 版本 / uptime / 计数 / journal 游标 |
| GET / POST | `/api/projects` | 项目列表 / 注册（按 projectId 幂等） |
| DELETE | `/api/projects/:id` | 摘除登记 |
| GET | `/api/runs?projectId=` | 分析运行列表（新→旧） |
| POST | `/api/runs` | 触发分析（`{ projectId, commitSha?, note?, simulateFailure? }`） |
| GET | `/api/runs/:id` | 运行详情（含 staging manifest） |
| POST | `/api/search` | `{ projectId, query, limit }` → 得分结果 |
| POST | `/api/ask` | `{ projectId, query }` → 确定性答案 + 引用（非 LLM 生成） |
| GET / POST | `/api/events` | 事件流查询 / 注入测试事件 |

## 实现状态（v0.1 脚手架）

调试台与 API 面全通；管道内部为 stub，每个 stub 标注了接线阶段：

1. **阶段 1 · 拆检索**：`/api/search|ask` 接真 BM25 + 向量运行时（从 project-knowledge 的 `knowledge-tool-runtime` 迁移），shell 的 `/api/knowledge/*` 改透明反代——MCP、CLI 零改动。
2. **阶段 2 · 拆触发**：`/api/runs` 背后接 CommitReconciler + 无头 Agent SDK + staging 校验晋升（含 `KB_AUTOMATION_FAKE_CLAUDE`、超时语义、启动对账）；shell `/api/hooks/post-commit` 变转发。
3. **阶段 3 · journal 原生入口**：向 event-bridge 注册为 consumer，自行 drain commit boundary 与会话事件（替换本地事件 store 与游标）。
4. **阶段 4 · 收编**：`_supervisedSpecs` 条目 + `vendor-manifest.json` + `release:verify` 对 vendored runtime 的门禁。
