'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const file = path.resolve(process.argv[2] || '');
  const environment = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { root } = environment;
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('智脑桌面验收-') || !environment.model.startsWith('real Agent')) throw new Error('REAL_ACCEPTANCE_ENVIRONMENT_REQUIRED');
  const roundAt = process.argv.indexOf('--round');
  const round = roundAt >= 0 ? process.argv[roundAt + 1] : '';
  if (round && !/^[a-z][a-z0-9-]{0,40}$/.test(round)) throw new Error('INVALID_ACCEPTANCE_ROUND');
  const reportFile = path.join(root, round ? `real-agent-${round}-acceptance.json` : 'real-agent-acceptance.json');
  const resuming = process.argv.includes('--resume');
  const report = resuming ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { mode: environment.model, startedAt: new Date().toISOString(), root, projects: [], commits: [], concurrency: null };
  if (report.root !== root) throw new Error('REPORT_ROOT_MISMATCH');
  if (report.failure) { report.priorFailures = [...(report.priorFailures || []), report.failure]; delete report.failure; }
  const save = () => AtomicFile.writeJsonAtomic(reportFile, report);
  const call = async (route, body) => {
    const response = await fetch(new URL(route, environment.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw Object.assign(new Error('Acceptance endpoint failed'), { code: data.error?.code || `HTTP_${response.status}` });
    return data;
  };
  const git = (repo, args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
  for (const [index, repo] of environment.repositories.entries()) {
    if (report.projects[index]) continue;
    const projectId = `project-real-${index ? 'b' : 'a'}`;
    const knowledgePath = path.join(environment.knowledgeRoot, index ? '真实项目 B' : '真实项目 A');
    const existing = (await call('/api/projects/aggregated')).projects.find(p => p.projectId === projectId);
    if (existing) {
      assert.equal(path.resolve(existing.workspacePath), path.resolve(repo));
      assert.equal(path.resolve(existing.knowledgePath), path.resolve(knowledgePath));
      assert.ok(Object.values(existing.modules).every(module => module.registered), 'existing real projects must retain all four connections');
      report.projects.push({ projectId, repoPath: repo, knowledgePath }); continue;
    }
    const result = await call('/api/projects/import', { projectId, localPath: repo, knowledgePath, displayName: index ? '真实项目 B' : '真实项目 A' });
    assert.ok(Object.values(result.modules).every(module => module.ok), 'all four real services must be registered');
    report.projects.push({ projectId, repoPath: repo, knowledgePath });
  }
  save(); process.stdout.write('REAL_PROJECTS_IMPORTED\n');
  async function commit(project, name, content) {
    AtomicFile.writeFileAtomic(path.join(project.repoPath, name), content);
    git(project.repoPath, ['add', name]); git(project.repoPath, ['commit', '-qm', `acceptance: ${name}`]);
    return { projectId: project.projectId, commitSha: git(project.repoPath, ['rev-parse', 'HEAD']) };
  }
  async function verify(commit) {
    commit = { projectId: commit.projectId, commitSha: commit.commitSha };
    let phase;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      const run = (await call('/api/engine/runs')).runs.find(run => run.projectId === commit.projectId && run.commitSha === commit.commitSha);
      if (run && phase !== run.phase) { phase = run.phase; process.stdout.write(`${commit.projectId} ${commit.commitSha.slice(0, 8)} ${phase}\n`); }
      if (run && ['failed', 'index-pending'].includes(run.state)) { report.commits.push({ ...commit, state: run.state, errorCode: run.error?.code }); save(); throw Object.assign(new Error('Real commit maintenance failed'), { code: run.error?.code || 'REAL_RUN_FAILED' }); }
      if (run?.state === 'succeeded') {
        const project = report.projects.find(p => p.projectId === commit.projectId);
        const operations = run.staging?.operations || [];
        assert.ok(operations.length && run.promotedAt && run.indexState === 'succeeded');
        for (const operation of operations.filter(op => op.operation !== 'delete')) assert.ok(fs.existsSync(path.join(project.knowledgePath, operation.path)));
        const search = await call('/api/engine/search', { projectId: commit.projectId, query: commit.commitSha });
        assert.ok(search.results.some(result => result.commitSha === commit.commitSha), 'promoted commit must be retrievable with source SHA');
        report.commits = report.commits.filter(record => record.commitSha !== commit.commitSha);
        report.commits.push({ ...commit, state: run.state, promotedAt: run.promotedAt, indexState: run.indexState, files: operations.map(op => op.path), citations: search.results.map(row => ({ path: row.entry_id, commitSha: row.commitSha })) }); save();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw Object.assign(new Error('Real maintenance timed out'), { code: 'REAL_ACCEPTANCE_TIMEOUT' });
  }
  if (process.argv.includes('--verify-only')) {
    assert.ok(report.concurrency?.passed && report.commits.length === 3, 'a completed real single + concurrent acceptance report is required');
    await Promise.all(report.commits.slice().map(verify));
    report.reverifiedAt = new Date().toISOString(); save();
    process.stdout.write('REAL_COMMIT_EVIDENCE_REVERIFIED\n'); return;
  }
  try {
    const first = report.commits[0] || await commit(report.projects[0], round ? `knowledge-policy-${round}.txt` : 'knowledge-policy.txt', 'Knowledge has one writer: the engine promotion path. Preserve native workbench streaming and keep the product simple.\n');
    if (first.state === 'failed') { const run = (await call('/api/engine/runs')).runs.find(run => run.commitSha === first.commitSha); await call(`/api/engine/runs/${run.runId}/retry`, {}); }
    await verify(first);
    process.stdout.write('REAL_SINGLE_COMMIT_PASSED\n');
    const pair = await Promise.all([commit(report.projects[0], round ? `concurrent-a-${round}.txt` : 'concurrent-a.txt', 'Project A owns its own code and knowledge directories.\n'), commit(report.projects[1], round ? `concurrent-b-${round}.txt` : 'concurrent-b.txt', 'Project B owns its own code and knowledge directories.\n')]);
    await Promise.all(pair.map(verify));
    const state = JSON.parse(fs.readFileSync(path.join(root, 'engine', 'engine-state.json')));
    const intervals = pair.map(commit => {
      const events = state.events.filter(event => event.commitSha === commit.commitSha);
      return { ...commit, start: events.find(event => event.phase === 'analyzing')?.at, finish: events.find(event => event.phase === 'promoting')?.at };
    });
    assert.ok(intervals.every(interval => interval.start && interval.finish));
    assert.ok(Math.max(...intervals.map(i => Date.parse(i.start))) < Math.min(...intervals.map(i => Date.parse(i.finish))), 'real model analysis intervals must overlap');
    report.concurrency = { passed: true, intervals }; report.finishedAt = new Date().toISOString(); save();
    process.stdout.write(`REAL_COMMIT_ACCEPTANCE_PASSED ${reportFile}\n`);
  } catch (error) { report.failure = { code: error.code || 'ASSERTION_FAILED' }; save(); throw error; }
}
main().catch(error => { process.stderr.write(`${error.code || 'ACCEPTANCE_FAILED'}\n`); process.exitCode = 1; });
