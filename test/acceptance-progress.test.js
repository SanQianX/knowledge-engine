'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { latestSuite, allPassed } = require('./support/acceptance-progress');

test('acceptance aggregation never counts missing, failed or nonzero reports as passed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-progress-proof-'));
  try {
    assert.equal(latestSuite(directory, 'case').status, 'not-run');
    fs.writeFileSync(path.join(directory, 'case-100.json'), JSON.stringify({ label: 'case', passed: true, exitCode: 0 }));
    fs.writeFileSync(path.join(directory, 'case-other-999.json'), JSON.stringify({ label: 'case-other', passed: true, exitCode: 0 }));
    assert.equal(latestSuite(directory, 'case').passed, true);
    fs.writeFileSync(path.join(directory, 'case-101.json'), JSON.stringify({ label: 'case', passed: false, exitCode: 1 }));
    assert.equal(latestSuite(directory, 'case').status, 'failed');
    fs.writeFileSync(path.join(directory, 'case-102.json'), JSON.stringify({ label: 'case', passed: true, exitCode: 1 }));
    assert.equal(latestSuite(directory, 'case').passed, false);
    assert.equal(allPassed([]), false);
    assert.equal(allPassed([{ passed: true }, { passed: false }]), false);
    assert.equal(allPassed([{ passed: true }]), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
