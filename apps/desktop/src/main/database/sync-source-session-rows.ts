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
import { prepareAgentSessionPayload } from "../agent-sync/agent-session-sync-payload.js";
import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";
import { resolveBillingModeForRow } from "../agent-sync/agent-session-token-cost-resolution.js";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import { localTimeZone } from "./db-helpers.js";
import type { SqliteSessionRow } from "./db-row-types.js";
import { priorityColumnSql } from "./priority-upload-marker.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
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
  reader: DesktopPrismaReader,
  ids: string[],
  options?: SessionRowSelectOptions
): Promise<SqliteSessionRow[]> {
  const metadataColumn = options?.omitMetadata
    ? "NULL"
    : sessionMetadataSelectExpression(
        options?.omitPreviewStrippedMetadata === true
      );
  return selectRowsByIds<SqliteSessionRow>(
    reader,
    `
      SELECT
        id,
        name,
        name_override,
        ${priorityColumnSql(null, options?.priorityProjection)} AS priority,
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
        -- ISS-7229: Claude's own reported total, rolled up from the OTel capture
        -- table. Projected here so the sync payload can carry it; NULL for a
        -- session with no captured cost events.
        authoritative_cost_usd,
        cost_currency,
        cost_source,
        data_revision,
        created_at
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
 * The verdict must mirror what the real sync path ships, so it is
 * `prepareAgentSessionPayload`'s own — it compacts metadata (trimming
 * `messages`, dropping `tokenSeries`), degrades an oversized blob (ISS-7997),
 * and only then reports `dead-letter`. Sizing the *raw* row instead over-states
 * the payload by everything compaction and degradation would have removed,
 * which dead-letters sessions that sync fine — for a metadata-heavy session,
 * raw metadata is the dominant term and what actually ships is a small
 * fraction of it.
 */
export async function findSqliteLocallyOversizedSessions(
  prisma: DesktopPrisma,
  ids: string[],
  maxBytes: number
): Promise<{ id: string; payloadBytes: number }[]> {
  if (ids.length === 0) {
    return [];
  }

  // ISS-6119: the probe's ONLY consumer is the `prepareAgentSessionPayload`
  // call below, whose sanitize step drops every `OMITTED_METADATA_KEYS` member
  // before any size is taken — so reading them is pure waste on the exact
  // argument that justifies the sync drain's opt-in, and the verdict is
  // unchanged either way.
  const sessionRows = await prisma.read((reader) =>
    selectSessionRows(reader, ids, { omitPreviewStrippedMetadata: true })
  );
  const sessionsById = new Map(sessionRows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = sessionsById.get(id);
    if (!row) {
      return [];
    }
    // ISS-7997: the PRODUCER'S OWN predicate, not a byte comparison re-derived
    // here. `prepareAgentSessionPayload` degrades an oversized `metadata` blob
    // and ships the session, so "these bytes exceed the cap" is no longer proof
    // of anything, and a probe still asserting it would dead-letter — before
    // hydration, before any send — exactly the sessions the degrade rescues.
    //
    // ISS-7775: the preparer defaults to the narrowest policy it can emit
    // (`MetadataContentPolicy.Omit`), a strict subset of `Retain`, so this stays
    // a true lower bound at every data-sync level without threading the level
    // through the db-host op boundary.
    //
    // ISS-9864: one term runs the other way. The minimal session carries no
    // `tokenEvents`, so the producer derives `metadata.agentTurnTimestamps`
    // here even for a round-trip session the real drain omits it on — up to
    // ~40 KB the shipped payload will not carry. Verdict-neutral: the ISS-7997
    // degrade sheds appended keys first, so an extra one can only be shed, and
    // the probe measures the same blob the human key already inflates.
    const prepared = prepareAgentSessionPayload(
      buildMinimalSyncSession(row),
      maxBytes
    );
    return prepared.kind === "dead-letter"
      ? [{ id, payloadBytes: prepared.payloadBytes }]
      : [];
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

/**
 * The scalar head of a synced session — the `sessions`-row fields that carry no
 * relation and no coercion. Shared by the no-relations probe below and by
 * `sync-source.ts`'s full hydration, which must project the row identically or
 * the size estimate stops describing the payload it gates.
 *
 * ISS-8717: `nameOverride` is the OWNER's rename, distinct from the collector's
 * `name`, and is emitted only when the local row holds one. The cloud reads an
 * absent field as "this payload makes no claim about the name" and preserves a
 * rename made on the web, so the omission is the compatibility contract rather
 * than a size optimization.
 *
 * ISS-10332: `priority` is a member or `null`, as the local list serves it.
 * The `null` never reaches the wire: `sanitizeSessionForSync` drops it, so the
 * cloud reads "no claim", the same contract as `nameOverride`. An upload load
 * reads a value the cloud already has as `null` (`selectSessionRows`).
 *
 * ISS-12251: `createdAt` is emitted only when the row holds one, never as
 * `null`. Every load reads it, so the local reads, the sync drain and the
 * oversize probe all carry it.
 */
export function toSyncedSessionHead(
  row: SqliteSessionRow
): Pick<
  SyncedAgentSession,
  | "createdAt"
  | "externalSessionId"
  | "name"
  | "nameOverride"
  | "priority"
  | "status"
> {
  return {
    externalSessionId: row.id,
    name: row.name,
    ...(row.name_override ? { nameOverride: row.name_override } : {}),
    priority: row.priority,
    status: row.status,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

/** The no-relations projection the payload-size probe measures. */
function buildMinimalSyncSession(row: SqliteSessionRow): SyncedAgentSession {
  const metadata = parseJsonObjectText(row.metadata);
  return {
    ...toSyncedSessionHead(row),
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

type SessionRowSelectOptions = Pick<
  SyncedSessionLoadOptions,
  "omitPreviewStrippedMetadata" | "priorityProjection"
> & {
  /**
   * Return a null metadata placeholder when the caller has another exact source
   * for every metadata-derived value it exposes.
   */
  omitMetadata?: boolean;
};
