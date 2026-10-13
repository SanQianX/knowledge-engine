'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
function runtimeRoots() {
  const family = path.resolve(__dirname, '../../..');
  const file = process.env.KB_PRODUCT_INSTALLATION_REPORT;
  if (!file) return { source: 'source checkouts', engine: path.join(family, 'knowledge-engine'), vector: path.join(family, 'vector-hub'), workbench: path.join(family, 'claude-ai-workbench') };
  const installation = JSON.parse(fs.readFileSync(file));
  if (!installation.integrityPassed || installation.schema !== 'project-knowledge/installed-registry/v1') throw new Error('VERIFIED_REGISTRY_INSTALLATION_REQUIRED');
  const resolve = createRequire(path.join(installation.core, 'package.json'));
  const roots = { source: installation.schema, version: installation.version, engine: path.join(installation.core, '_modules/knowledge-engine'),
    vector: path.dirname(resolve.resolve('@sanqianx/vector-hub/package.json')), workbench: path.dirname(resolve.resolve('claude-ai-workbench/package.json')) };
  for (const name of ['engine', 'vector', 'workbench']) if (!roots[name].startsWith(path.resolve(installation.installedRoot) + path.sep)) throw new Error('SOURCE_FALLBACK_FORBIDDEN');
  return roots;
}
module.exports = { runtimeRoots };
