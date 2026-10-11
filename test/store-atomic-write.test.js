'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineStore } = require('../src/store');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-store-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new EngineStore(directory);
  store.save();
  return store;
}

test('state replacement retries a transient Windows sharing error without deleting durable state', t => {
  const store = fixture(t);
  const originalBytes = fs.readFileSync(store.file);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', function (source, target) {
    if (target !== store.file) return rename.apply(this, arguments);
    attempts++;
    assert.deepEqual(fs.readFileSync(store.file), originalBytes);
    if (attempts === 1) throw Object.assign(new Error('controlled transient sharing violation'), { code: 'EPERM' });
    return rename.apply(this, arguments);
  });
  store.state.cursor = 7;
  store.save();
  assert.equal(attempts, 2);
  assert.equal(new EngineStore(store.dataDir).state.cursor, 7);
  assert.deepEqual(fs.readdirSync(store.dataDir), ['engine-state.json']);
});

test('persistent state replacement failure retains original bytes and removes only its own temp', t => {
  const store = fixture(t);
  const originalBytes = fs.readFileSync(store.file);
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', function (source, target) {
    if (target !== store.file) return rename.apply(this, arguments);
    attempts++;
    throw Object.assign(new Error('controlled permanent sharing violation'), { code: 'EACCES' });
  });
  store.state.cursor = 8;
  assert.throws(() => store.save(), { code: 'EACCES' });
  assert.equal(attempts, 9, 'sharing retries must be bounded');
  assert.deepEqual(fs.readFileSync(store.file), originalBytes);
  assert.deepEqual(fs.readdirSync(store.dataDir), ['engine-state.json']);
});

test('state temp writes never overwrite a prior fixed-name temporary file', t => {
  const store = fixture(t);
  const occupied = store.file + '.tmp';
  fs.writeFileSync(occupied, 'foreign incomplete writer');
  store.state.cursor = 9;
  store.save();
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'foreign incomplete writer');
  assert.equal(new EngineStore(store.dataDir).state.cursor, 9);
  assert.deepEqual(fs.readdirSync(store.dataDir).sort(), ['engine-state.json', 'engine-state.json.tmp']);
});

test('disk-full temp write fails immediately without truncating original state', t => {
  const store = fixture(t);
  const originalBytes = fs.readFileSync(store.file);
  const write = fs.writeFileSync;
  let attempts = 0;
  t.mock.method(fs, 'writeFileSync', function (file) {
    if (typeof file !== 'number') return write.apply(this, arguments);
    attempts++;
    throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => store.save(), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
  assert.deepEqual(fs.readFileSync(store.file), originalBytes);
  assert.deepEqual(fs.readdirSync(store.dataDir), ['engine-state.json']);
});
