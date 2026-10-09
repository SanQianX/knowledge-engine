#!/usr/bin/env node
'use strict';

const { createEngineServer } = require('./server');

/**
 * knowledge-engine CLI
 *
 *   serve [--port 5790] [--host 127.0.0.1] [--data DIR]
 *         Start the local engine (debug console page + JSON API).
 *
 * The server binds to loopback by default: runs carry commit evidence and
 * knowledge content, so they stay on this machine unless --host says otherwise.
 */
async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const get = name => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (command !== 'serve') {
    console.log('Usage: knowledge-engine serve [--port 5790] [--host 127.0.0.1] [--data DIR]');
    process.exitCode = command ? 1 : 0;
    return;
  }

  const port = Number(get('port') || process.env.KNOWLEDGE_ENGINE_PORT || 5790);
  const host = get('host') || process.env.KNOWLEDGE_ENGINE_HOST || '127.0.0.1';
  const dataDir = get('data') || process.env.KNOWLEDGE_ENGINE_DATA;

  const runtime = createEngineServer({ dataDir, managed: process.env.KB_ENGINE_MANAGED === '1', consume: process.env.KNOWLEDGE_ENGINE_CONSUME === '1', debug: process.env.KNOWLEDGE_ENGINE_DEBUG === '1', bridgeUrl: process.env.KB_EVENT_BRIDGE_URL, vectorUrl: process.env.KB_VECTOR_HUB_URL });
  await runtime.ready;
  const { server } = runtime;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await runtime.close(); process.exitCode = 0; }
    catch (error) { console.error(`[knowledge-engine] ${error.code || 'SHUTDOWN_FAILED'}: ${error.message}`); process.exitCode = 1; }
    // Let pending HTTP handles finish closing before Node tears down libuv.
    // Forced process.exit during network cleanup can abort on Windows.
    if (process.connected) process.disconnect();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  process.on('message', message => { if (message?.type === 'kb:shutdown') stop(); });
  server.listen(port, host, () => {
    console.log(`[knowledge-engine] listening on http://${host}:${port}`);
  });
}

main().catch(error => { console.error(`[knowledge-engine] ${error.code || 'START_FAILED'}: ${error.message}`); process.exitCode = 1; });
