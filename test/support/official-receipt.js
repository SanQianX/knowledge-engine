'use strict';
const assert = require('node:assert/strict');

const OFFICIAL_SCHEMA = 'project-knowledge/installed-registry/v1';
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
const OFFICIAL_TAGS = ['next', 'latest'];

// A real source identity is a full 40-hex commit; the all-zero placeholder
// or a short tag a detached or forged receipt carries is never accepted as
// source evidence.
function isRealCommit(value) {
  return typeof value === 'string' && FULL_COMMIT.test(value) && !/^0{40}$/.test(value);
}

// 5.0.16 and every later release must prove identity; only the frozen 5.0.x
// history (<= 15) keeps its legacy unbound compatibility.
function isNewRelease(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.\d+)?$/.exec(version || '');
  if (!match) return false;
  return !(Number(match[1]) === 5 && Number(match[2]) === 0 && Number(match[3]) <= 15);
}

// Install identity is only legal from the official registry with a verified
// download, a real dist-tag and full-length identities. Anything else must
// be refused before a suite or upgrade runs on its behalf.
function assertOfficialReceipt(installation, { tag = null } = {}) {
  assert.equal(installation.schema, OFFICIAL_SCHEMA, 'install identity must come from an official registry installation receipt');
  assert.equal(installation.registry, OFFICIAL_REGISTRY, 'install identity must come from the official npm registry');
  assert.equal(installation.integrityPassed, true, 'install identity requires a verified integrity check');
  assert.ok(OFFICIAL_TAGS.includes(installation.tag), `install identity must record a real dist-tag (next/latest), not ${installation.tag}`);
  if (tag) assert.equal(installation.tag, tag, `install identity must carry the ${tag} dist-tag for this mode`);
  assert.match(installation.version || '', EXACT_VERSION, 'install identity must record an exact published version');
  assert.match(installation.engineVersion || '', EXACT_VERSION, 'install identity must record the exact vendored engine version');
  assert.match(installation.distIntegrity || '', NPM_INTEGRITY, 'install identity must carry the real npm dist integrity');
  assert.ok(isRealCommit(installation.sourceCommit), 'install identity must carry the full-length git source commit of the installed package');
}

module.exports = { OFFICIAL_SCHEMA, OFFICIAL_REGISTRY, NPM_INTEGRITY, FULL_COMMIT, EXACT_VERSION, OFFICIAL_TAGS, isRealCommit, isNewRelease, assertOfficialReceipt };
