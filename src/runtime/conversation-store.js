const fs = require('fs');
const crypto = require('crypto');
const { SCHEMAS, DomainError, validateProjectId } = require('./contracts');
const AtomicFile = require('./atomic-file');

const SOURCES = new Set(['claude-code', 'codex', 'opencode', 'zcode']);
const ROLES = new Set(['user', 'assistant', null]);
const SNAPSHOT_STATUSES = new Set(['available', 'no-new-user-prompt', 'unavailable', 'ambiguous']);
const BINDING_KINDS = new Set(['direct', 'shared-spanning', 'explicit']);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex')}`;
}

function optionalString(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function validateConversationEvent(event, expectedProjectId = '') {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new DomainError('INVALID_ARGUMENT', 'Conversation event is invalid.');
  if (event.schema !== SCHEMAS.aiCodingEvent) throw new DomainError('SCHEMA_UNSUPPORTED', 'Conversation event must use ai-coding-event/v1.', { status: 409 });
  const projectId = validateProjectId(event.projectId);
  if (expectedProjectId && projectId !== expectedProjectId) throw new DomainError('INVALID_ARGUMENT', 'Conversation event projectId does not match the store.');
  if (!event.eventId || typeof event.eventId !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Conversation eventId is required.');
  if (event.sequence != null && (!Number.isInteger(event.sequence) || event.sequence < 0)) throw new DomainError('INVALID_ARGUMENT', 'Conversation sequence must be a non-negative integer or null.');
  if (!SOURCES.has(event.source)) throw new DomainError('INVALID_ARGUMENT', 'Conversation source is invalid.');
  if (!event.eventType || typeof event.eventType !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Conversation eventType is required.');
  if (!ROLES.has(event.role)) throw new DomainError('INVALID_ARGUMENT', 'Conversation role is invalid.');
  if (event.role && typeof event.content !== 'string') throw new DomainError('INVALID_ARGUMENT', 'User and assistant events require text content.');
  if (!event.capturedAt || Number.isNaN(Date.parse(event.capturedAt))) throw new DomainError('INVALID_ARGUMENT', 'Conversation capturedAt must be an ISO timestamp.');
  if (event.contentHash !== sha256(event.content || '')) throw new DomainError('DATA_CORRUPT', 'Conversation content hash does not match.', { status: 409 });
  return event;
}

function normalizeConversationEvent(projectId, input = {}) {
  validateProjectId(projectId);
  const role = input.role == null ? null : String(input.role);
  const content = role ? String(input.content == null ? '' : input.content) : '';
  const normalized = {
    schema: SCHEMAS.aiCodingEvent,
    projectId,
    eventId: String(input.eventId || '').trim(),
    sequence: input.sequence == null ? null : Number(input.sequence),
    journalId: optionalString(input.journalId) || 'global',
    source: String(input.source || ''),
    eventType: String(input.eventType || ''),
    role,
    inputOrigin: ['human', 'agent-delegation'].includes(input.inputOrigin) ? input.inputOrigin : 'unknown',
    content,
    contentHash: sha256(content),
    sessionId: optionalString(input.sessionId),
    turnId: optionalString(input.turnId),
    projectPath: optionalString(input.projectPath),
    repoIdentity: input.repoIdentity && typeof input.repoIdentity === 'object' ? { ...input.repoIdentity } : null,
    branch: optionalString(input.branch),
    headAtCapture: optionalString(input.headAtCapture),
    capturedAt: input.capturedAt || new Date().toISOString(),
    rawEventType: optionalString(input.rawEventType),
    identityConfidence: optionalString(input.identityConfidence) || 'unknown',
    captureStatus: optionalString(input.captureStatus) || 'captured',
    explicitCommitSha: optionalString(input.explicitCommitSha),
    legacyRequirementId: optionalString(input.legacyRequirementId),
  };
  return validateConversationEvent(normalized, projectId);
}

function readJsonlStrict(filePath, validator, category) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      records.push(validator(JSON.parse(lines[index])));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('DATA_CORRUPT', `${category} JSONL is corrupt.`, { status: 500, cause: error, details: { line: index + 1 } });
    }
  }
  return records;
}

function appendJsonlDurable(filePath, value) {
  fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, line, 0, line.length, null);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateBoundary(boundary, expectedProjectId = '', expectedCommitSha = '') {
  if (!boundary || typeof boundary !== 'object' || boundary.schema !== SCHEMAS.gitCommitBoundary) {
    throw new DomainError('SCHEMA_UNSUPPORTED', 'Commit boundary must use git-commit-boundary/v1.', { status: 409 });
  }
  validateProjectId(boundary.projectId);
  if (expectedProjectId && boundary.projectId !== expectedProjectId) throw new DomainError('DATA_CORRUPT', 'Commit boundary projectId mismatch.', { status: 500 });
  if (!boundary.commitSha || (expectedCommitSha && boundary.commitSha !== expectedCommitSha)) throw new DomainError('DATA_CORRUPT', 'Commit boundary SHA mismatch.', { status: 500 });
  if (!Number.isInteger(boundary.bridgeCursorAtCommit) || boundary.bridgeCursorAtCommit < 0) throw new DomainError('INVALID_ARGUMENT', 'Commit boundary cursor is invalid.');
  if (boundary.journalSequence != null && (!Number.isInteger(boundary.journalSequence) || boundary.journalSequence < 0)) throw new DomainError('INVALID_ARGUMENT', 'Commit boundary journal sequence is invalid.');
  if (!Array.isArray(boundary.parentShas) || !Array.isArray(boundary.openTurnIdsAtCommit)) throw new DomainError('INVALID_ARGUMENT', 'Commit boundary collections are invalid.');
  if (!boundary.operationId || !boundary.committedAt) throw new DomainError('INVALID_ARGUMENT', 'Commit boundary operation metadata is required.');
  return boundary;
}

function snapshotPayload(snapshot) {
  const { snapshotHash, ...payload } = snapshot;
  return payload;
}

function validateSnapshot(snapshot, expectedProjectId = '', expectedCommitSha = '') {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SCHEMAS.commitConversationSnapshot) {
    throw new DomainError('SCHEMA_UNSUPPORTED', 'Commit conversation snapshot must use commit-conversation-snapshot/v1.', { status: 409 });
  }
  validateProjectId(snapshot.projectId);
  if (expectedProjectId && snapshot.projectId !== expectedProjectId) throw new DomainError('DATA_CORRUPT', 'Conversation snapshot projectId mismatch.', { status: 500 });
  if (!snapshot.commitSha || (expectedCommitSha && snapshot.commitSha !== expectedCommitSha)) throw new DomainError('DATA_CORRUPT', 'Conversation snapshot SHA mismatch.', { status: 500 });
  if (!SNAPSHOT_STATUSES.has(snapshot.status) || !Array.isArray(snapshot.turns)) throw new DomainError('INVALID_ARGUMENT', 'Conversation snapshot status or turns are invalid.');
  for (const turn of snapshot.turns) {
    if (!turn.turnId || !BINDING_KINDS.has(turn.bindingKind) || !Array.isArray(turn.userEvents) || !Array.isArray(turn.assistantEvents)) {
      throw new DomainError('INVALID_ARGUMENT', 'Conversation snapshot turn is invalid.');
    }
    for (const event of [...turn.userEvents, ...turn.assistantEvents]) {
      if (!event.eventId || event.contentHash !== sha256(event.content || '')) throw new DomainError('DATA_CORRUPT', 'Snapshot event hash does not match.', { status: 409 });
    }
  }
  if (snapshot.snapshotHash !== sha256(JSON.stringify(snapshotPayload(snapshot)))) throw new DomainError('DATA_CORRUPT', 'Conversation snapshot hash does not match.', { status: 409 });
  return snapshot;
}

class ConversationStore {
  constructor(options = {}) {
    this.layout = options.layout;
    this.atomic = options.atomic || AtomicFile;
    this.projectStore = options.projectStore || null;
    this.logger = options.logger || null;
  }

  async log(level, event, message, context) {
    try {
      if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
    } catch {
      // Conversation durability is independent from observer failures.
    }
  }

  readEvents(projectId) {
    validateProjectId(projectId);
    return readJsonlStrict(
      this.layout.getProjectConversationEventsPath(projectId),
      event => validateConversationEvent(event, projectId),
      'Conversation events',
    );
  }

  async appendEvent(projectId, input) {
    const event = normalizeConversationEvent(projectId, input);
    const filePath = this.layout.getProjectConversationEventsPath(projectId);
    const result = await this.atomic.withFileLock(`${filePath}.append.lock`, async () => {
      const existing = this.readEvents(projectId).find(candidate => candidate.eventId === event.eventId);
      if (existing) {
        if (sha256(JSON.stringify(existing)) !== sha256(JSON.stringify(event))) {
          throw new DomainError('DATA_CORRUPT', 'Duplicate conversation eventId has different content.', { status: 409 });
        }
        return { event: existing, appended: false };
      }
      appendJsonlDurable(filePath, event);
      return { event, appended: true };
    });
    await this.log('info', result.appended ? 'conversation.event_appended' : 'conversation.event_deduplicated', 'Conversation event persisted.', {
      projectId,
      component: 'conversation-store',
      context: {
        eventId: event.eventId,
        sequence: event.sequence,
        source: event.source,
        eventType: event.eventType,
        role: event.role,
        contentHash: event.contentHash,
        contentLength: event.content.length,
      },
    });
    return result;
  }

  _projectWorkspaceId(projectId) {
    try {
      const config = this.projectStore && typeof this.projectStore.readConfig === 'function'
        ? this.projectStore.readConfig(projectId)
        : null;
      const identity = config && config.repoIdentity;
      return identity && typeof identity === 'object' && typeof identity.workspaceId === 'string'
        ? identity.workspaceId
        : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Project-scoped projection of a canonical Bridge journal event. The global
   * eventId / sequence / turnId / repoIdentity are preserved verbatim; a new
   * local sequence is never assigned; dedup is by eventId with DATA_CORRUPT on
   * content drift; an exact event whose workspaceId differs from the project's
   * canonical workspace is rejected instead of contaminating the store.
   */
  async appendBridgeEvent(projectId, bridgeEvent) {
    if (!bridgeEvent || typeof bridgeEvent !== 'object' || bridgeEvent.schema !== SCHEMAS.aiCodingEvent) {
      throw new DomainError('SCHEMA_UNSUPPORTED', 'Bridge conversation event must use ai-coding-event/v1.', { status: 409 });
    }
    if (bridgeEvent.eventType !== 'user_prompt' && bridgeEvent.eventType !== 'assistant_response') {
      throw new DomainError('INVALID_ARGUMENT', 'Bridge conversation event must be a user_prompt or assistant_response.');
    }
    if (!bridgeEvent.eventId || typeof bridgeEvent.eventId !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'Bridge eventId is required.');
    }
    if (!Number.isInteger(bridgeEvent.sequence) || bridgeEvent.sequence < 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Bridge sequence is required for projected events.');
    }
    const configWorkspaceId = this._projectWorkspaceId(projectId);
    const eventIdentity = bridgeEvent.repoIdentity;
    const eventWorkspaceId = eventIdentity && typeof eventIdentity === 'object' && typeof eventIdentity.workspaceId === 'string'
      ? eventIdentity.workspaceId
      : null;
    if (configWorkspaceId && eventWorkspaceId && configWorkspaceId !== eventWorkspaceId) {
      throw new DomainError('DATA_CORRUPT', 'Bridge event workspaceId does not match the project workspace.', { status: 409 });
    }
    return this.appendEvent(projectId, {
      eventId: bridgeEvent.eventId,
      sequence: bridgeEvent.sequence,
      journalId: bridgeEvent.journalId,
      source: bridgeEvent.source,
      eventType: bridgeEvent.eventType,
      role: bridgeEvent.role,
      inputOrigin: bridgeEvent.inputOrigin || bridgeEvent.meta?.inputOrigin || /:origin=(human|agent-delegation|unknown)$/.exec(String(bridgeEvent.eventKey || ''))?.[1],
      content: bridgeEvent.content == null ? '' : bridgeEvent.content,
      sessionId: bridgeEvent.sessionId,
      turnId: bridgeEvent.turnId,
      projectPath: bridgeEvent.projectPath,
      repoIdentity: eventIdentity,
      branch: bridgeEvent.branch,
      headAtCapture: bridgeEvent.headAtCapture,
      capturedAt: bridgeEvent.capturedAt,
      rawEventType: bridgeEvent.rawEventType,
      identityConfidence: bridgeEvent.identityConfidence,
      captureStatus: bridgeEvent.captureStatus,
    });
  }

  legacyRequirementToEvent(projectId, requirement) {
    if (!requirement || requirement.schema !== SCHEMAS.requirement || requirement.projectId !== projectId || !requirement.id) {
      throw new DomainError('INVALID_ARGUMENT', 'Legacy requirement record is invalid.');
    }
    const source = requirement.client === 'claude' ? 'claude-code' : requirement.client;
    return normalizeConversationEvent(projectId, {
      eventId: `legacy-${requirement.id}`,
      sequence: null,
      source: SOURCES.has(source) ? source : 'codex',
      eventType: 'user_prompt',
      role: 'user',
      content: requirement.requirement,
      sessionId: requirement.sessionId,
      turnId: `legacy-${requirement.id}`,
      projectPath: requirement.repoPath,
      repoIdentity: requirement.repoIdentity || null,
      branch: requirement.branch,
      headAtCapture: requirement.headAtRecord,
      capturedAt: requirement.ts,
      rawEventType: 'legacy-requirement',
      identityConfidence: requirement.explicitCommit ? 'explicit' : 'legacy',
      captureStatus: 'legacy-explicit-adapter',
      explicitCommitSha: requirement.explicitCommit,
      legacyRequirementId: requirement.id,
    });
  }

  async importLegacyRequirements(projectId, records = null) {
    const requirements = records || (this.projectStore ? this.projectStore.readRequirements(projectId) : []);
    const results = [];
    for (const requirement of requirements) results.push(await this.appendEvent(projectId, this.legacyRequirementToEvent(projectId, requirement)));
    return results;
  }

  writeBoundary(projectId, boundaryInput) {
    const commitSha = this.layout.validateCommitSha(boundaryInput.commitSha);
    const boundary = validateBoundary({
      schema: SCHEMAS.gitCommitBoundary,
      projectId,
      repoIdentity: boundaryInput.repoIdentity || null,
      commitSha,
      parentShas: Array.isArray(boundaryInput.parentShas) ? boundaryInput.parentShas.map(value => String(value).toLowerCase()) : [],
      branch: optionalString(boundaryInput.branch),
      committedAt: boundaryInput.committedAt || new Date().toISOString(),
      bridgeCursorAtCommit: Number(boundaryInput.bridgeCursorAtCommit),
      openTurnIdsAtCommit: Array.isArray(boundaryInput.openTurnIdsAtCommit) ? [...new Set(boundaryInput.openTurnIdsAtCommit.map(String))] : [],
      operationId: String(boundaryInput.operationId || ''),
      journalSequence: Number.isInteger(boundaryInput.journalSequence) ? boundaryInput.journalSequence : Number(boundaryInput.bridgeCursorAtCommit),
      journalId: optionalString(boundaryInput.journalId) || 'global',
      boundaryHash: '',
    }, projectId, commitSha);
    boundary.boundaryHash = sha256(JSON.stringify({ ...boundary, boundaryHash: undefined }));
    const filePath = this.layout.getProjectCommitBoundaryPath(projectId, commitSha);
    if (fs.existsSync(filePath)) {
      const existing = this.readBoundary(projectId, commitSha);
      if (existing.boundaryHash !== boundary.boundaryHash) throw new DomainError('DATA_CORRUPT', 'Conflicting evidence was supplied for an existing commit boundary.', { status: 409 });
      return existing;
    }
    this.atomic.writeJsonAtomic(filePath, boundary);
    return boundary;
  }

  readBoundary(projectId, commitSha) {
    const normalizedSha = this.layout.validateCommitSha(commitSha);
    return this.atomic.readJsonStrict(this.layout.getProjectCommitBoundaryPath(projectId, normalizedSha), {
      category: 'git-commit-boundary',
      validate: value => validateBoundary(value, projectId, normalizedSha),
    });
  }

  listBoundaries(projectId) {
    validateProjectId(projectId);
    const directory = this.layout.getProjectCommitBoundariesDir(projectId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-f0-9]{7,64}\.json$/i.test(entry.name))
      .map(entry => this.readBoundary(projectId, entry.name.slice(0, -5)));
  }

  writeSnapshot(projectId, input) {
    const commitSha = this.layout.validateCommitSha(input.commitSha);
    const snapshot = {
      schema: SCHEMAS.commitConversationSnapshot,
      projectId,
      repoIdentity: input.repoIdentity || null,
      commitSha,
      parentSha: input.parentSha || null,
      boundaryStartCursor: input.boundaryStartCursor == null ? null : Number(input.boundaryStartCursor),
      boundaryEndCursor: input.boundaryEndCursor == null ? null : Number(input.boundaryEndCursor),
      status: input.status,
      turns: input.turns || [],
      excludedFuturePromptCount: Number(input.excludedFuturePromptCount || 0),
      finalizedAt: input.finalizedAt || new Date().toISOString(),
      snapshotHash: '',
    };
    snapshot.snapshotHash = sha256(JSON.stringify(snapshotPayload(snapshot)));
    validateSnapshot(snapshot, projectId, commitSha);
    const filePath = this.layout.getProjectCommitConversationPath(projectId, commitSha);
    if (fs.existsSync(filePath)) {
      const existing = this.readSnapshot(projectId, commitSha);
      if (existing.snapshotHash !== snapshot.snapshotHash) throw new DomainError('IMMUTABLE_FIELD', 'Commit conversation snapshot is already frozen.', { status: 409 });
      return existing;
    }
    this.atomic.writeJsonAtomic(filePath, snapshot);
    return snapshot;
  }

  readSnapshot(projectId, commitSha) {
    const normalizedSha = this.layout.validateCommitSha(commitSha);
    return this.atomic.readJsonStrict(this.layout.getProjectCommitConversationPath(projectId, normalizedSha), {
      category: 'commit-conversation-snapshot',
      validate: value => validateSnapshot(value, projectId, normalizedSha),
    });
  }

  listSnapshots(projectId) {
    validateProjectId(projectId);
    const directory = this.layout.getProjectCommitConversationsDir(projectId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-f0-9]{7,64}\.json$/i.test(entry.name))
      .map(entry => this.readSnapshot(projectId, entry.name.slice(0, -5)));
  }
}

module.exports = {
  ConversationStore,
  SOURCES,
  SNAPSHOT_STATUSES,
  BINDING_KINDS,
  sha256,
  normalizeConversationEvent,
  validateConversationEvent,
  validateBoundary,
  validateSnapshot,
};
