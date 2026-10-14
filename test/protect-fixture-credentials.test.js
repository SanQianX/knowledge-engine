'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertFixtureRoot, protectRealFixtureRoot } = require('./support/protect-fixture-credentials');
const previewSource = fs.readFileSync(path.join(__dirname, './support/product-preview.js'), 'utf8');
const PREFIX = '智脑桌面验收-';
const clean = root => () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test('real fixture protection is wired after root validation, before the first real credential write, and gated off the fake path', () => {
  const validation = previewSource.indexOf('Acceptance root must be its own temporary directory');
  const gate = previewSource.indexOf('if (realProfile || realEmbeddingSettings) protectRealFixtureRoot(root');
  const setCredential = previewSource.indexOf("setCredential('acceptance-model', realProfile?.apiKey");
  const setEmbedding = previewSource.indexOf('setEmbeddingConfig({ provider: realEmbeddingSettings.provider');
  assert.ok(validation > 0, 'root ownership validation must stay');
  assert.ok(gate > validation, 'protection must be applied after the owned-root validation');
  assert.ok(setCredential > gate, 'protection must be applied before the first real credential write');
  assert.ok(setEmbedding > gate, 'protection must be applied before the real embedding secret write');
  assert.equal(previewSource.split('protectRealFixtureRoot(root').length - 1, 1, 'exactly one gated protect call site: the fake path never invokes ACL work');
});

test('protect applies inheritance removal plus current-user and SYSTEM grants on Windows, or 0700 elsewhere', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  t.after(clean(root));
  const calls = [];
  protectRealFixtureRoot(root, { parent: os.tmpdir(), prefix: PREFIX, exec: (cmd, args) => { calls.push([cmd, ...args]); } });
  if (process.platform === 'win32') {
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'icacls');
    assert.ok(calls[0].includes('/inheritance:r'));
    assert.ok(calls[0].includes('/grant:r'));
    assert.ok(calls[0].some(argument => argument.startsWith(process.env.USERDOMAIN) && argument.endsWith(':(OI)(CI)F')), 'current user full-control grant');
    assert.ok(calls[0].includes('*S-1-5-18:(OI)(CI)F'), 'SYSTEM grant by SID');
  } else {
    assert.equal(calls.length, 0, 'non-Windows must use mode bits, never icacls');
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  }
});

test('protection failure aborts with a distinct error before any caller can persist credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  t.after(clean(root));
  let credentialWrites = 0;
  assert.throws(() => {
    protectRealFixtureRoot(root, { parent: os.tmpdir(), prefix: PREFIX, platform: 'win32', exec: () => { throw new Error('icacls denied'); } });
    credentialWrites = 1;
  }, { code: 'FIXTURE_ACL_PROTECTION_FAILED' });
  assert.equal(credentialWrites, 0);
  assert.throws(() => {
    protectRealFixtureRoot(root, { parent: os.tmpdir(), prefix: PREFIX, platform: 'linux', chmod: () => { throw new Error('chmod denied'); } });
    credentialWrites = 1;
  }, { code: 'FIXTURE_ACL_PROTECTION_FAILED' });
  assert.equal(credentialWrites, 0);
});

test('rejects roots outside the owned temp parent, wrong prefixes, symbolic links, and non-directories', async t => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), '智脑保护单测-'));
  t.after(clean(owned));
  const root = path.join(owned, PREFIX + 'a');
  fs.mkdirSync(root);
  assert.throws(() => assertFixtureRoot(root, { parent: os.tmpdir(), prefix: PREFIX }), { code: 'FIXTURE_ROOT_OUT_OF_SCOPE' });
  assert.throws(() => assertFixtureRoot(root, { parent: owned, prefix: 'other-' }), { code: 'FIXTURE_ROOT_NAME_REJECTED' });
  assert.throws(() => assertFixtureRoot(root, { parent: owned, prefix: PREFIX, lstat: () => ({ isSymbolicLink: () => true, isDirectory: () => false }) }), { code: 'FIXTURE_ROOT_SYMLINK_REJECTED' });
  const file = path.join(owned, PREFIX + 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => assertFixtureRoot(file, { parent: owned, prefix: PREFIX }), { code: 'FIXTURE_ROOT_NOT_DIRECTORY' });
  assert.equal(assertFixtureRoot(root, { parent: owned, prefix: PREFIX }), root);
});

test('real protection restricts an owned fixture root to the current user and SYSTEM', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  t.after(clean(root));
  protectRealFixtureRoot(root, { parent: os.tmpdir(), prefix: PREFIX });
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls', [root], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    assert.ok(acl.includes(process.env.USERNAME), 'owner retains access');
    assert.ok(acl.includes('NT AUTHORITY') && acl.includes('SYSTEM:'), 'SYSTEM retains access (query renders the SID account)');
    assert.ok(!acl.includes('Everyone'));
    assert.ok(!acl.includes('BUILTIN'));
  } else {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  }
});
