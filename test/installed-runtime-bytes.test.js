'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyBytes } = require('./support/verify-global-registry');

test('installed acceptance rejects changed or missing public runtime bytes and ignores dependency subtrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-runtime-bytes-'));
  const reference = path.join(root, 'reference'), installed = path.join(root, 'installed');
  try {
    for (const directory of [reference, installed]) {
      fs.mkdirSync(path.join(directory, 'ui'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), '{"version":"5.0.9"}');
      fs.writeFileSync(path.join(directory, 'ui/app.js'), 'console.log("released");');
    }
    fs.writeFileSync(path.join(reference, 'node_modules/unrelated'), 'dependency resolution is checked separately');
    assert.equal(verifyBytes(reference, installed), 2);
    fs.writeFileSync(path.join(installed, 'ui/app.js'), 'console.log("stale");');
    assert.throws(() => verifyBytes(reference, installed), /bytes differ/);
    fs.unlinkSync(path.join(installed, 'ui/app.js'));
    assert.throws(() => verifyBytes(reference, installed), /missing or linked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
