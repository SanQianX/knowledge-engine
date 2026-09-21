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

  const { server } = createEngineServer({ dataDir });
  server.listen(port, host, () => {
    console.log(`[knowledge-engine] listening on http://${host}:${port}`);
  });
}

main();
