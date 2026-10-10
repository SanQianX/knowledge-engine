'use strict';

async function requestIndex({ baseUrl, route, body, attempt = 1, timeoutMs = 120000, sanitize, fetchImpl = fetch }) {
  const started = Date.now();
  const clean = value => sanitize(String(value || '')).slice(0, 2048);
  let httpStatus = null, requestId = null;
  function failure(failureKind, upstreamCode, upstreamMessage) {
    const details = { failureKind, httpStatus, upstreamCode: clean(upstreamCode).slice(0, 120), upstreamMessage: clean(upstreamMessage), requestId, durationMs: Math.max(0, Date.now() - started), attempt };
    return Object.assign(new Error(`向量索引请求失败：${details.upstreamMessage}`), { code: 'INDEX_FAILED', phase: 'indexing', retryable: true, details });
  }
  try {
    const response = await fetchImpl(new URL(route, baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    httpStatus = response.status;
    requestId = clean(response.headers.get('x-request-id') || response.headers.get('request-id')).slice(0, 120) || null;
    // Error responses can contain credentials or arbitrarily large HTML. Read
    // a bounded JSON envelope, never persist a raw body or response headers.
    const reader = response.body?.getReader();
    let text = '', size = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16384) throw failure('INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', '索引服务响应超过安全大小限制。');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw failure('INVALID_RESPONSE', 'INVALID_JSON', `索引服务返回非 JSON 响应（HTTP ${httpStatus}）。`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('INVALID_RESPONSE', 'INVALID_ENVELOPE', '索引服务响应不符合协议。');
    if (!response.ok || payload.ok === false || payload.error) {
      const upstream = payload.error;
      const message = typeof upstream === 'string' ? upstream : upstream?.message || payload.message || `索引服务返回 HTTP ${httpStatus}。`;
      throw failure(response.ok ? 'UPSTREAM_ERROR' : 'HTTP_ERROR', upstream?.code || payload.code || `HTTP_${httpStatus}`, message);
    }
    if (payload.ok !== true) throw failure('INVALID_RESPONSE', 'INVALID_ENVELOPE', '索引服务响应缺少成功标识。');
    return payload;
  } catch (error) {
    if (error.details && error.code === 'INDEX_FAILED') throw error;
    const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
    throw failure(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', error.cause?.code || error.code || (timeout ? 'INDEX_TIMEOUT' : 'INDEX_CONNECTION_FAILED'), error.message || (timeout ? '索引服务请求超时。' : '无法连接索引服务。'));
  }
}
module.exports = { requestIndex };
