'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');
const { findChrome } = require('../../../project-knowledge-base/_site/_test/helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('../../../project-knowledge-base/_site/_test/helpers/cdp-browser');

async function main() {
  const environment = JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
  assert.equal(path.dirname(environment.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(environment.root).startsWith('智脑桌面验收-') && environment.model.startsWith('real Agent and real embeddings'));
  const api = async (route, body) => {
    const response = await fetch(new URL(route, environment.url), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, route); return response.json();
  };
  const project = (await api('/api/projects/aggregated')).projects.find(p => p.projectId === 'project-real-a');
  assert.equal(path.resolve(project.workspacePath), path.resolve(environment.repositories[0]));
  const repo = project.workspacePath;
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(git(['status', '--porcelain']), '');
  const stamp = Date.now(), file = `live-development-${stamp}.txt`, draft = `live-draft-${stamp}.txt`;
  const proof = path.join(environment.root, `real-live-development-${stamp}`); fs.mkdirSync(proof);
  const report = { passed: false, installationReport: environment.installationReport, projectId: project.projectId, cases: [], startedAt: new Date().toISOString() };
  const save = () => AtomicFile.writeJsonAtomic(path.join(proof, 'result.json'), report);
  const lookup = (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.state === 'succeeded');
  assert.ok(lookup);
  const prior = await api('/api/engine/search', { projectId: project.projectId, query: lookup.commitSha });
  assert.equal(prior.health.index, 'ok'); assert.ok(prior.results.some(r => r.commitSha === lookup.commitSha));
  report.priorKnowledge = prior.results.map(r => ({ entry: r.entry_id, commit: r.commitSha })); save();
  const browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(proof, 'browser'), url: environment.url, width: 1920, height: 1080 });
  try {
    await browser.setViewport(1920, 1080);
    await waitFor(() => browser.evaluate("!!document.getElementById('projectSelect')?.options.length"), 'product project selector');
    await browser.evaluate(`(()=>{const s=document.getElementById('projectSelect');s.value=${JSON.stringify(project.projectId)};s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-view=activity]').click()})()`);
    const commit = (name, text) => { AtomicFile.writeFileAtomic(path.join(repo, name), text); git(['add', name]); git(['commit', '-qm', `acceptance: ${name}`]); return git(['rev-parse', 'HEAD']); };
    const runFor = async sha => (await api('/api/engine/runs')).runs.find(r => r.projectId === project.projectId && r.commitSha === sha);
    const first = commit(file, 'Only frozen commit evidence may guide maintenance.\n');
    await waitFor(async () => (await runFor(first))?.phase === 'analyzing', 'real first model analyzing', 180000);
    const second = commit(file, 'Users may continue developing while isolated maintenance reads frozen evidence.\n');
    AtomicFile.writeFileAtomic(path.join(repo, draft), 'uncommitted user draft must remain intact\n');
    const draftHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, draft))).digest('hex');
    assert.equal((await runFor(first)).phase, 'analyzing', 'the second commit and dirty draft must occur during actual model analysis');
    report.observedOverlap = { first, second, firstPhase: 'analyzing', secondState: (await runFor(second))?.state || 'journal not yet consumed', draftHash }; save();
    for (const sha of [first, second]) {
      let completed;
      await waitFor(async () => {
        const run = await runFor(sha);
        if (run && ['failed', 'index-pending'].includes(run.state)) throw Object.assign(new Error(`Real live-development maintenance failed: ${run.error?.code}`), { fatal: true });
        if (run?.state !== 'succeeded') return false;
        completed = run; return true;
      }, 'real FIFO maintenance with a dirty working tree', 300000);
      assert.equal(completed.indexState, 'succeeded'); assert.ok(completed.promotedAt);
      const searched = await api('/api/engine/search', { projectId: project.projectId, query: sha });
      assert.equal(searched.health.index, 'ok'); assert.ok(searched.results.some(r => r.commitSha === sha));
      report.cases.push({ commitSha: sha, analysisRunId: completed.analysisRunId, promotedAt: completed.promotedAt, files: completed.staging.operations.map(o => o.path), citations: searched.results.map(r => ({ entry: r.entry_id, commit: r.commitSha })) }); save();
      await waitFor(() => browser.evaluate(`document.querySelector('[data-run-id="${completed.runId}"]')?.textContent.includes('索引：succeeded')`), 'live maintenance automatically refreshes UI');
    }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, draft))).digest('hex'), draftHash);
    git(['add', draft]); git(['commit', '-qm', 'acceptance: preserve developer draft after maintenance']);
    const third = git(['rev-parse', 'HEAD']);
    await waitFor(async () => {
      const run = await runFor(third);
      if (run && ['failed', 'index-pending'].includes(run.state)) throw Object.assign(new Error(`Draft commit failed: ${run.error?.code}`), { fatal: true });
      return run?.state === 'succeeded';
    }, 'draft commit also automatically maintained', 300000);
    const events = JSON.parse(fs.readFileSync(path.join(environment.root, 'engine/engine-state.json'))).events;
    const firstFinish = events.find(e => e.commitSha === first && e.phase === 'ready');
    const secondStart = events.find(e => e.commitSha === second && e.phase === 'analyzing');
    assert.ok(firstFinish && secondStart && Date.parse(firstFinish.at) <= Date.parse(secondStart.at), 'same-project execution must remain FIFO');
    assert.equal(browser.exceptions.length, 0);
    await browser.screenshot(path.join(proof, 'live-maintenance-1920.png'));
    Object.assign(report, { passed: true, draftCommit: third, draftPreserved: true, fifo: { firstFinished: firstFinish.at, secondStarted: secondStart.at }, finishedAt: new Date().toISOString() }); save();
    console.log(`REAL_LIVE_DEVELOPMENT_PASSED ${proof}`);
  } catch (error) { report.failure = error.message; save(); await browser.screenshot(path.join(proof, 'failure-1920.png')); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(`${error.code || 'LIVE_DEVELOPMENT_FAILED'}: ${error.message}`); process.exitCode = 1; });
