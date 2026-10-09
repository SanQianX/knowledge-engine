'use strict';
const http = require('node:http');
let calls = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'controlled embedding substitute', calls })); return; }
  if (req.method !== 'POST' || req.url !== '/v1/embeddings' || req.headers.authorization !== 'Bearer controlled-not-a-secret') { res.writeHead(404); res.end(); return; }
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try {
      const body = JSON.parse(raw); const texts = Array.isArray(body.input) ? body.input : [body.input]; calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', model: 'controlled-embedding', data: texts.map((text, index) => ({ object: 'embedding', index, embedding: [1, 0] })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
    } catch { res.writeHead(400); res.end(); }
  });
});
server.listen(Number(process.env.KB_CONTROLLED_EMBEDDING_PORT || 0), '127.0.0.1', () => process.stdout.write(`CONTROLLED_EMBEDDING http://127.0.0.1:${server.address().port}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
