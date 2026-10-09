'use strict';
const crypto = require('node:crypto');
function sha256(value) { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
module.exports = { sha256 };
