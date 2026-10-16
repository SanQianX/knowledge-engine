'use strict';

// Hard provenance gate for automatic long-term memory admission. The
// maintenance model owns the semantic judgment (its prompt contract demands
// durable, cross-project owner preferences); this gate never re-classifies
// text and never trusts model self-reports over the frozen snapshot of the
// claim being captured.
const SHARED_SCOPES = new Set(['domain', 'global']);

function indexUserEvents(snapshot) {
  const events = new Map();
  for (const turn of snapshot?.turns || []) {
    for (const event of turn.userEvents || []) {
      if (event?.eventId) events.set(String(event.eventId), event);
    }
  }
  return events;
}

function conversationReferences(run) {
  const references = new Set();
  for (const operation of run?.staging?.operations || []) {
    for (const reference of operation.evidenceReferences || []) {
      if (typeof reference === 'string' && reference.startsWith('conversation:')) references.add(reference.slice('conversation:'.length));
    }
  }
  return references;
}

class MemoryEligibility {
  constructor(options = {}) {
    this.readSnapshot = typeof options.readSnapshot === 'function' ? options.readSnapshot : null;
  }

  // The snapshot must exist AND be bound to this run's promoted operations
  // through a `conversation:<snapshotHash>` evidence reference, so a foreign
  // or later-frozen conversation can never vouch for this claim.
  resolve(run) {
    if (!this.readSnapshot) return null;
    const references = conversationReferences(run);
    if (!references.size) return null;
    let snapshot = null;
    try { snapshot = this.readSnapshot(run.projectId, run.commitSha); } catch { return null; }
    return snapshot && references.has(snapshot.snapshotHash) ? snapshot : null;
  }

  verify(candidate, snapshot, project) {
    if (!snapshot) return { ok: false, code: 'SNAPSHOT_UNAVAILABLE' };
    const sourceEventId = String(candidate.sourceEventId || '');
    if (!sourceEventId) return { ok: false, code: 'SOURCE_EVENT_MISSING' };
    const event = indexUserEvents(snapshot).get(sourceEventId);
    if (!event) return { ok: false, code: 'SOURCE_EVENT_NOT_FOUND' };
    if ((event.inputOrigin || 'unknown') !== 'human') return { ok: false, code: 'SOURCE_NOT_HUMAN' };
    if (String(candidate.sourceHash || '') !== String(event.contentHash || '')) return { ok: false, code: 'SOURCE_HASH_MISMATCH' };
    if (!String(event.content || '').includes(String(candidate.quote || '').trim())) return { ok: false, code: 'QUOTE_NOT_IN_SOURCE' };
    if (!String(candidate.quote || '').includes(String(candidate.text || '').trim())) return { ok: false, code: 'TEXT_NOT_IN_QUOTE' };
    const eligibility = candidate.eligibility;
    if (!eligibility || typeof eligibility !== 'object' || Array.isArray(eligibility)) return { ok: false, code: 'ELIGIBILITY_MISSING' };
    if (eligibility.durable !== true) return { ok: false, code: 'ELIGIBILITY_NOT_DURABLE' };
    if (eligibility.crossProject !== true) return { ok: false, code: 'ELIGIBILITY_NOT_CROSS_PROJECT' };
    if (!String(eligibility.reason || '').trim()) return { ok: false, code: 'ELIGIBILITY_REASON_MISSING' };
    if (!String(eligibility.scopeReason || '').trim()) return { ok: false, code: 'ELIGIBILITY_SCOPE_REASON_MISSING' };
    if (!SHARED_SCOPES.has(candidate.scopeType)) return { ok: false, code: 'SCOPE_NOT_SHARED' };
    if (candidate.scopeType === 'domain' && !project.domainId) return { ok: false, code: 'SCOPE_DOMAIN_UNBOUND' };
    return {
      ok: true,
      sourceEventId,
      sourceHash: String(event.contentHash),
      eligibility: { durable: true, crossProject: true, reason: String(eligibility.reason).trim(), scopeReason: String(eligibility.scopeReason).trim() },
    };
  }
}

module.exports = { MemoryEligibility };
