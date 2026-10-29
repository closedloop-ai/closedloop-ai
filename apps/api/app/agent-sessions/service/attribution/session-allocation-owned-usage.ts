/**
 * ISS-12552 (AC-020, PRD-800 "Proving usage"): the token events of
 * a session that another session of the same owner holds.
 *
 * Copies: records with the same owner, harness and external session id are
 * one session synced from several compute targets, never a lineage. They are
 * matched by external event id, which the Desktop derives from the
 * transcript's session id and the event's content, so it is the same from
 * every machine whatever identity the event carries or lacks. Every id both
 * copies hold belongs to the copy whose compute target id sorts first; an id
 * only one copy holds stays with that copy. Copies never tie and are never
 * ordered by time.
 *
 * Forks: a headless Claude fork copies its parent's transcript entries, uuids
 * included; a Desktop from before DATA REVISION 113 syncs that copied usage as
 * the fork's own. A fork is a different session, so its event ids differ, and
 * it is matched by Claude entry uuid instead, among the owner's sessions. The
 * session that started strictly earlier owns a shared usage. Such a Desktop
 * dates the fork from its earliest copied entry, so a fork can start at the
 * same instant as its parent; nothing synced says which one is the copy, so an
 * exact tie is returned as ambiguous rather than settled by the order the two
 * synced.
 */
import { withDb } from "@repo/database";
import {
  crossSessionSourceKey,
  sessionCopySourceKey,
} from "@repo/lib/attribution/allocation-inputs";
import { readInIdChunks } from "@/lib/session-pr-links-chunking";

export type UsageOwnedElsewhere = {
  /** Usage an earlier fork parent, or a canonical copy, of the same owner holds. */
  owned: Set<string>;
  /** Usage a fork of the same owner that started at the same instant holds. */
  ambiguous: Set<string>;
};

type OwnedUsageEvent = { sourceIdentity: unknown; externalEventId: string };

export async function readUsageOwnedElsewhere(
  session: { organizationId: string; agentSessionId: string },
  events: readonly OwnedUsageEvent[]
): Promise<UsageOwnedElsewhere> {
  const identities = new Set<string>();
  for (const event of events) {
    if (crossSessionSourceKey(event.sourceIdentity) !== null) {
      identities.add(JSON.stringify(event.sourceIdentity));
    }
  }
  // Sequential, not concurrent: each read fans out over id chunks on its own.
  const copied = await readInIdChunks(
    events.map((event) => event.externalEventId),
    (chunk) => readCanonicalCopyEventIds(session, chunk)
  );
  const forked = await readInIdChunks([...identities], (chunk) =>
    readForkRows(session, chunk)
  );
  const owned = new Set(copied.map((row) => sessionCopySourceKey(row)));
  const tied = new Set<string>();
  for (const row of forked) {
    const key = crossSessionSourceKey(row.sourceIdentity);
    if (key === null) {
      continue;
    }
    (row.earlier ? owned : tied).add(key);
  }
  return {
    owned,
    ambiguous: new Set([...tied].filter((key) => !owned.has(key))),
  };
}

/** The event ids a canonical copy of this session (a lower compute target) holds. */
function readCanonicalCopyEventIds(
  session: { organizationId: string; agentSessionId: string },
  eventIds: readonly string[]
): Promise<{ externalEventId: string }[]> {
  return withDb(
    (db) => db.$queryRaw<{ externalEventId: string }[]>`
      SELECT DISTINCT other.external_event_id AS "externalEventId"
      FROM agent_session_token_events AS other
      JOIN session_detail AS other_session
        ON other_session.artifact_id = other.agent_session_id
      JOIN artifacts AS other_artifact
        ON other_artifact.id = other.agent_session_id
      JOIN session_detail AS own
        ON own.artifact_id = ${session.agentSessionId}::uuid
      JOIN artifacts AS own_artifact
        ON own_artifact.id = own.artifact_id
      WHERE other.external_event_id = ANY(${eventIds}::text[])
        AND other.agent_session_id <> own.artifact_id
        AND other_artifact.organization_id = ${session.organizationId}::uuid
        AND own_artifact.organization_id = ${session.organizationId}::uuid
        -- A NULL owner matches nothing, so a session with no owner has no copy.
        AND other_artifact.created_by_id = own_artifact.created_by_id
        AND other_session.harness = own.harness
        AND other_session.external_session_id = own.external_session_id
        AND other_session.compute_target_id < own.compute_target_id
    `
  );
}

/** Another of the owner's sessions, not a copy, holding the same Claude entry. */
function readForkRows(
  session: { organizationId: string; agentSessionId: string },
  identities: readonly string[]
): Promise<{ sourceIdentity: unknown; earlier: boolean }[]> {
  return withDb(
    (db) => db.$queryRaw<{ sourceIdentity: unknown; earlier: boolean }[]>`
      SELECT DISTINCT other.source_identity AS "sourceIdentity",
        other_session.session_started_at < own.session_started_at AS earlier
      FROM agent_session_token_events AS other
      JOIN session_detail AS other_session
        ON other_session.artifact_id = other.agent_session_id
      JOIN artifacts AS other_artifact
        ON other_artifact.id = other.agent_session_id
      JOIN session_detail AS own
        ON own.artifact_id = ${session.agentSessionId}::uuid
      JOIN artifacts AS own_artifact
        ON own_artifact.id = own.artifact_id
      WHERE other.source_identity = ANY(${identities}::jsonb[])
        AND other.agent_session_id <> own.artifact_id
        AND other_artifact.organization_id = ${session.organizationId}::uuid
        AND own_artifact.organization_id = ${session.organizationId}::uuid
        -- A NULL owner matches nothing here, so a session with no owner is
        -- never deduped: no owner proves no fork pair, and the dedupe is
        -- owner-scoped (PRD-800, ISS-12744).
        AND other_artifact.created_by_id = own_artifact.created_by_id
        AND NOT (
          other_session.harness = own.harness
          AND other_session.external_session_id = own.external_session_id
        )
        AND other_session.session_started_at <= own.session_started_at
    `
  );
}
