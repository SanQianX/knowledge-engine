# AGENTS.md — knowledge-engine 开发指南

本文件供人与开发 agent 共用：说明这个项目为什么存在、现在做到哪、往哪走、规矩是什么。对外接口契约（模块接线、API 表）见 [README.md](README.md)，两者冲突时以 README 为准。

## 一、这个项目是干什么的

knowledge-engine 是 `project-knowledge`（项目知识库）模块家族的第四个模块：**知识引擎**。它要回答两个问题：

1. **commit 发生之后，谁来触发知识库的分析与生成？**（触发面）
   消费 event-bridge journal 里的 commit boundary 与关联会话事件，对账、认领 commit，拉起无头 Claude Agent SDK 会话做分析，产物经 staging 校验后晋升为知识树（README / GOAL / ARCHITECTURE / modules / changes）。
2. **开发 agent 写代码时，怎么从知识库检索相关内容辅助开发？**（检索面）
   提供 search / ask / get / history。MCP server（`project-knowledge-mcp`）与 `project-knowledge-kb` CLI 直接指向本服务，开发 agent 开工前先检索，拿到带引用的知识上下文。

### 为什么从 shell 拆出来（立项动机）

这两个能力原本长在 project-knowledge 的 shell 进程里（`post-commit-automation` / `commit-reconciler` / `knowledge-promotion` / `knowledge-tool-runtime`），有三个问题：

- 违背 shell 自己的架构教条 **"The shell owns no features — it only connects and projects"**；
- 一个 15 分钟的分析任务崩了会炸掉后端主进程——分析运行需要进程隔离；
- 触发面绑在 shell 上，每接一个 IDE（claude / codex / opencode / zcode…）都要在 `SUPPORTED_CLIENTS` 里逐个适配。拆出后**事件总线是唯一入口，触发面 IDE 无关**：任何 IDE 的钩子把事件写进 journal，本模块作为注册消费者自己取。

## 二、数据流与家族关系

```
任意 IDE（claude / codex / opencode / zcode）
  └─ capture hooks（UserPromptSubmit / Stop / post-commit）
      └─ event-bridge journal（8790，唯一入口）
          └─ knowledge-engine（5790，注册消费者）
              ├─ 触发面：对账 → 认领 → 无头分析会话 → staging 校验 → 晋升知识树（单写者）
              │            └─ 知识树变更 → vector-hub（8787）派生向量索引
              └─ 检索面：search / ask ← MCP server / kb CLI ← 开发 agent
```

shell（project-knowledge，5757）只做连接与投影：反代 `/api/engine/*`、项目导入时扇出登记（wiring 写 `state.modules.engine`）、supervisor 拉起与守护。Agent Terminal（5760）与知识生成无直接耦合。

## 三、目录结构与运行

```
src/bin.js      CLI：serve [--port 5790] [--host 127.0.0.1] [--data DIR]
src/server.js   HTTP 路由 + 管道（当前 stub，见"实现状态"）
src/store.js    单文件 JSON 状态层（<data>/engine-state.json，tmp+rename 原子写）
src/seed.js     首启演示数据 + 检索语料
ui/             调试台（index.html / app.js / app.css，原生三件套，无构建步骤）
data/           运行状态（gitignore，删掉即重置回 seed）
```

```bash
node src/bin.js serve        # http://127.0.0.1:5790 即调试台
node -c src/server.js        # 语法检查（当前无测试框架，改完至少过一遍五个文件的 node -c）
```

调试台五区块：**概览**（计数/游标/服务信息）、**项目**（注册/摘除）、**分析运行**（状态机 + staging manifest 详情，可模拟失败态）、**检索调试**（search 得分 / ask 引用）、**事件流**（可注入测试事件）。设计 token 与 event-bridge / vector-hub 控制台同一套（灰阶四层 + 单一蓝 + 语义红绿），改样式从 `:root` token 改起，不要引入新配色。

## 四、当前实现状态（v0.1 脚手架）

API 面与调试台全通；**管道内部是 stub**，每个 stub 在 `src/server.js` 里标了接线阶段：

| stub | 真实现来源（project-knowledge-base 仓库） | 阶段 |
|---|---|---|
| `POST /api/search\|ask` 内置语料词频打分 | `_site/lib/knowledge-tool-runtime.js`（BM25 + 向量）整体迁入 | ① 拆检索 |
| `POST /api/runs` 定时器状态机 | `commit-reconciler.js` + `claude-cli-runner.js`（Agent SDK）+ `knowledge-promotion.js` 迁入；带 `KB_AUTOMATION_FAKE_CLAUDE` / 超时 / 启动对账语义 | ② 拆触发 |
| 本地事件 store + 游标 | 向 event-bridge 注册 consumer（`consumer-registry`），自行 drain journal | ③ journal 原生入口 |
| 独立运行 | `_supervisedSpecs` 条目 + `vendor-manifest.json` + `release:verify` 门禁 | ④ 收编 |

阶段 ① 完成的标志：MCP 与 kb CLI 改指本服务后，检索行为与迁出前一致（客户端零感知）。阶段 ② 完成的标志：真 commit 在真仓库上跑出与旧管道等价的晋升产物。

## 五、开发约定（在本仓库开发必读）

- **零依赖、CommonJS、Node ≥ 18**。本模块会被 vendoring 进 `project-knowledge-base/_modules/`，不带自己的 node_modules，跨包解析靠宿主 NODE_PATH——**永远不要引入 npm 依赖**（连 devDependencies 也不要，构建步骤同理）。
- **默认绑定 loopback**。运行历史含 commit 证据与知识内容，不出本机；`--host` 是显式豁免。
- **知识树单写者**：只有晋升路径可以写知识树；检索面只读。
- **secrets 不落盘**：AI profile / API key 由 shell 在注册时下发，本模块不持久化凭据。
- **状态写入走 `EngineStore` 的原子写**（tmp + rename），不要在别处直接写 `engine-state.json`。
- **接真一个 stub 时**：删 stub 逻辑与对应 seed 演示语义、更新 README 实现状态表、保留 `simulateFailure` 这类调试入口（调试台靠它演示状态展示）。
- 注释只写代码本身说不出的约束（为什么、边界在哪），不写流水账；面向用户的文案用中文。

## 六、禁区

- 不把项目注册表、设置、secrets 搬进本模块——spine 留在 shell，模块只接 `repoPath` + `knowledgePath`。
- 不绕过 event-bridge journal 直连任何 IDE 的钩子——入口唯一，否则触发面重新变成逐 IDE 适配。
- 调试台不引外部 CDN / 字体 / 框架——离线可用是家族控制台的既定标准。

## 七、与上游仓库的联动

- vendored 到 `project-knowledge-base/_modules/knowledge-engine/`（`npm run vendor:modules`）；上游 `release:verify` 会门禁 vendored runtime 存在**且被 git 跟踪**——本仓库提交时确保 `src/`、`ui/` 都已跟踪，别被全局 ignore 规则吞掉（4.3.1 踩过的坑）。
- shell 侧接线点：`_site/lib/module-bridge.js`（`_supervisedSpecs()`、`proxy`、`registerProjectLinks`）与 `_site/lib/integration-installer.js`（MCP 指向本服务）。
