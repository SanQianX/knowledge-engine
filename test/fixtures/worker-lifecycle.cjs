'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
process.once('message', job => {
  fs.writeFileSync(path.join(job.stagingPath, 'worker.pid'), String(process.pid));
  fs.writeFileSync(path.join(job.stagingPath, 'prompt.txt'), job.prompt);
  if (job.profile.mainModel === 'hang') return;
  if (job.profile.mainModel === 'no-output') { process.send({ type: 'complete' }); return; }
  fs.mkdirSync(path.join(job.stagingPath, 'files'));
  fs.writeFileSync(path.join(job.stagingPath, 'files', 'README.md'), '# Isolated test worker\n');
  fs.writeFileSync(path.join(job.stagingPath, 'manifest.json'), JSON.stringify({ operations: [{ operation: 'create', path: 'README.md' }] }));
  process.send({ type: 'complete' });
});
setInterval(() => {}, 1000);
