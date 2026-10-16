'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { evaluateAutomationToolUse } = require('./runtime/automation-config');
const { RuntimeLayout } = require('./runtime/layout');
const { ANALYSIS_SYSTEM_INSTRUCTIONS, requireAnalysisOutput } = require('./analysis-contract');
const { classifyAnalysisFailure, analysisFailure } = require('./analysis-failures');

const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());
process.once('disconnect', () => abortController.abort());
process.on('message', message => { if (message?.type === 'cancel') abortController.abort(); });

process.once('message', async job => {
  let failureCode = 'MODEL_FAILED';
  try {
    const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
    const layout = new RuntimeLayout(job.stagingPath);
    const decision = (toolName, input) => {
      const result = evaluateAutomationToolUse(job.safetyPolicy, toolName, input);
      if (result.behavior !== 'allow') return result;
      const target = input.file_path || input.path || input.notebook_path;
      const roots = toolName === 'Read' ? job.safetyPolicy.readRoots : [job.stagingPath];
      if (!roots.some(root => layout.isPathInside(root, path.resolve(job.stagingPath, target), { realpath: true }))) return { behavior: 'deny', reason: 'symlink/path outside isolated roots' };
      return result;
    };
    const env = { ...process.env, ANTHROPIC_API_KEY: job.profile.apiKey, ANTHROPIC_BASE_URL: job.profile.baseUrl, ANTHROPIC_MODEL: job.profile.mainModel || job.profile.models.default, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_AUTH_TOKEN;
    let completed = false;
    const turn = query({ prompt: job.prompt, options: {
      cwd: job.stagingPath, env, model: env.ANTHROPIC_MODEL, abortController,
      tools: job.safetyPolicy.allowedTools, allowedTools: [], settingSources: [], mcpServers: {}, permissionMode: 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ANALYSIS_SYSTEM_INSTRUCTIONS },
      canUseTool: async (toolName, input) => {
        const result = decision(toolName, input);
        return result.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: result.reason };
      },
      hooks: { PreToolUse: [{ hooks: [async input => {
        const result = decision(input.tool_name, input.tool_input);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.behavior === 'allow' ? 'allow' : 'deny', permissionDecisionReason: result.reason } };
      }] }] },
    } });
    for await (const message of turn) {
      if (message.type === 'assistant' && message.error) failureCode = classifyAnalysisFailure(message.error);
      if (message.type === 'result') completed = message.subtype === 'success' && !message.is_error;
    }
    if (!completed) throw analysisFailure(failureCode);
    requireAnalysisOutput(job.manifestPath);
    process.send({ type: 'complete' }, () => process.exit(0));
  } catch (error) {
    // SDK/provider messages can echo credentials. Only controlled codes leave
    // this isolated process; raw output is never written to state or logs.
    const classified = classifyAnalysisFailure(error);
    const code = classified === 'MODEL_FAILED' ? failureCode : classified;
    process.send({ type: 'failure', code }, () => process.exit(1));
  }
});
