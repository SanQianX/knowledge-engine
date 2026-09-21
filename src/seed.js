'use strict';

/**
 * 首次启动的演示数据：让调试页开箱即有内容可看。
 * knowledgeCorpus 同时是检索面 stub 的语料（真实现 = BM25 + 向量，
 * 见 project-knowledge 的 knowledge-tool-runtime）。
 */
function seedState() {
  const now = Date.now();
  const iso = ms => new Date(now - ms).toISOString();
  return {
    projects: [
      {
        projectId: 'project-knowledge-base',
        name: 'project-knowledge',
        repoPath: 'D:\\SanQian.Xu\\project-knowledge-base',
        knowledgePath: 'D:\\SanQian.Xu\\knowledge\\project-knowledge-base',
        lastCommitSha: 'f4f383f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7',
        lastRunAt: iso(2 * 3600 * 1000),
        createdAt: iso(30 * 24 * 3600 * 1000),
        updatedAt: iso(2 * 3600 * 1000),
      },
      {
        projectId: 'demo-app',
        name: 'Demo App',
        repoPath: 'D:\\SanQian.Xu\\demo-app',
        knowledgePath: 'D:\\SanQian.Xu\\knowledge\\demo-app',
        lastCommitSha: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
        lastRunAt: iso(26 * 3600 * 1000),
        createdAt: iso(10 * 24 * 3600 * 1000),
        updatedAt: iso(26 * 3600 * 1000),
      },
    ],
    runs: [
      {
        runId: 'run-seed-001',
        projectId: 'project-knowledge-base',
        commitSha: 'f4f383f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7',
        trigger: 'git-hook',
        note: 'chore(release): 4.3.1 — vector-hub runtime ships',
        state: 'succeeded',
        startedAt: iso(2 * 3600 * 1000),
        finishedAt: iso(2 * 3600 * 1000 - 96 * 1000),
        durationMs: 96 * 1000,
        error: null,
        staging: {
          schema: 'knowledge-staging-manifest/v1',
          projectId: 'project-knowledge-base',
          commitSha: 'f4f383f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7',
          operations: [
            { path: 'changes/f4f383f.md', operation: 'create', reason: '发布流程修复：vendor runtime 入库与门禁', evidenceReferences: ['commit:f4f383f', 'patch:3fd2aa'] },
            { path: 'modules/release.md', operation: 'update', reason: '补充 release:verify 对 vendored runtime 的存在性检查', evidenceReferences: ['commit:f4f383f'] },
          ],
        },
      },
      {
        runId: 'run-seed-002',
        projectId: 'project-knowledge-base',
        commitSha: '1f06d2c9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3',
        trigger: 'startup',
        note: '测试隔离：module autostart 对每个测试关闭',
        state: 'failed',
        startedAt: iso(28 * 3600 * 1000),
        finishedAt: iso(28 * 3600 * 1000 - 15 * 60 * 1000),
        durationMs: 15 * 60 * 1000,
        error: 'Knowledge analyzer timed out. (KB_AUTOMATION_TIMEOUT_MS)',
        staging: null,
      },
      {
        runId: 'run-seed-003',
        projectId: 'demo-app',
        commitSha: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
        trigger: 'git-hook',
        note: 'feat: 首个知识库分析',
        state: 'succeeded',
        startedAt: iso(26 * 3600 * 1000),
        finishedAt: iso(26 * 3600 * 1000 - 74 * 1000),
        durationMs: 74 * 1000,
        error: null,
        staging: {
          schema: 'knowledge-staging-manifest/v1',
          projectId: 'demo-app',
          commitSha: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
          operations: [
            { path: 'README.md', operation: 'create', reason: '初始项目知识', evidenceReferences: ['commit:9a8b7c6'] },
          ],
        },
      },
    ],
    events: [
      { seq: 1, type: 'commit-boundary', projectId: 'project-knowledge-base', summary: 'f4f383f chore(release): 4.3.1', at: iso(2 * 3600 * 1000) },
      { seq: 2, type: 'conversation', projectId: 'project-knowledge-base', summary: 'claude-code 会话 3 轮对话与 commit 关联', at: iso(2 * 3600 * 1000 + 60 * 1000) },
      { seq: 3, type: 'knowledge.run', projectId: 'project-knowledge-base', summary: 'run-seed-001 完成：2 个操作晋升', at: iso(2 * 3600 * 1000 - 96 * 1000) },
      { seq: 4, type: 'commit-boundary', projectId: 'demo-app', summary: '9a8b7c6 feat: 首个知识库分析', at: iso(26 * 3600 * 1000) },
      { seq: 5, type: 'knowledge.run', projectId: 'demo-app', summary: 'run-seed-003 完成：1 个操作晋升', at: iso(26 * 3600 * 1000 - 74 * 1000) },
    ],
    cursor: 5,
  };
}

/** 检索面 stub 的语料：projectId -> 知识文档（真实现读 knowledgePath 下的知识树）。 */
const knowledgeCorpus = {
  'project-knowledge-base': [
    {
      path: 'README.md',
      title: '项目总览',
      body: 'project-knowledge 是本地、Git 触发的项目知识库。Markdown 是唯一事实源，向量索引永远是从知识树派生、可重建的。本地服务监听 127.0.0.1:5757，模块家族包含 terminal、vector-hub、event-bridge。',
    },
    {
      path: 'ARCHITECTURE.md',
      title: '架构',
      body: 'shell 只负责连接与投影，不拥有功能：反向代理保持同源、项目导入时向各模块扇出登记、wiring 表落在项目状态里。模块服务由 supervisor 探测后拉起，退出按指数退避重启，KB_MODULES_AUTOSTART=0 可关闭自动拉起。',
    },
    {
      path: 'modules/commit-pipeline.md',
      title: 'Commit 分析管道',
      body: 'git post-commit 钩子触发 hook-trigger.js：先把 commit boundary 落盘到 event-bridge journal，再 POST /api/hooks/post-commit。CommitReconciler 收集 git 证据、绑定会话快照、检索已有知识后认领 commit，由无头 Claude Agent SDK 会话分析，产物经 staging 校验后晋升为知识文档。后端离线时由启动对账补跑。',
    },
    {
      path: 'modules/retrieval.md',
      title: '检索运行时',
      body: '检索面提供 search 与 ask：search 是 BM25 与向量混合检索，ask 返回带引用的确定性答案（top-5 拼接，非 LLM 生成）。对外入口是 MCP server（project_knowledge_search / ask / get / history）与 project-knowledge-kb CLI。',
    },
    {
      path: 'changes/f4f383f.md',
      title: '4.3.1 发布修复',
      body: '发布流程修复：vector-hub 运行时曾被全局 dist/ gitignore 规则吞掉导致 tarball 缺文件；release:verify 现在门禁 vendored runtime 必须存在且被 git 跟踪；embed 链接竞态由终端重复广播 kb:ready 修复。',
    },
  ],
  'demo-app': [
    {
      path: 'README.md',
      title: 'Demo App 总览',
      body: 'demo-app 是一个演示项目，用于验证知识引擎的检索调试页。技术栈为 Node 与原生 HTTP。',
    },
    {
      path: 'GOAL.md',
      title: '目标',
      body: '验证 commit 触发分析、开发期检索两条链路的端到端体验，包括引用与得分展示。',
    },
  ],
};

module.exports = { seedState, knowledgeCorpus };
