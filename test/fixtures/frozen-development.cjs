'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.once('message', async job => {
  if (job.type === 'cancel') return process.exit(0);
  fs.writeFileSync(path.join(job.stagingPath, 'analysis-ready'), job.commitSha);
  while (!fs.existsSync(path.join(job.stagingPath, 'continue-analysis'))) await new Promise(resolve => setTimeout(resolve, 10));
  const relative = `changes/${job.commitSha.slice(0, 12)}.md`;
  const target = path.join(job.stagingPath, 'files', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `# Frozen commit\n\nAnalyzed commit ${job.commitSha}.\n`);
  const evidenceReferences = JSON.parse(job.prompt.match(/evidenceReferences (\[[^\]]+\])/)[1]);
  fs.writeFileSync(job.manifestPath, JSON.stringify({ schema: 'knowledge-staging-manifest/v1', projectId: job.projectId, runId: job.runId, commitSha: job.commitSha, operations: [{ path: relative, operation: 'create', reason: 'Frozen commit evidence', evidenceReferences }] }));
  process.send({ type: 'complete' }, () => process.exit(0));
});
process.on('message', job => { if (job.type === 'cancel') process.exit(0); });
