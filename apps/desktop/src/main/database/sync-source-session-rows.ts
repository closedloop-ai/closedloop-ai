/**
 * @file sync-source-session-rows.ts
 * @description The reads and projections that touch the `sessions` table ALONE —
 * no relations, no assembly. The base-row `SELECT` the hydration loads start
 * from, the minimal no-relations projection, the two pre-hydration probes the
 * sync lane runs before it commits to (or gives up on) a candidate, and the
 * `ends_with_error` flag coercion they share.
 *
 * Split out of `sync-source.ts` (a grandfathered over-ceiling module) by
 * ISS-6031, the same carve-out `sync-source-bounded-reads.ts` got for the
 * bounded per-session reads. The seam is real: these answer questions about a
 * session ROW, while the loader assembles a session from a dozen tables.
 *
 * ISS-6031 added `findSqliteExistingSessionIds`, and it is the reason the seam
 * matters. An empty `loadSyncedSessions` result proves a read returned nothing,
 * not that the rows were deleted — conflating those two permanently
 * dead-lettered five present sessions on every cycle of the sync-reliability
 * soak. So the presence probe touches `sessions` and nothing else, deliberately
 * carrying no hydratability or substantive-content predicate: a row that is
 * present but momentarily unreadable MUST come back as present so the caller
 * retries instead of disposing.
 */
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  estimateSessionPayloadBytes,
  sanitizeSessionForSync,
} from "../agent-sync/agent-session-sync-payload.js";
import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";
import { resolveBillingModeForRow } from "../agent-sync/agent-session-token-cost-resolution.js";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import { localTimeZone } from "./db-helpers.js";
import type { SqliteSessionRow } from "./db-row-types.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";
import { sessionMetadataSelectExpression } from "./session-metadata-projection.js";

/**
 * The base session row set both the full and usage loads need.
 *
 * ISS-6119: `omitPreviewStrippedMetadata` narrows the `metadata` column to the
 * keys the caller can actually observe — see
 * {@link sessionMetadataSelectExpression} for why that cannot change a result
 * and which callers are allowed to set it.
 */
export function selectSessionRows(
  reader: DesktopPrismaReadClient,
  ids: string[],
  options?: Pick<SyncedSessionLoadOptions, "omitPreviewStrippedMetadata">
): Promise<SqliteSessionRow[]> {
  const metadataColumn = sessionMetadataSelectExpression(
    options?.omitPreviewStrippedMetadata === true
  );
  return selectRowsByIds<SqliteSessionRow>(
    reader,
    `
      SELECT
        id,
        name,
        status,
        cwd,
        repo_full_name,
        model,
        started_at,
        updated_at,
        last_activity_at,
        ended_at,
        awaiting_input_since,
        ends_with_error,
        ${metadataColumn} AS metadata,
        harness,
        billing_mode,
        user_id,
        organization_id,
        cost_usd_estimated,
        cost_currency,
        cost_source,
        data_revision
      FROM sessions
      WHERE id IN (__IDS__)
    `,
    ids
  );
}

/**
 * ISS-6031: the subset of `ids` that still has a row in `sessions`, in no
 * particular order.
 *
 * The narrowest read in this file, and the ONLY sanctioned way for the sync lane
 * to conclude that a queued session is gone. Chunked against the
 * bound-parameter cap so a caller that ever probes a corpus-sized list cannot
 * overflow the statement — that failure would turn the probe into a throw, and a
 * throw here is read as "not verified", which costs a retry rather than a
 * deletion.
 */
export async function findSqliteExistingSessionIds(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const present: string[] = [];
  for (let start = 0; start < ids.length; start += EVENT_INSERT_PARAM_CAP) {
    const chunk = ids.slice(start, start + EVENT_INSERT_PARAM_CAP);
    const rows = await prisma.read((reader) =>
      selectRowsByIds<{ id: string }>(
        reader,
        "SELECT id FROM sessions WHERE id IN (__IDS__)",
        chunk
      )
    );
    for (const row of rows) {
      present.push(row.id);
    }
  }
  return present;
}

/**
 * Prove locally that a session cannot fit in the existing sync payload cap using
 * only the base session row. This is intentionally a lower-bound check: when the
 * minimal no-events/no-relations object is already oversized, the full hydrate
 * path would also dead-letter after loading far more data. Borderline sessions
 * are omitted so they still take the exact full hydrate path.
 *
 * The measurement must mirror what the real sync path ships, so the row is
 * sanitized before it is sized: `prepareAgentSessionPayload` compacts metadata
 * (trimming `messages`, dropping `tokenSeries`) and the chunker's own
 * can't-fit test is likewise `estimateSessionPayloadBytes(sanitized base)`.
 * Sizing the *raw* row instead over-states the payload by everything compaction
 * would have removed, which dead-letters sessions that sync fine — for a
 * metadata-heavy session, raw metadata is the dominant term and compacted
 * metadata is a small fraction of it.
 */
export async function findSqliteLocallyOversizedSessions(
  prisma: DesktopPrisma,
  ids: string[],
  maxBytes: number
): Promise<{ id: string; payloadBytes: number }[]> {
  if (ids.length === 0) {
    return [];
  }

  // ISS-6119: the probe's ONLY consumer is the `sanitizeSessionForSync` +
  // `estimateSessionPayloadBytes` pair below, and the sanitize step drops every
  // `OMITTED_METADATA_KEYS` member before the size is taken — so reading them is
  // pure waste on the exact argument that justifies the sync drain's opt-in, and
  // the byte estimate is unchanged either way.
  const sessionRows = await prisma.read((reader) =>
    selectSessionRows(reader, ids, { omitPreviewStrippedMetadata: true })
  );
  const sessionsById = new Map(sessionRows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = sessionsById.get(id);
    if (!row) {
      return [];
    }
    const payloadBytes = estimateSessionPayloadBytes(
      sanitizeSessionForSync(buildMinimalSyncSession(row))
    );
    return payloadBytes > maxBytes ? [{ id, payloadBytes }] : [];
  });
}

/**
 * ISS-4586: coerce the SQLite `ends_with_error` boolean column (stored as
 * `1`/`0`/`NULL`) to the `boolean | null` the cloud sync contract carries. NULL
 * (not yet classified — a legacy pre-column row) stays `null` so the cloud
 * treats it as not-error rather than fabricating `false`.
 */
export function sqliteFlagToNullableBoolean(
  value: number | null
): boolean | null {
  return value == null ? null : value === 1;
}

/** The no-relations projection the payload-size probe measures. */
function buildMinimalSyncSession(row: SqliteSessionRow): SyncedAgentSession {
  const metadata = parseJsonObjectText(row.metadata);
  return {
    externalSessionId: row.id,
    name: row.name,
    status: row.status,
    harness: row.harness,
    billingMode: resolveBillingModeForRow(row),
    cwd: row.cwd,
    model: row.model,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    awaitingInputSince: row.awaiting_input_since,
    endsWithError: sqliteFlagToNullableBoolean(row.ends_with_error),
    metadata,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    deviceTimeZone: localTimeZone(),
    dataRevision: row.data_revision,
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}
