/**
 * Activity-segment wire mapping for sync-source hydration.
 *
 * ISS-5801: extracted from `sync-source.ts` (a shrink-only grandfathered file)
 * into its own leaf module — deliberately NOT in `sync-source-usage-rows.ts`,
 * whose stated scope is token-usage/invocation-count reads; `sync-source.ts`
 * imports FROM here, never the other way round.
 */
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { normalizeActivitySegmentEvidenceLayers } from "@repo/api/src/types/agent-session-activity-evidence";
import {
  ACTIVITY_SEGMENT_ABSOLUTE_CEILING,
  ACTIVITY_SEGMENT_PAGE_SIZE,
  ACTIVITY_SEGMENT_SYNC_MAX_ROWS,
  type SyncedSegmentQueryRow,
} from "./sync-source-bounded-reads.js";

/** Map one persisted activity-segment row to its additive sync shape. */
export function mapSyncedActivitySegment(
  segment: SyncedSegmentQueryRow
): SyncedActivitySegmentRow {
  return {
    phase: segment.phase,
    startMs: Number(segment.startMs),
    endMs: Number(segment.endMs),
    confidence: segment.confidence,
    evidenceLayers: normalizeActivitySegmentEvidenceLayers(
      segment.evidenceLayers
    ),
    version: segment.version,
    workItemRef: segment.workItemRef,
    subagentId: segment.subagentId,
  };
}

/**
 * ISS-9865: the tiling fields ONE assembled session contributes to its sync
 * payload, and the diagnostic that explains them.
 *
 * `activitySegmentRowsStripped` is the load-bearing half. Absent, a refused
 * tiling is byte-identical on the wire to a session that never had one, so the
 * accepted ack SETTLES the session as a complete sync and clears the outbox with
 * the tiling permanently gone and no record it was ever owed. Present, the same
 * delivery enters `tilingStrippedSessionIds` and the ack records the ISS-7265
 * durable repair debt instead (davetho P1, PR #7099).
 */
export type SyncedSessionTiling = {
  /** Omitted entirely when there is nothing to send — never `[]`, never a prefix. */
  activitySegmentRows?: SyncedActivitySegmentRow[];
  /** Set only on a REFUSAL; a session with no tiling states nothing. */
  activitySegmentRowsStripped?: true;
};

/**
 * ISS-4541 / ISS-9865: decide what one session's activity tiling contributes to
 * its sync payload.
 *
 * A tiling within the paging threshold, and one above it that the keyset pager
 * read whole, ship IN FULL — the chunker paginates them across sync parts, so
 * the transport byte cap is not a data cap. A tiling the read REFUSED at
 * {@link ACTIVITY_SEGMENT_ABSOLUTE_CEILING} ships as a stripped, owed delivery.
 *
 * The refusal arrives as a FACT from the read rather than being re-derived from
 * the row count here, because a refused session and a session with no tiling
 * both present zero rows.
 */
export function resolveSyncedSessionTiling(input: {
  sessionId: string;
  segments: SyncedSegmentQueryRow[];
  refused: boolean;
  log?: (message: string) => void;
}): SyncedSessionTiling {
  if (input.refused) {
    input.log?.(
      `sync-source: session ${input.sessionId} activity tiling is past the absolute ceiling (${ACTIVITY_SEGMENT_ABSOLUTE_CEILING} rows); the read refused it — shipping the session tiling-STRIPPED and recording the repair debt`
    );
    return { activitySegmentRowsStripped: true };
  }
  const activitySegmentRows = input.segments.map(mapSyncedActivitySegment);
  if (activitySegmentRows.length > ACTIVITY_SEGMENT_SYNC_MAX_ROWS) {
    const chunks = Math.ceil(
      activitySegmentRows.length / ACTIVITY_SEGMENT_PAGE_SIZE
    );
    input.log?.(
      `sync-source: session ${input.sessionId} activity tiling exceeds the paging threshold (${activitySegmentRows.length} rows); paged across ${chunks} sync chunks`
    );
  }
  if (activitySegmentRows.length === 0) {
    return {};
  }
  return { activitySegmentRows };
}

/**
 * Group loaded segment rows by session id.
 *
 * Its own helper rather than the shared `groupRowsBySessionId`: the Prisma read
 * delegate returns camelCase `sessionId`, and that helper keys on the raw
 * snake_case `session_id` every other row shape in the hydration carries.
 */
export function groupSegmentsBySessionId(
  segmentRows: SyncedSegmentQueryRow[]
): Map<string, SyncedSegmentQueryRow[]> {
  const bySessionId = new Map<string, SyncedSegmentQueryRow[]>();
  for (const segment of segmentRows) {
    const existing = bySessionId.get(segment.sessionId);
    if (existing) {
      existing.push(segment);
    } else {
      bySessionId.set(segment.sessionId, [segment]);
    }
  }
  return bySessionId;
}
