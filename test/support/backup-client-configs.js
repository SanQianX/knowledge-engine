'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const output = path.resolve(process.argv[2] || '');
const allowed = path.resolve(__dirname, '../../../.project-knowledge-backups');
assert.ok(process.argv[2] && output.startsWith(allowed + path.sep));
assert.equal(fs.existsSync(output), false);
fs.mkdirSync(output, { recursive: true });
if (process.platform === 'win32') execFileSync('icacls', [output, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
const files = ['.claude/settings.json', '.claude.json', '.claude/plugins/installed_plugins.json', '.claude/plugins/known_marketplaces.json', '.codex/config.toml', '.zcode/cli/config.json'];
const report = { createdAt: new Date().toISOString(), files: [] };
for (const relative of files) {
  const source = path.join(os.homedir(), relative);
  if (!fs.existsSync(source)) continue;
  const target = path.join(output, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  report.files.push({ relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ backup: output, files: report.files.length, protected: process.platform === 'win32' }));
