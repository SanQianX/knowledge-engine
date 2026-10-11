'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const AtomicFile = require('../../src/runtime/atomic-file');

function processes() {
  const code = "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(raw);
}
function tree(all, rootPid) {
  const owned = new Set([rootPid]);
  let added = true;
  while (added) { added = false; for (const item of all) if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) { owned.add(item.ProcessId); added = true; } }
  return all.filter(item => owned.has(item.ProcessId));
}
async function main() {
  assert.equal(process.platform, 'win32', 'Windows ownership audit');
  const [mode, file, root] = process.argv.slice(2);
  if (mode === 'record') {
    const items = tree(processes(), Number(root));
    assert.ok(items.some(item => item.ProcessId === Number(root)), 'root must still be alive');
    AtomicFile.writeJsonAtomic(file, { schema: 'owned-process-audit/v1', rootPid: Number(root), before: items, recordedAt: new Date().toISOString() });
    console.log(JSON.stringify({ ownedProcesses: items.length, rootPid: Number(root), report: file })); return;
  }
  assert.equal(mode, 'verify');
  const report = JSON.parse(fs.readFileSync(file));
  let remaining;
  const deadline = Date.now() + 15000;
  do {
    const current = processes();
    remaining = report.before.filter(old => current.some(now => now.ProcessId === old.ProcessId && now.CreationDate === old.CreationDate));
    if (remaining.length) await new Promise(resolve => setTimeout(resolve, 1000));
  } while (remaining.length && Date.now() < deadline);
  Object.assign(report, { remaining, processesExited: remaining.length === 0, shutdownMethod: root || 'unknown', passed: remaining.length === 0 && root === 'graceful', verifiedAt: new Date().toISOString() });
  AtomicFile.writeJsonAtomic(file, report);
  assert.equal(remaining.length, 0, `owned processes remain: ${remaining.map(item => `${item.Name}:${item.ProcessId}`).join(', ')}`);
  console.log('OWNED_AGENT_PROCESSES_EXITED');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
