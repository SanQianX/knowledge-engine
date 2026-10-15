'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a preview launched by an embedded Agent replaces the parent product root with its own fixture root', () => {
  const source = fs.readFileSync(path.join(__dirname, 'support/product-preview.js'), 'utf8');
  const begin = source.indexOf("process.env.KB_MODULES_AUTOSTART = '0'");
  const end = source.indexOf('const productLogger', begin);
  assert.ok(begin > 0 && end > begin);
  const root = path.resolve('owned-preview'), parent = path.resolve('other-product');
  const env = { KB_DATA_DIR: parent, KB_KNOWLEDGE_DATA_DIR: parent };
  vm.runInNewContext(source.slice(begin, end), { process: { env }, root, path });
  assert.equal(env.KB_DATA_DIR, path.join(root, 'shell'));
  assert.equal(env.KB_KNOWLEDGE_DATA_DIR, path.join(root, 'shell'));
});
