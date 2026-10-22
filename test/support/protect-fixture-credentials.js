'use strict';
// Real acceptance fixtures persist real provider credentials (agent apiKey,
// embedding secret) under their root. Before the first such write, the root
// must be restricted to the current user and SYSTEM so no other local account
// can read the stored secrets. Windows uses the same icacls convention as
// backup-client-configs.js; other platforms use 0700 mode bits.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function assertFixtureRoot(root, { parent, prefix, lstat = fs.lstatSync }) {
  if (!parent || !prefix) throw Object.assign(new Error('Owned fixture scope (parent and prefix) is required'), { code: 'FIXTURE_SCOPE_SPEC_REQUIRED' });
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(parent)) throw Object.assign(new Error('Fixture root must sit directly inside the owned temp parent'), { code: 'FIXTURE_ROOT_OUT_OF_SCOPE' });
  if (!path.basename(resolved).startsWith(prefix)) throw Object.assign(new Error('Fixture root name must carry the fixture prefix'), { code: 'FIXTURE_ROOT_NAME_REJECTED' });
  const stat = lstat(resolved);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('Fixture root must not be a symbolic link'), { code: 'FIXTURE_ROOT_SYMLINK_REJECTED' });
  if (!stat.isDirectory()) throw Object.assign(new Error('Fixture root must be a real directory'), { code: 'FIXTURE_ROOT_NOT_DIRECTORY' });
  return resolved;
}

function windowsGrants() {
  const account = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join(String.fromCharCode(92));
  return [`${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'];
}

function protectRealFixtureRoot(root, options = {}) {
  const resolved = assertFixtureRoot(root, options);
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const exec = options.exec || execFileSync;
    try {
      // /reset first: /inheritance:r only strips INHERITED ACEs, so explicit
      // ACEs planted by the creator token's default DACL (GitHub Windows
      // runners run under such an admin-provisioned account) would survive.
      // /reset rebuilds the DACL from parent inheritance alone, discarding
      // every explicit ACE, before the strip-and-grant pass runs.
      exec('icacls', [resolved, '/reset'], { windowsHide: true, stdio: 'pipe' });
      exec('icacls', [resolved, '/inheritance:r', '/grant:r', ...windowsGrants()], { windowsHide: true, stdio: 'pipe' });
    }
    catch (error) { throw Object.assign(new Error(`Real credential fixture ACL protection failed: ${error.message}`), { code: 'FIXTURE_ACL_PROTECTION_FAILED' }); }
  } else {
    const chmod = options.chmod || fs.chmodSync;
    try { chmod(resolved, 0o700); }
    catch (error) { throw Object.assign(new Error(`Real credential fixture mode protection failed: ${error.message}`), { code: 'FIXTURE_ACL_PROTECTION_FAILED' }); }
  }
  return resolved;
}

module.exports = { assertFixtureRoot, protectRealFixtureRoot, windowsGrants };
