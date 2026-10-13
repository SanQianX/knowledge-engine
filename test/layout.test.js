'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeLayout } = require('../src/runtime/layout');

test('native path canonicalization preserves Unicode, missing leaves and junction escape checks', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-realpath-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, '知识 根目录'), outside = path.join(fixture, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const layout = new RuntimeLayout(root);
  assert.equal(layout.isPathInside(root, path.join(root, 'missing', 'file.md'), { realpath: true }), true);
  assert.equal(layout.isPathInside(root, path.join(outside, 'file.md'), { realpath: true }), false);
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(layout.isPathInside(root, path.join(root, 'escape', 'file.md'), { realpath: true }), false);
  assert.equal(layout.pathsEqual(root, path.join(root, '..', path.basename(root))), true);
});
