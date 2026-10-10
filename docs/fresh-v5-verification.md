# 从头开始：v5 发布与验收

2026-10-10。对应外壳 5.0.0、引擎 0.2.0。用户明确取消旧数据兼容与迁移，保留网页交付范围及 npm latest 发布授权。

## 修复结果

- 删除旧外壳数据迁移、引擎接管和 `/api/migrate`，不再制造 `upgrade-recovery`。
- 默认内部数据目录 `~/.project-knowledge-v5`；模型、工作台、事件及索引的托管目录均隔离于新版目录。旧目录不读取、不删除。显式传入旧数据目录则拒绝且保持原字节不变。
- 连接前确认引擎 schemaVersion 3 与运行期鉴权，失败公开安全阶段/代码，不再吞掉接管错误。只有接线完成后启用 journal 消费。
- 解绑取消未开始任务，实际分析/索引写入仍返回 409。页面通过真实确认弹窗更新选择，迟到的旧登记响应不能恢复已移除项目。
- 重新导入需使用空知识目录，可明确确认替换遗留知识库托管 Hook；失败回滚原 Hook，第三方 Hook 不覆盖。不分析历史提交。
- 新版自身的恢复与去重仍保留，取消的是旧版本迁移，不是故障恢复。

## 自动回归

- 外壳：106 组后端/契约回归通过。旧数据迁移专用测试随旧实现删除，以拒绝旧目录、空启动、连接诊断、Hook 显式替换与回滚测试替代；不是将原失败迁移场景标为通过。
- 引擎：17 项通过；另补测运行期鉴权、取消队列的持久化和实际写入租约阻止解绑。
- 五服务网页：源码和官方 npm 安装版均通过。真实 Git/Hook/journal/知识文件/索引；模型与 embedding 为可控替身。只检查 1920×1080 桌面，不安排窄屏矩阵。
- npm 网页故障回归通过：模型超时重试、FIFO、项目间独立推进、仅修复索引、非法产物、离线后台维护、恢复快照/唯一订阅、私有接口鉴权及凭据保护。
- 包内四模块守护重启及正常退出通过。验收先确认鉴权和消费已启用，不能把“端口已监听”当成完整连接成功。首次工具误用已有 5803 端口，改用独立 5805 后重跑；失败尝试不计为通过。

## 官方 npm 安装

已发布并确认官方 registry latest：`@sanqianx/project-knowledge@5.0.0`、`@sanqianx/ai-coding-knowledge-engine@0.2.0`。其他模块保持已验收固定版本：Workbench 0.13.0、vector-hub 1.0.7、event-bridge console 0.7.0。

全新 npm 缓存、显式独立 prefix、无 file/source 覆盖；校验 dist integrity、四模块版本、UI 与 runtime 字节，以及 vendored Git 跟踪门禁。

本机安装证据：

- `C:/Users/SanQian/AppData/Local/Temp/kb-registry-product-vknsdo/registry-installation.json`
- 同目录 `acceptance-data/installed-startup-acceptance.json`、`installed-restart-acceptance.json`、`installed-shutdown-acceptance.json`
- 本仓库 `.agent-state/acceptance/npm-web-regression/report.json`、`npm-web-faults/report.json` 及桌面截图

## 真实模型与向量（不以替身结果代替）

使用 npm 下载的五服务运行文件与隔离测试仓库；只读取得已配置的模型/embedding 凭据，原供应商配置不修改，凭据不写进本报告。

- MiniMax-M3 完成一次单项目 commit 分析、staging 晋升、真实 embo-01 索引与检索。
- 两项目分析确实重叠：A `02:46:59.579–02:48:38.484 UTC`，B `02:47:00.499–02:47:41.523 UTC`，项目/文件/提交不串。
- embo-01 实际维度 1536；统一检索确认使用真实向量能力，来源保留实际 commit。
- 页面点击发送真实工作台任务，后端流式事件、完成状态和右侧引用一致。原生会话恢复保留。
- 首次工作台测试发现用户独立 `claude-mem` 插件注入它自己的旧记忆，并非本知识库数据迁移。未删除插件或其数据；仅在测试进程设独立 `CLAUDE_CONFIG_DIR`，新会话重测通过，无该插件注入。纯净测试收到 3 个真实文本增量并引用当前新建知识的完整 SHA。

证据目录：`C:/Users/SanQian/AppData/Local/Temp/智脑桌面验收-V7oAqV/`，含 `real-agent-acceptance.json`、`real-embedding-acceptance.json`、`real-workbench-acceptance.json`。纯净页面截图：`.agent-state/acceptance/npm-web-regression/real-workbench-v5-isolated.jpg`。此前失败/受插件影响的尝试保留，不冒充纯净通过。

## 用户操作

先停止旧服务，安装 npm latest，执行 integrations update 更新客户端接线，再启动。若设置过旧 `KB_DATA_DIR`，取消它或改为新空目录。重新配置模型、后台默认模型、embedding 与知识根目录，然后从“领域与项目”导入代码目录及新的空知识目录。

旧代码与知识文件没有被删除。第三方 Agent 插件和独立 Agent 自身的记忆不属于本知识库的数据目录，不因本次新建数据库而被清理。未制作 Windows 安装包，未发布 GitHub release；不据以上有限测试声称全面稳定性认证。
