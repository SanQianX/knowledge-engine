'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const AtomicFile = require('../../src/runtime/atomic-file');

async function main() {
  const env = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.equal(env.installationSource, 'project-knowledge/installed-registry/v1');
  assert.equal(env.model, 'controlled substitute; not real Agent acceptance');
  assert.equal(path.dirname(env.root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(env.root).startsWith('智脑桌面验收-'));
  const read = async (route, body) => {
    const response = await fetch(new URL(route, env.url), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    assert.ok(response.ok && result.ok !== false, result.error?.code || route);
    return result;
  };
  const imported = await read('/api/projects/import', {
    projectId: 'project-history-a', localPath: env.repositories[0],
    knowledgePath: path.join(env.knowledgeRoot, '完整历史项目'), displayName: '完整历史验收',
  });
  assert.ok(Object.values(imported.modules).every(module => module.ok));
  const project = (await read('/api/projects/aggregated')).projects.find(row => row.projectId === imported.projectId);
  const id = project.modules.terminal.projectId;
  const { session } = await read('/api/terminal/sessions', {
    context: { contextId: id, workspaceRef: id, displayName: '完整历史验收' },
    aiProfileId: 'acceptance-model',
  });
  for (let turn = 1; turn <= 25; turn++) {
    await read(`/api/terminal/sessions/${session.sessionId}/input`, { text: `完整历史验收第${String(turn).padStart(2, '0')}轮` });
    const deadline = Date.now() + 10000;
    let state;
    do {
      state = (await read(`/api/terminal/sessions/${session.sessionId}`)).session.state;
      if (state === 'idle') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(state, 'idle');
  }
  const latest = await read(`/api/terminal/sessions/${session.sessionId}/history?limit=20`);
  assert.equal(latest.events.filter(event => event.type === 'claude/user-prompt').length, 20);
  assert.ok(latest.nextCursor);
  const earlier = await read(`/api/terminal/sessions/${session.sessionId}/history?limit=20&before=${latest.nextCursor}`);
  assert.equal(earlier.events.filter(event => event.type === 'claude/user-prompt').length, 5);
  assert.ok(earlier.events.some(event => event.text === '完整历史验收第01轮'));
  assert.equal(earlier.nextCursor, null);
  const report = {
    passed: true, source: env.installationReport, sessionId: session.sessionId, projectId: imported.projectId,
    model: 'controlled substitute; no real Agent claim', turns: 25, latest: 20, earlier: 5,
    firstPrompt: '完整历史验收第01轮', lastPrompt: '完整历史验收第25轮', checkedAt: new Date().toISOString(),
  };
  AtomicFile.writeJsonAtomic(path.join(env.root, 'installed-history-acceptance.json'), report);
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
