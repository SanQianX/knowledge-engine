'use strict';
const { fork, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AtomicFile = require('./runtime/atomic-file');
const { canonicalRelativePath } = require('./runtime/knowledge-promotion');
const { RuntimeLayout } = require('./runtime/layout');
const { frameFrozenEvidence, requireAnalysisOutput } = require('./analysis-contract');

class HeadlessAnalyzer {
  constructor({ resolveProfile, timeoutMs = 15 * 60 * 1000, workerPath = path.join(__dirname, 'analysis-worker.js') } = {}) { this.resolveProfile = resolveProfile; this.timeoutMs = timeoutMs; this.workerPath = workerPath; this.children = new Map(); this.closed = false; }
  async runClaim(input) {
    if (this.closed) throw Object.assign(new Error('分析服务正在关闭。'), { code: 'WORKER_STOPPED', retryable: true });
    const profile = this.resolveProfile && await this.resolveProfile(input.projectId);
    if (!profile || !profile.apiKey || !(profile.mainModel || profile.models?.default)) throw Object.assign(new Error('请先在工作台配置后台维护的默认模型。'), { code: 'AI_PROFILE_REQUIRED', status: 503, retryable: true });
    const refs = [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`];
    const contract = `\n\nOUTPUT CONTRACT\nRead frozen evidence only beneath ${input.evidenceRoot}. Write only beneath ${input.stagingPath}. Put Markdown under files/<allowed-path> (README.md, GOAL.md, ARCHITECTURE.md, modules/*.md, changes/*.md). Write ${input.manifestPath} with schema knowledge-staging-manifest/v1, projectId ${input.projectId}, runId ${input.claim.runId}, commitSha ${input.claim.commitSha}, and non-empty operations. Each operation needs path, operation (create/replace/delete), reason, and evidenceReferences ${JSON.stringify(refs)}. Omit sha256: the engine seals staged bytes itself. Do not modify code, final knowledge, other runs, or indexes. Do not invent intent if conversations are unavailable.`;
    const pathContract = `\nPATH CONTRACT (mandatory): operations[].path is the FINAL knowledge-relative POSIX path, NEVER a staging path and NEVER prefixed with "files/". Example: write the physical file ${path.join(input.stagingPath, 'files', 'changes', `${input.claim.commitSha.slice(0, 12)}.md`)} but put "path": "changes/${input.claim.commitSha.slice(0, 12)}.md" in manifest.json. Use forward slashes even on Windows. Minimal manifest shape: ${JSON.stringify({ schema: 'knowledge-staging-manifest/v1', projectId: input.projectId, runId: input.claim.runId, commitSha: input.claim.commitSha, operations: [{ path: `changes/${input.claim.commitSha.slice(0, 12)}.md`, operation: 'create', reason: 'Describe the evidence-backed change', evidenceReferences: refs }] })}`;
    await new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      const child = fork(this.workerPath, [], { cwd: input.stagingPath, env, execArgv: [], detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let requested = false, outcome, escalation, termination = Promise.resolve();
      let exited;
      const completion = new Promise(done => { exited = done; });
      const stop = error => {
        if (requested) return;
        requested = true;
        outcome = error;
        clearTimeout(timer);
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        escalation = setTimeout(() => {
          // Windows SIGTERM kills the worker without allowing SDK cleanup.
          // Abort cooperatively first; escalation must kill its whole tree.
          if (process.platform === 'win32') termination = new Promise(done => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done()));
          else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        }, 2000);
        escalation.unref();
      };
      this.children.set(child, { stop, completion });
      const timer = setTimeout(() => stop(Object.assign(new Error('知识分析超时。'), { code: 'MODEL_TIMEOUT', retryable: true })), this.timeoutMs);
      child.on('message', message => {
        if (message?.type === 'complete') stop();
        else if (message?.type === 'failure') stop(Object.assign(new Error('后台 Agent 分析失败，请检查模型配置。'), { code: ['AI_RUNTIME_REQUIRED', 'ANALYSIS_OUTPUT_MISSING'].includes(message.code) ? message.code : 'MODEL_FAILED', retryable: true }));
      });
      child.on('error', () => stop(Object.assign(new Error('无法启动后台分析进程。'), { code: 'WORKER_START_FAILED', retryable: true })));
      // A completion message is not an exit: retain the directory lock until
      // the worker has actually stopped writing, including timeout/shutdown.
      child.on('close', async () => {
        clearTimeout(timer); clearTimeout(escalation); await termination; this.children.delete(child); exited();
        if (!requested) outcome = Object.assign(new Error('后台分析进程意外退出。'), { code: 'WORKER_EXITED', retryable: true });
        if (outcome) reject(outcome); else resolve();
      });
      const memoryContract = '\nYou may optionally include memoryCandidates in manifest.json: [{text, entryId, quote}]. Only suggest durable user preferences explicitly evidenced in a promoted document; quote must be an exact excerpt (at least 8 characters) from that document. Never infer preferences from code style alone. These stay unconfirmed until the user accepts them.';
      const languageContract = input.config?.knowledgeLanguage === 'en-US' ? '\nOUTPUT LANGUAGE: English. Preserve identifiers and verbatim evidence quotations.' : '\n输出语言：简体中文。知识正文、operations[].reason 与候选记忆用简体中文；代码标识、路径、哈希和原文证据引用保持不变。';
      child.send({ profile, prompt: `${frameFrozenEvidence(input.prompt)}${contract}${pathContract}${memoryContract}${languageContract}`, manifestPath: input.manifestPath, stagingPath: input.stagingPath, safetyPolicy: input.safetyPolicy }, error => { if (error) stop(Object.assign(new Error('无法发送分析任务。'), { code: 'WORKER_START_FAILED', retryable: true })); });
    });
    requireAnalysisOutput(input.manifestPath);
    const manifest = AtomicFile.readJsonStrict(input.manifestPath);
    const layout = new RuntimeLayout(input.stagingPath);
    for (const operation of manifest.operations || []) {
      if (operation.operation === 'delete' || operation.sha256 != null) continue;
      const relative = canonicalRelativePath(operation.path);
      const file = path.join(input.stagingPath, 'files', ...relative.split('/'));
      if (!layout.isPathInside(input.stagingPath, file, { realpath: true }) || fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('分析产物越界。'), { code: 'PATH_OUTSIDE_ROOT' });
      operation.sha256 = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    }
    AtomicFile.writeJsonAtomic(input.manifestPath, manifest);
    return { ok: true };
  }
  async close() { this.closed = true; const running = [...this.children.values()]; for (const job of running) job.stop(Object.assign(new Error('分析服务正在关闭。'), { code: 'WORKER_STOPPED', retryable: true })); await Promise.all(running.map(job => job.completion)); }
}

module.exports = { HeadlessAnalyzer };
