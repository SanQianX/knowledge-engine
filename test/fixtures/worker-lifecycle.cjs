'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
process.once('message', job => {
  fs.writeFileSync(path.join(job.stagingPath, 'worker.pid'), String(process.pid));
  fs.writeFileSync(path.join(job.stagingPath, 'prompt.txt'), job.prompt);
  if (job.profile.mainModel === 'quota') { process.send({ type: 'failure', code: 'MODEL_QUOTA_EXHAUSTED' }); return; }
  if (job.profile.mainModel === 'hang') return;
  if (job.profile.mainModel === 'no-output') { process.send({ type: 'complete' }); return; }
  fs.mkdirSync(path.join(job.stagingPath, 'files'));
  fs.writeFileSync(path.join(job.stagingPath, 'files', 'README.md'), '# Isolated test worker\n\nControlled evidence-backed test output.\n');
  fs.writeFileSync(path.join(job.stagingPath, 'manifest.json'), JSON.stringify({ schema: 'knowledge-staging-manifest/v1', projectId: job.projectId, runId: job.runId, commitSha: job.commitSha, operations: [{ operation: 'create', path: 'README.md' }] }));
  process.send({ type: 'complete' });
});
setInterval(() => {}, 1000);
