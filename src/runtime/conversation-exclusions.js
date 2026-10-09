const fs = require('fs');
const path = require('path');
const { validateProjectId } = require('./contracts');
const AtomicFile = require('./atomic-file');

const EXCLUSION_SCHEMA = 'conversation-exclusions/v1';
const EMBEDDED_ASSISTANT_PREFIX = 'embedded-assistant-';
const EXPLICIT_PREFIX = 'explicit-';
const CODEX_CONTEXT_TAGS = new Set([
  'recommended_plugins',
  'environment_context',
  'in-app-browser-context',
]);

/**
 * T17: legacy embedded Workbench capture exclusion.
 *
 * Old builds wrote internal Workbench conversations into Development
 * Conversation as `explicit-<requirementId>` + `embedded-assistant-<requirementId>`
 * pairs (rawEventType embedded-claude-result). Those events are excluded from
 * Development Conversation presentation and from NEW commit binding. Nothing
 * is deleted: the JSONL lines stay, immutable snapshots stay untouched, and a
 * manifest is persisted for auditability. A genuine explicit MCP requirement
 * (no embedded-assistant pair) is never excluded.
 */
function isEmbeddedAssistantEvent(event) {
  if (!event) return false;
  return String(event.eventId || '').startsWith(EMBEDDED_ASSISTANT_PREFIX)
    || event.rawEventType === 'embedded-claude-result';
}

/**
 * Codex rollout files contain generated context records with role=user. They
 * are transport/control data, not user-authored prompts. Match only complete,
 * known envelopes so ordinary prompts containing similar text survive.
 */
function isCodexControlUserEvent(event) {
  if (!event || event.source !== 'codex' || event.role !== 'user' || event.rawEventType !== 'response_item') return false;
  let remaining = String(event.content || '').trim();
  if (/^<turn_aborted>\s*[\s\S]*?\s*<\/turn_aborted>$/.test(remaining)) return true;

  let removed = false;
  const envelope = /^<([A-Za-z0-9_-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/;
  while (remaining) {
    const match = remaining.match(envelope);
    if (!match || !CODEX_CONTEXT_TAGS.has(match[1])) break;
    remaining = remaining.slice(match[0].length).trimStart();
    removed = true;
  }
  return removed && remaining.trim() === '';
}

function isCodexAbortEvent(event) {
  return isCodexControlUserEvent(event)
    && /^<turn_aborted>/.test(String(event.content || '').trim());
}

function computeConversationExclusions(projectId, events) {
  validateProjectId(projectId);
  const paired = new Set();
  for (const event of events || []) {
    const eventId = String((event && event.eventId) || '');
    if (eventId.startsWith(EMBEDDED_ASSISTANT_PREFIX)) {
      paired.add(eventId.slice(EMBEDDED_ASSISTANT_PREFIX.length));
    }
  }
  const excludedEventIds = [];
  for (const event of events || []) {
    if (!event) continue;
    const eventId = String(event.eventId || '');
    if (isEmbeddedAssistantEvent(event)) {
      excludedEventIds.push(eventId);
      continue;
    }
    if (isCodexControlUserEvent(event)) {
      excludedEventIds.push(eventId);
      continue;
    }
    if (eventId.startsWith(EXPLICIT_PREFIX) && paired.has(eventId.slice(EXPLICIT_PREFIX.length))) {
      excludedEventIds.push(eventId);
    }
  }
  return {
    schema: EXCLUSION_SCHEMA,
    projectId,
    excludedEventIds: [...new Set(excludedEventIds)].sort(),
    generatedAt: new Date().toISOString(),
  };
}

function eventOrder(left, right) {
  if (Number.isInteger(left.sequence) && Number.isInteger(right.sequence)) return left.sequence - right.sequence;
  if (Number.isInteger(left.sequence)) return -1;
  if (Number.isInteger(right.sequence)) return 1;
  return String(left.capturedAt || '').localeCompare(String(right.capturedAt || ''))
    || String(left.eventId || '').localeCompare(String(right.eventId || ''));
}

/**
 * Bridge 0.1.1 did not read Codex's nested turn id, so historical assistant
 * response_item records have turnId=null while each user record received a
 * generated id. Repair that projection without rewriting the append-only
 * JSONL: orphan assistants attach to the latest real user in the same Codex
 * session. A later real prompt or turn_aborted record closes that projected
 * turn, which also lets commit binding ignore stale Bridge open-turn facts.
 */
function projectCodexTurns(events, excludedEventIds) {
  const excluded = new Set(excludedEventIds || []);
  const activeBySession = new Map();
  const closedAtByTurn = new Map();
  const projected = [];
  const ordered = [...(events || [])].sort(eventOrder);
  const sessionKey = event => event && event.source === 'codex' && event.sessionId
    ? `codex\n${event.sessionId}`
    : null;

  for (const original of ordered) {
    const eventId = String((original && original.eventId) || '');
    const key = sessionKey(original || {});
    if (excluded.has(eventId)) {
      if (key && isCodexAbortEvent(original)) {
        const active = activeBySession.get(key);
        if (active && Number.isInteger(original.sequence)) closedAtByTurn.set(active, original.sequence);
        activeBySession.delete(key);
      }
      continue;
    }

    let event = original;
    if (key && original && original.source === 'codex' && original.role === 'user' && original.turnId) {
      const previous = activeBySession.get(key);
      if (previous && previous !== original.turnId && Number.isInteger(original.sequence)) {
        closedAtByTurn.set(previous, original.sequence);
      }
      activeBySession.set(key, original.turnId);
    } else if (key && original && original.source === 'codex' && original.role === 'assistant' && !original.turnId) {
      const active = activeBySession.get(key);
      if (active) event = { ...original, turnId: active };
    }
    projected.push(event);
  }

  return projected.map(event => {
    const closedAt = event && event.turnId ? closedAtByTurn.get(event.turnId) : null;
    return Number.isInteger(closedAt)
      ? { ...event, developmentTurnClosedAtSequence: closedAt }
      : event;
  });
}

function manifestPath(layout, projectId) {
  return path.join(layout.getProjectMetadataDir(projectId), 'conversation-exclusions.json');
}

function readManifest(layout, projectId) {
  try {
    return AtomicFile.readJsonStrict(manifestPath(layout, projectId), {
      category: 'conversation-exclusions',
      validate: value => value,
    });
  } catch {
    return null;
  }
}

/**
 * Single source of truth for Development Conversation reads: applies durable
 * exclusions and the non-destructive Codex turn compatibility projection for
 * both Conversation Explorer and new CommitConversationBinder runs. The
 * manifest is refreshed idempotently (best effort) so operators can audit
 * what is excluded; read failures never break the read itself.
 */
function readDevelopmentEvents(conversationStore, projectId) {
  const events = conversationStore.readEvents(projectId);
  const manifest = computeConversationExclusions(projectId, events);
  if (manifest.excludedEventIds.length) {
    try {
      const layout = conversationStore.layout;
      const dir = layout.getProjectMetadataDir(projectId);
      fs.mkdirSync(dir, { recursive: true });
      const previous = readManifest(layout, projectId);
      const unchanged = previous
        && Array.isArray(previous.excludedEventIds)
        && previous.excludedEventIds.length === manifest.excludedEventIds.length
        && previous.excludedEventIds.every((id, index) => id === manifest.excludedEventIds[index]);
      if (!unchanged) {
        (conversationStore.atomic || AtomicFile).writeJsonAtomic(manifestPath(layout, projectId), manifest);
      }
    } catch {
      // Manifest persistence is best effort; exclusion itself is computed
      // deterministically from the durable events on every read.
    }
  }
  return projectCodexTurns(events, manifest.excludedEventIds);
}

module.exports = {
  EXCLUSION_SCHEMA,
  isEmbeddedAssistantEvent,
  isCodexControlUserEvent,
  computeConversationExclusions,
  projectCodexTurns,
  readDevelopmentEvents,
};
