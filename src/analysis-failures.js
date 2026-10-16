'use strict';

const failures = {
  MODEL_QUOTA_EXHAUSTED: '默认维护模型的额度或余额不足。提交证据与失败记录已保留；恢复额度或更换默认模型后，请重试此提交。',
  MODEL_RATE_LIMITED: '默认维护模型请求受限。提交证据与失败记录已保留，请稍后重试。',
  MODEL_AUTH_FAILED: '默认维护模型认证失败。提交证据与失败记录已保留，请检查凭据后重试。',
  AI_RUNTIME_REQUIRED: '后台分析运行时不可用，请修复安装后重试。',
  ANALYSIS_OUTPUT_MISSING: '后台分析未生成有效文件，提交证据与失败记录已保留，请重试。',
  MODEL_FAILED: '后台 Agent 分析失败。提交证据与失败记录已保留，请检查默认维护模型后重试。',
};

// Provider text can echo credentials. Classify structured codes only; neither
// raw messages nor unknown codes may cross the worker IPC boundary.
function classifyAnalysisFailure(input) {
  const codes = new Set(), statuses = new Set(), seen = new Set();
  function collect(value, depth = 0) {
    if (typeof value === 'string') { codes.add(value.toLowerCase()); return; }
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return;
    seen.add(value);
    for (const key of ['code', 'type']) if (typeof value[key] === 'string') codes.add(value[key].toLowerCase());
    if (value.status !== undefined) statuses.add(Number(value.status));
    collect(value.error, depth + 1); collect(value.cause, depth + 1);
  }
  collect(input);
  const has = (...values) => values.some(value => codes.has(value));
  if (has('billing_error', 'insufficient_quota', 'quota_exceeded', 'insufficient_balance', 'model_quota_exhausted')) return 'MODEL_QUOTA_EXHAUSTED';
  if (has('authentication_failed', 'authentication_error', 'model_auth_failed') || statuses.has(401)) return 'MODEL_AUTH_FAILED';
  if (has('rate_limit', 'rate_limit_error', 'model_rate_limited') || statuses.has(429)) return 'MODEL_RATE_LIMITED';
  if (has('module_not_found', 'ai_runtime_required')) return 'AI_RUNTIME_REQUIRED';
  if (has('analysis_output_missing')) return 'ANALYSIS_OUTPUT_MISSING';
  return 'MODEL_FAILED';
}

function analysisFailure(code) {
  code = Object.hasOwn(failures, code) ? code : 'MODEL_FAILED';
  return Object.assign(new Error(failures[code]), { code, retryable: true });
}

module.exports = { classifyAnalysisFailure, analysisFailure };
