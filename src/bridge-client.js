'use strict';

class BridgeClient {
  constructor(url = 'http://127.0.0.1:8790') { this.url = url; this.requests = new Set(); this.closed = false; }
  async request(route, body) {
    if (this.closed) throw Object.assign(new Error('事件消费正在关闭。'), { code: 'BRIDGE_UNAVAILABLE', retryable: true });
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000); timer.unref();
    try {
      const response = await fetch(new URL(route, this.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload.error) throw Object.assign(new Error('事件日志服务暂不可用。'), { code: 'BRIDGE_UNAVAILABLE', retryable: true });
      return payload;
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  close() { this.closed = true; for (const controller of this.requests) controller.abort(); }
  async listJournals() { return (await this.request('/api/journals')).journals; }
  async registerConsumer(name, meta) { return this.request('/api/consumers/register', { name, meta }); }
  async readEvents({ journalId, fromSequence, limit = 100 }) { return (await this.request(`/api/journal/events?${new URLSearchParams({ journalId, fromSequence, limit })}`)).events; }
  async ackConsumerCursor(name, sequence, { journalId }) { return this.request('/api/consumers/ack', { name, sequence, journalId }); }
}

module.exports = { BridgeClient };
