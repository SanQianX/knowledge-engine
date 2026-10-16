const fs = require('fs');
const { DomainError, validateProjectId } = require('./contracts');
const { ConversationStore, sha256 } = require('./conversation-store');
const { readDevelopmentEvents } = require('./conversation-exclusions');

function projectEvent(event) {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    content: event.content,
    contentHash: event.contentHash,
    inputOrigin: event.inputOrigin || 'unknown',
    capturedAt: event.capturedAt,
  };
}

class CommitConversationBinder {
  constructor(options = {}) {
    this.layout = options.layout;
    this.projectStore = options.projectStore;
    this.conversationStore = options.conversationStore || new ConversationStore({
      layout: this.layout,
      projectStore: this.projectStore,
      logger: options.logger,
    });
    this.logger = options.logger || null;
  }

  async log(level, event, message, context) {
    if (this.logger && typeof this.logger[level] === 'function') await this.logger[level](event, message, context);
  }

  repoMatches(left, right) {
    if (!left || !right) return false;
    // workspaceId is the canonical primary key (I-06). commonDir/repoId are
    // read-compat fallbacks for records stored before repo-identity/v1.
    if (left.workspaceId && right.workspaceId) return String(left.workspaceId) === String(right.workspaceId);
    if (left.commonDir && right.commonDir) return this.layout.pathsEqual(left.commonDir, right.commonDir);
    if (left.repoId && right.repoId) return String(left.repoId) === String(right.repoId);
    return false;
  }

  boundaryOrder(boundary) {
    return Number.isInteger(boundary.journalSequence) ? boundary.journalSequence : boundary.bridgeCursorAtCommit;
  }

  previousBoundary(projectId, boundary) {
    const order = this.boundaryOrder(boundary);
    return this.conversationStore.listBoundaries(projectId)
      .filter(candidate => candidate.commitSha !== boundary.commitSha
        && (candidate.journalId || 'global') === (boundary.journalId || 'global')
        && this.repoMatches(candidate.repoIdentity, boundary.repoIdentity)
        && this.boundaryOrder(candidate) < order)
      .sort((left, right) => this.boundaryOrder(right) - this.boundaryOrder(left))[0] || null;
  }

  snapshotExists(projectId, commitSha) {
    return fs.existsSync(this.layout.getProjectCommitConversationPath(projectId, commitSha));
  }

  async bind(input = {}) {
    const projectId = validateProjectId(input.projectId);
    const commitSha = this.layout.validateCommitSha(input.commitSha);
    if (this.snapshotExists(projectId, commitSha)) return this.conversationStore.readSnapshot(projectId, commitSha);

    if (this.projectStore) await this.conversationStore.importLegacyRequirements(projectId);
    // Development Conversation reads are centralized: exclusions and Codex
    // turn repair are identical here and in the query service.
    let events = readDevelopmentEvents(this.conversationStore, projectId);
    let boundary = null;
    try { boundary = this.conversationStore.readBoundary(projectId, commitSha); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    if (boundary) events = events.filter(event => (event.journalId || 'global') === (boundary.journalId || 'global'));
    const explicitEvents = events.filter(event => event.role === 'user' && event.explicitCommitSha === commitSha);
    if (!boundary) {
      const turns = this.buildExplicitTurns(explicitEvents);
      return this.finalize(projectId, commitSha, {
        repoIdentity: null,
        parentSha: null,
        boundaryStartCursor: null,
        boundaryEndCursor: null,
        status: turns.length ? 'available' : 'unavailable',
        turns,
        excludedFuturePromptCount: 0,
      }, { reason: 'missing-commit-boundary' });
    }

    const previous = this.previousBoundary(projectId, boundary);
    const state = this.projectStore ? this.projectStore.readState(projectId) : { conversationBaselineCursor: null };
    const journalId = boundary.journalId || 'global';
    const baseline = state.conversationBaselineCursors?.[journalId] ?? (journalId === 'global' ? state.conversationBaselineCursor : 0);
    const startCursor = previous ? previous.bridgeCursorAtCommit : baseline;
    const endCursor = boundary.bridgeCursorAtCommit;
    const selected = new Map();
    let ambiguousCount = 0;
    let excludedFuturePromptCount = 0;

    for (const event of explicitEvents) {
      if (event.repoIdentity && boundary.repoIdentity && !this.repoMatches(event.repoIdentity, boundary.repoIdentity)) {
        ambiguousCount += 1;
        continue;
      }
      if (!event.turnId) { ambiguousCount += 1; continue; }
      selected.set(event.turnId, 'explicit');
    }

    if (Number.isInteger(startCursor)) {
      for (const event of events) {
        if (event.role !== 'user' || event.sequence == null || event.explicitCommitSha) continue;
        if (!this.repoMatches(event.repoIdentity, boundary.repoIdentity)) {
          if (event.sequence > startCursor && event.sequence <= endCursor && !event.repoIdentity) ambiguousCount += 1;
          continue;
        }
        if (event.sequence > endCursor) {
          excludedFuturePromptCount += 1;
          continue;
        }
        if (event.sequence <= startCursor) continue;
        // Automatic direct evidence requires exact identity. Legacy stored
        // 'high'/'trusted' translate to exact for old known data only;
        // 'explicit' is the explicit-fallback tier (I-18: no synthetic).
        const rawConfidence = String(event.identityConfidence || '');
        const effectiveConfidence = rawConfidence === 'high' || rawConfidence === 'trusted' ? 'exact' : rawConfidence;
        if (!event.turnId || !['exact', 'explicit'].includes(effectiveConfidence)) {
          ambiguousCount += 1;
          continue;
        }
        selected.set(event.turnId, 'direct');
      }

      for (const turnId of boundary.openTurnIdsAtCommit) {
        if (selected.has(turnId)) continue;
        const user = events.find(event => event.role === 'user'
          && event.turnId === turnId
          && event.sequence != null
          && event.sequence <= startCursor
          && this.repoMatches(event.repoIdentity, boundary.repoIdentity));
        const closedAt = user && user.developmentTurnClosedAtSequence;
        if (user && !(Number.isInteger(closedAt) && closedAt <= startCursor)) {
          selected.set(turnId, 'shared-spanning');
        }
      }
    }

    const turns = [];
    for (const [turnId, bindingKind] of selected) {
      const turnEvents = events.filter(event => event.turnId === turnId).sort((left, right) => {
        if (left.sequence == null) return 1;
        if (right.sequence == null) return -1;
        return left.sequence - right.sequence;
      });
      const userEvents = turnEvents.filter(event => event.role === 'user'
        && (bindingKind === 'explicit' || (event.sequence != null && event.sequence <= endCursor)));
      if (!userEvents.length) continue;
      const first = userEvents[0];
      // I-13: no event beyond the commit boundary may enter a frozen
      // snapshot — including assistant replies that arrived after the
      // boundary but before a delayed binder run.
      const assistantEvents = turnEvents.filter(event => event.role === 'assistant'
        && (bindingKind === 'explicit' || (event.sequence != null && event.sequence <= endCursor)));
      turns.push({
        turnId,
        source: first.source,
        sessionId: first.sessionId,
        bindingKind,
        userEvents: userEvents.map(projectEvent),
        assistantEvents: assistantEvents.map(projectEvent),
      });
    }
    turns.sort((left, right) => {
      const a = left.userEvents[0].sequence;
      const b = right.userEvents[0].sequence;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    });

    let status = turns.length ? 'available' : 'no-new-user-prompt';
    let reason = turns.length ? 'sequence-window' : 'no-new-user-prompt';
    if (!Number.isInteger(startCursor)) {
      status = explicitEvents.length && turns.length ? 'available' : 'unavailable';
      reason = 'conversation-baseline-unavailable';
    } else if (ambiguousCount > 0 && !turns.length) {
      status = 'ambiguous';
      reason = 'turn-or-repo-identity-ambiguous';
    }

    return this.finalize(projectId, commitSha, {
      repoIdentity: boundary.repoIdentity,
      parentSha: boundary.parentShas[0] || null,
      boundaryStartCursor: startCursor,
      boundaryEndCursor: endCursor,
      status,
      turns,
      excludedFuturePromptCount,
    }, { reason, ambiguousCount, previousBoundaryCommit: previous && previous.commitSha || null });
  }

  buildExplicitTurns(events) {
    return events.filter(event => event.turnId).map(event => ({
      turnId: event.turnId,
      source: event.source,
      sessionId: event.sessionId,
      bindingKind: 'explicit',
      userEvents: [projectEvent(event)],
      assistantEvents: [],
    }));
  }

  async finalize(projectId, commitSha, snapshotInput, decision) {
    const snapshot = this.conversationStore.writeSnapshot(projectId, {
      commitSha,
      ...snapshotInput,
      finalizedAt: new Date().toISOString(),
    });
    await this.log(snapshot.status === 'ambiguous' || snapshot.status === 'unavailable' ? 'warn' : 'info', 'conversation.commit_snapshot_frozen', 'Commit conversation snapshot was frozen.', {
      projectId,
      commitSha,
      component: 'commit-conversation-binder',
      phase: 'snapshot-frozen',
      context: {
        snapshotHash: snapshot.snapshotHash,
        status: snapshot.status,
        turnCount: snapshot.turns.length,
        userEventCount: snapshot.turns.reduce((total, turn) => total + turn.userEvents.length, 0),
        assistantEventCount: snapshot.turns.reduce((total, turn) => total + turn.assistantEvents.length, 0),
        decision,
      },
    });
    return snapshot;
  }
}

function snapshotRequirementRecords(snapshot) {
  return snapshot.turns.flatMap(turn => turn.userEvents.map(event => ({
    id: event.eventId,
    client: turn.source,
    sessionId: turn.sessionId,
    ts: event.capturedAt,
    requirement: event.content,
    requirementHash: event.contentHash,
    turnId: turn.turnId,
    bindingKind: turn.bindingKind,
  })));
}

module.exports = { CommitConversationBinder, snapshotRequirementRecords, projectEvent, sha256 };
