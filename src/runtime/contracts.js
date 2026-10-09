const crypto = require('crypto');

const SCHEMAS = Object.freeze({
  settings: 'settings/v2',
  projectRegistry: 'project-registry/v2',
  projectConfig: 'project-config/v2',
  projectState: 'project-state/v2',
  requirement: 'requirement/v1',
  aiCodingEvent: 'ai-coding-event/v1',
  gitCommitBoundary: 'git-commit-boundary/v1',
  commitConversationSnapshot: 'commit-conversation-snapshot/v1',
  commitClaim: 'commit-claim/v1',
  promotionJournal: 'promotion-journal/v1',
  migrationJournal: 'migration-journal/v1',
  log: 'log/v2',
  hookEvent: 'hook-event/v2',
});

const SCHEMA_VERSIONS = Object.freeze({
  settings: 2,
  projectRegistry: 2,
  projectConfig: 2,
  projectState: 2,
  hookManaged: 2,
  layoutMigration: 'layout-v2',
});

const TRIGGERS = Object.freeze(['git-hook']);
const TRIGGER_SET = new Set(TRIGGERS);
const LOG_LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const LOG_LEVEL_SET = new Set(LOG_LEVELS);
const ANALYSIS_PHASES = Object.freeze([
  'idle',
  'scanning',
  'claim.created',
  'requirement.bound',
  'evidence.prepared',
  'ai.running',
  'output.validated',
  'promotion.prepared',
  'markdown.promoted',
  'state.advanced',
  'index.queued',
  'index.applied',
  'history-diverged',
  'failed',
]);

const ERROR_CODES = Object.freeze([
  'INVALID_ARGUMENT',
  'INVALID_TRIGGER',
  'SCHEMA_UNSUPPORTED',
  'DATA_CORRUPT',
  'IMMUTABLE_FIELD',
  'PROJECT_BUSY',
  'PROJECT_NOT_FOUND',
  'PROJECT_AMBIGUOUS',
  'HOOK_CONFLICT',
  'HOOK_INVALID',
  'HISTORY_DIVERGED',
  'MIGRATION_SOURCE_CHANGED',
  'MIGRATION_TARGET_CONFLICT',
  'MIGRATION_FAILED',
  'PATH_OUTSIDE_ROOT',
  'AUTH_REQUIRED',
  'ORIGIN_FORBIDDEN',
  'LOGGER_UNAVAILABLE',
  'LOG_CURSOR_EXPIRED',
  'EVIDENCE_INTEGRITY_FAILED',
  'AI_PROFILE_REQUIRED',
]);

const IMMUTABLE_PROJECT_FIELDS = Object.freeze([
  'schema',
  'schemaVersion',
  'projectId',
  'storageName',
  'createdAt',
  'knowledgePath',
]);
const MUTABLE_PROJECT_FIELDS = Object.freeze([
  'displayName',
  'enabled',
  'aiProfileId',
  'knowledgeLanguage',
  'relatedProjectIds',
]);

const REDACTED_VALUE = '[REDACTED]';
const REDACTION_KEY_PATTERN = /(?:api[-_]?key|auth(?:orization|token)?|access[-_]?token|refresh[-_]?token|bearer|password|passwd|secret|client[-_]?secret|private[-_]?key|cookie|set-cookie)/i;
const FIELD_LIMITS = Object.freeze({
  message: 4096,
  stack: 16384,
  path: 4096,
  contextString: 8192,
  requirement: 131072,
});

class DomainError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code || 'Domain error'), options.cause ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = ERROR_CODES.includes(code) ? code : 'INVALID_ARGUMENT';
    this.status = Number.isInteger(options.status) ? options.status : 400;
    this.retryable = options.retryable === true;
    this.operationId = options.operationId || '';
    this.details = sanitizePublicDetails(options.details);
  }
}

function createId(prefix) {
  const base = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${base}`;
}

function assertSchema(actual, expected, category = 'data') {
  if (actual !== expected) {
    throw new DomainError('SCHEMA_UNSUPPORTED', `Unsupported ${category} schema.`, {
      status: 409,
      details: { category, expected, actual: String(actual || '') },
    });
  }
  return true;
}

function validateTrigger(trigger) {
  if (!TRIGGER_SET.has(trigger)) {
    throw new DomainError('INVALID_TRIGGER', 'Trigger must be git-hook.', {
      details: { trigger: String(trigger || '') },
    });
  }
  return trigger;
}

function validateLogLevel(level) {
  if (!LOG_LEVEL_SET.has(level)) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid log level.', {
      details: { level: String(level || '') },
    });
  }
  return level;
}

function validateProjectId(projectId) {
  const value = String(projectId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid projectId.');
  }
  return value;
}

function validateStateTransition(from, to) {
  if (!ANALYSIS_PHASES.includes(from) || !ANALYSIS_PHASES.includes(to)) {
    throw new DomainError('INVALID_ARGUMENT', 'Unknown analysis phase.', { details: { from, to } });
  }
  if (from === to) return true;
  const allowed = {
    idle: ['scanning', 'index.queued', 'failed'],
    scanning: ['claim.created', 'idle', 'history-diverged', 'failed'],
    'claim.created': ['requirement.bound', 'failed'],
    'requirement.bound': ['evidence.prepared', 'failed'],
    'evidence.prepared': ['ai.running', 'failed'],
    'ai.running': ['output.validated', 'failed'],
    'output.validated': ['promotion.prepared', 'failed'],
    'promotion.prepared': ['markdown.promoted', 'failed'],
    'markdown.promoted': ['state.advanced', 'failed'],
    'state.advanced': ['index.queued', 'scanning', 'idle', 'failed'],
    'index.queued': ['index.applied', 'failed'],
    'index.applied': ['idle', 'scanning'],
    'history-diverged': ['scanning', 'idle'],
    failed: ['scanning', 'ai.running', 'promotion.prepared', 'index.queued', 'idle'],
  };
  if (!(allowed[from] || []).includes(to)) {
    throw new DomainError('INVALID_ARGUMENT', `Invalid analysis transition: ${from} -> ${to}.`, {
      details: { from, to },
    });
  }
  return true;
}

function sanitizePublicDetails(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, FIELD_LIMITS.contextString);
  if (value instanceof Error) return { name: value.name, code: value.code || '', message: String(value.message || '').slice(0, FIELD_LIMITS.message) };
  if (typeof value !== 'object') return String(value).slice(0, FIELD_LIMITS.contextString);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizePublicDetails(item, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (REDACTION_KEY_PATTERN.test(key) || /stack/i.test(key) || /prompt|diff|header/i.test(key)) {
      continue;
    } else {
      out[key] = sanitizePublicDetails(child, seen);
    }
  }
  return out;
}

function serializeErrorEnvelope(error, operationId = '') {
  const source = error instanceof DomainError
    ? error
    : new DomainError('INVALID_ARGUMENT', 'The operation failed.', { status: 500, operationId });
  return {
    ok: false,
    error: {
      code: source.code,
      message: source.message,
      operationId: source.operationId || operationId || '',
      retryable: source.retryable === true,
      details: sanitizePublicDetails(source.details || {}),
    },
  };
}

function publicAiProfileView(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const secret = source.apiKey || source.authToken || source.anthropicAuthToken || '';
  const publicView = {};
  for (const [key, value] of Object.entries(source)) {
    if (REDACTION_KEY_PATTERN.test(key)) continue;
    publicView[key] = value;
  }
  publicView.hasApiKey = Boolean(secret);
  publicView.apiKeyMasked = secret ? `****${String(secret).slice(-4)}` : '';
  return publicView;
}

function publicAiProfilesConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    ...source,
    profiles: Array.isArray(source.profiles) ? source.profiles.map(publicAiProfileView) : [],
  };
}

function assertMutableProjectPatch(patch, options = {}) {
  const allowKnowledgePath = options.allowKnowledgePath === true;
  const allowRepoPath = options.allowRepoPath === true;
  for (const key of Object.keys(patch && typeof patch === 'object' ? patch : {})) {
    if (IMMUTABLE_PROJECT_FIELDS.includes(key) && !(allowKnowledgePath && key === 'knowledgePath')) {
      throw new DomainError('IMMUTABLE_FIELD', `Project field is immutable: ${key}.`, { status: 409, details: { field: key } });
    }
    if (!MUTABLE_PROJECT_FIELDS.includes(key)
      && !(allowKnowledgePath && key === 'knowledgePath')
      && !(allowRepoPath && key === 'repoPath')) {
      throw new DomainError('INVALID_ARGUMENT', `Unknown project field: ${key}.`, { details: { field: key } });
    }
  }
  return true;
}

module.exports = {
  SCHEMAS,
  SCHEMA_VERSIONS,
  TRIGGERS,
  LOG_LEVELS,
  ANALYSIS_PHASES,
  ERROR_CODES,
  IMMUTABLE_PROJECT_FIELDS,
  MUTABLE_PROJECT_FIELDS,
  REDACTED_VALUE,
  REDACTION_KEY_PATTERN,
  FIELD_LIMITS,
  DomainError,
  createId,
  assertSchema,
  validateTrigger,
  validateLogLevel,
  validateProjectId,
  validateStateTransition,
  sanitizePublicDetails,
  serializeErrorEnvelope,
  publicAiProfileView,
  publicAiProfilesConfig,
  assertMutableProjectPatch,
};
