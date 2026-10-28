/**
 * @file sync-burndown-store.ts
 * @description The AGGREGATE, read-only reads behind the desktop→cloud sync
 * burn-down (ISS-5387). One grouped query per store, sampled on a slow timer —
 * never a per-item read, and never anything on a lane's hot path.
 *
 * ## Cost, stated explicitly
 *
 * The ticket requires this to be bounded, so here is exactly what each read
 * costs on a live install:
 *
 *  - **Session outbox** — `GROUP BY status` under one `source_key`, served by
 *    `idx_agent_session_sync_outbox_ready` (`source_key, status, next_attempt_at`).
 *    The outbox holds only un-acked rows; it was empty on the measured install.
 *  - **Invocation outbox** — the same grouped shape under the DELIVERY key only
 *    (see below). `SUM(LENGTH(payload))` touches the payload column, so it is
 *    scoped to `pending` rows under that one key — 18 rows on the measured
 *    install, not the 3,508 in the table.
 *  - **Invocation template probe** — the lane's own pending-template predicate,
 *    keyset-paged under `LIMIT 200`. ISS-8768: it also runs on the
 *    null-delivery-key path, but only for a machine that has NEVER promoted
 *    (one extra `LIMIT 1` existence probe decides that), where this function used
 *    to return a static zero object for free. That branch is no longer free, and
 *    the cost is deliberate: an unpaired machine owes its whole template backlog,
 *    and reporting it as `0` is what hid three weeks of undelivered work. A
 *    paired-but-offline machine still short-circuits after the existence probe.
 *  - **Transcript ledger** — counts come from `GROUP BY status`, served by
 *    `idx_transcript_sync_state_status_next`. The byte sum is restricted to the
 *    THREE in-flight statuses, so it never scans the 8,819 settled `idle` rows:
 *    a settled row owes zero bytes by definition, so including it would add
 *    nothing but cost.
 *  - **Transcript stranded-idle** — a `count` under the lane's own stranded
 *    predicate, so the burn-down and `requeueStrandedMissingBlobs` cannot
 *    disagree about which archives the CURRENT target is still owed.
 *  - **Component inventory** — one `COUNT(*)` over `agent_components` past the
 *    lane's keyset. The `COALESCE(last_seen_at,'')` the lane's own predicate
 *    uses is non-sargable, so this scans a few-thousand-row local table once a
 *    minute. Accepted deliberately: the alternative was reporting `null`
 *    forever, and an unmeasured lane can never be shown as caught up.
 *  - **Cursors** — a primary-key `IN` lookup over `sync_state`, at most one row
 *    per lane.
 *
 * Every read runs on the READER pool (`prisma.read`), inside ONE read-scoped
 * `$transaction` so the whole sample comes from a single committed snapshot —
 * a sample whose pieces never coexisted is a fabricated reading. They never
 * queue behind the writer during a first-launch rebuild.
 *
 * ## The scoping trap this module exists to avoid
 *
 * Invocation depth is counted through {@link loadPendingInvocationTemplates},
 * the lane's OWN pending predicate, and by scoping every count to the
 * target-scoped delivery `source_key` — or, when no target has EVER been
 * negotiated, under the sentinel `NO_DELIVERY_TARGET_SOURCE_KEY`, which no row
 * can carry and so counts the whole template backlog as owed. That sentinel is
 * correct only for a never-promoted machine: it discards the already-delivered
 * half of the predicate, which a merely-offline machine still needs. Counting
 * `WHERE status = 'pending'` across the table reports the ~3.5k unscoped
 * TEMPLATE rows as a cloud backlog. They are never-attempted definitions the
 * lane clones from, not undelivered work. See
 * `invocation-sync-pending-templates.ts`.
 *
 * Nothing here reads payload BODIES, session titles, or file paths — only
 * counts, byte sizes, timestamps, and durable cursor positions.
 */

import { SyncLaneRemainderBasis } from "../../shared/sync-burndown-contract.js";
import {
  asOutboxStatus,
  OutboxStatus,
} from "../../shared/sync-lane-contract.js";
import {
  asTranscriptSyncStatus,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";
import { buildAgentComponentInvocationSyncSourceKey } from "../agent-sync/agent-component-invocation-sync-constants.js";
import { splitAgentSessionSyncSourceKey } from "../agent-sync/agent-session-sync-source.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import { componentCursorCanonicalRankSql } from "./component-cursor-rank.js";
import {
  loadPendingInvocationTemplates,
  NO_DELIVERY_TARGET_SOURCE_KEY,
} from "./invocation-sync-pending-templates.js";
import { PARKED_OUTBOX_KEY_SEGMENT } from "./outbox-environment-partition.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  isRealInstantSql,
} from "./session-timestamp-form.js";
import type { OutboxBurndownCounts } from "./sync-burndown-outbox-counts.js";
import {
  strandedCloudAckWhere,
  strandedCursorWhere,
} from "./transcript-sync-settle.js";

export type { OutboxBurndownCounts } from "./sync-burndown-outbox-counts.js";

/**
 * Ceiling on the template-migration probe. The predicate is a keyset-paged
 * SELECT, so it is read with a bound rather than an unbounded `COUNT` — a
 * burn-down must not become an O(N) scan to report that N is large. At the cap
 * the sample reports `pendingTemplateSessionsTruncated`, and the burn-down line
 * says `>= N` rather than pretending the number is exact.
 */
export const PENDING_TEMPLATE_PROBE_LIMIT = 200;

/**
 * ISS-5973: the ELIGIBLE-now half of an outbox status group, as SQL.
 *
 * Mirrors `readyOutboxWhere`'s deadline clause exactly — a row that has never
 * been deferred carries a null `next_attempt_at` and is ready — so the count
 * reported here and the set the lane actually drains cannot drift apart. `$2` is
 * the sample's own `now`, passed in rather than read from SQLite's clock so the
 * boundary is pinnable in a test.
 */
const READY_ROWS_SQL = `SUM(
              CASE WHEN next_attempt_at IS NULL OR next_attempt_at <= $2
                   THEN 1 ELSE 0 END
            )`;

// Writers generate canonical UTC pending_since stamps. Validate EVERY row before
// MIN: a malformed, lexically later stamp must not hide behind a valid sibling.
// Require a normalized round-trip too: calendar rollover changes lexical order.
// Missing/unreadable age leaves the complete pending population counted below.
function oldestCanonicalStampSql(column: string): string {
  return `CASE
  WHEN SUM(CASE
    WHEN ${column} GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
      AND ${isRealInstantSql(column)}
      AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
    THEN 0 ELSE 1 END) = 0
  THEN MIN(${column}) ELSE NULL END`;
}

const OLDEST_PENDING_SINCE_SQL = oldestCanonicalStampSql("pending_since");

/**
 * The transcript ledger statuses that still owe delivery. `idle` is settled and
 * `dead` is abandoned; neither is outstanding work, and only these three carry
 * unsent bytes.
 */
const TRANSCRIPT_IN_FLIGHT_STATUSES: readonly string[] = [
  TranscriptSyncStatus.Queued,
  TranscriptSyncStatus.Uploading,
  TranscriptSyncStatus.Failed,
];

/** Which `source_key`s to sample. A `null` means the lane has no identity yet. */
export type SyncBurndownQuery = {
  /** `agent_sessions:<computeTargetId>`. */
  sessionSourceKey: string | null;
  /** `agent_component_invocations:<computeTargetId>` — the DELIVERY key. */
  invocationSourceKey: string | null;
  /** The unscoped template key the invocation lane clones from. */
  invocationTemplateSourceKey: string;
  /** `agent_components:<revision>:<computeTargetId>`. */
  componentSourceKey: string | null;
  /**
   * The raw compute target the transcript lane settles against. Null offline —
   * the transcript ledger carries no `source_key`, so this is the only way to
   * tell "settled for THIS target" from "settled for a previous one".
   */
  transcriptComputeTargetId: string | null;
  /**
   * ISS-7096: the signed-in pair, so the invocation lane does not count template
   * sessions another identity owns, which promotion never sends. Null filters
   * nothing, matching promotion.
   */
  identity: SignedInUserIdentity | null;
  /**
   * ISS-5973: the sample's own instant, ISO-8601. The outbox reads compare each
   * row's `next_attempt_at` against it to separate deferred work from eligible
   * work, and taking it from the caller keeps that boundary pinnable in a test
   * instead of depending on SQLite's clock.
   */
  nowIso: string;
};

/**
 * ISS-7096: the session lane's counts also measure its PARKED partitions
 * (`<lanePrefix>:parked:<org>`) — another identity's rows, inert until their
 * own environment is active. NOT part of {@link OutboxBurndownCounts.pending}:
 * parked rows are not owed by this environment and must not hold the aggregate
 * open, but hiding them entirely would make a multi-environment device's
 * held-back history invisible. Session lane only — the invocation lane
 * RELEASES foreign delivery rows instead of parking them (they re-materialize
 * from the template under their owner's target).
 */
export type SessionOutboxBurndownCounts = OutboxBurndownCounts & {
  parkedPending: number;
};

/** Queue depth for the invocation lane, which is chunked and byte-sized. */
export type InvocationBurndownCounts = OutboxBurndownCounts & {
  /** Distinct sessions with parts already materialized under the delivery key. */
  pendingSessions: number;
  /** Pending outbox rows are PARTS, so this is chunks-remaining. */
  pendingParts: number;
  /** Wire bytes still queued under the delivery key. */
  pendingPayloadBytes: number;
  /**
   * Sessions the delivery queue has NOT yet materialized, counted with the
   * lane's own {@link loadPendingInvocationTemplates} predicate. Work the lane
   * still owes even when the delivery queue reads empty, so a lane is drained
   * only when this is zero too.
   */
  pendingTemplateSessions: number;
  /** True when the probe hit {@link PENDING_TEMPLATE_PROBE_LIMIT} — the count is a floor. */
  pendingTemplateSessionsTruncated: boolean;
};

/** Depth for the transcript archive ledger. */
export type TranscriptBurndownCounts = {
  inFlightFiles: number;
  /**
   * `idle` rows the CURRENT compute target is still owed — settled for a
   * previous target, or never delivered at all.
   *
   * `transcript_sync_state` has no per-target queue: settlement is recorded on
   * the row via `synced_compute_target_id` / `cloud_uploaded_compute_target_id`,
   * so after an account switch the archives the new target has never seen sit at
   * status `idle` until the 30-minute discovery sweep re-arms them
   * (`transcript-discovery-sweep.ts` → `requeueStrandedMissingBlobs`). Counting
   * by status alone folds those rows into neither in-flight nor dead, and the
   * lane reports `drained` for a target whose archives have not been sent.
   * Counted with the lane's OWN stranded predicate so the burn-down and the
   * requeue cannot disagree.
   */
  strandedIdleFiles: number;
  deadFiles: number;
  /** Sum of `last_size - synced_byte_offset` over in-flight rows, floored at 0. */
  bytesRemaining: number;
  /** `updated_at` of the oldest in-flight row — its last state change, not its discovery. */
  oldestInFlightUpdatedAtIso: string | null;
  /** Ledger rows whose `status` this build cannot classify (see {@link OutboxBurndownCounts.unmeasuredRows}). */
  unmeasuredRows: number;
};

export type DurableCursorRow = {
  sourceKey: string;
  observedTopUpdatedAt: string | null;
  updatedAt: string;
  dataRevision: number;
  /** The keyset's id half — `observed_ids_at_top_updated_at`, a JSON array. */
  observedIdsAtTopUpdatedAt: readonly string[];
  /** Ids the lane ABANDONED below the cursor — `dead_lettered_ids`, a JSON array. */
  deadLetteredIds: readonly string[];
};

/**
 * Depth for the component-inventory lane. A cursor sweep keeps no queue table,
 * but "how many rows sit past the cursor" is exactly as countable as a queue —
 * and counting it is the difference between a truthful burn-down and one that
 * prints `ALL LANES FULLY SYNCED` in the middle of a first backfill.
 */
export type ComponentInventoryBurndownCounts = {
  /**
   * Local `agent_components` rows the sweep has not reached yet, counted with
   * the lane's OWN keyset predicate. `null` when the lane has no identity (no
   * compute target), which is genuinely unknown rather than zero.
   */
  rowsRemaining: number | null;
  /** Ids the lane gave up on, from the durable `sync_state.dead_lettered_ids`. */
  deadLetteredCount: number;
  /** Whether the counts above were read at all (see {@link SyncLaneRemainderBasis}). */
  remainderBasis: SyncLaneRemainderBasis;
};

/** Everything one burn-down sample reads, in raw store terms. */
export type SyncBurndownStoreSample = {
  sessionOutbox: SessionOutboxBurndownCounts;
  invocationOutbox: InvocationBurndownCounts;
  transcript: TranscriptBurndownCounts;
  componentInventory: ComponentInventoryBurndownCounts;
  /** Keyed by `source_key`; absent when the lane has never persisted a cursor. */
  cursorsBySourceKey: Record<string, DurableCursorRow>;
};

/** The port method this module contributes to `AgentSessionSyncSource`. */
export type SyncBurndownReaders = {
  readSyncBurndown(query: SyncBurndownQuery): Promise<SyncBurndownStoreSample>;
};

type OutboxStatusGroupRow = {
  status: string;
  n: number | bigint;
  oldest: string | null;
  /** Rows in this status group whose backoff deadline has already elapsed. */
  ready: number | bigint | null;
};

type InvocationStatusGroupRow = OutboxStatusGroupRow & {
  bytes: number | bigint | null;
};

type TranscriptStatusGroupRow = {
  status: string;
  n: number | bigint;
  oldest: string | null;
};

type TranscriptBytesRow = { bytes: number | bigint | null };

type CountRow = { n: number | bigint };

type SyncStateRow = {
  source_key: string;
  observed_top_updated_at: string | null;
  observed_ids_at_top_updated_at: unknown;
  dead_lettered_ids: unknown;
  updated_at: string;
  data_revision: number | bigint;
};

const EMPTY_OUTBOX_COUNTS: OutboxBurndownCounts = {
  remainderBasis: SyncLaneRemainderBasis.Unqueried,
  pending: 0,
  readyPending: 0,
  deadLettered: 0,
  withheld: 0,
  oldestPendingSinceIso: null,
  unmeasuredRows: 0,
};

const EMPTY_INVOCATION_COUNTS: InvocationBurndownCounts = {
  ...EMPTY_OUTBOX_COUNTS,
  pendingSessions: 0,
  pendingParts: 0,
  pendingPayloadBytes: 0,
  pendingTemplateSessions: 0,
  pendingTemplateSessionsTruncated: false,
};

/**
 * Coerce a SQLite aggregate to a finite non-negative integer.
 *
 * `COUNT`/`SUM` cross the driver as `number | bigint | null`, and a NULL `SUM`
 * over an empty set is a real, expected answer. A value that is neither — a
 * negative or non-finite count — cannot be right, so it degrades to `0` rather
 * than propagating a nonsense number into a log line that claims to reconcile.
 */
function toCount(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

/**
 * Fold one `GROUP BY status` read into the lane's counts.
 *
 * The switch is exhaustive over {@link OutboxStatus} on purpose (ISS-7246): an
 * if/else chain let a newly-added member fall through every branch and vanish
 * from all four buckets — counted nowhere, so the lane reads drained while it
 * holds rows. A new status now fails `tsc` here until it is deliberately
 * bucketed.
 */
function foldOutboxGroups(
  rows: OutboxStatusGroupRow[],
  remainderBasis: SyncLaneRemainderBasis
): OutboxBurndownCounts {
  const counts: OutboxBurndownCounts = {
    ...EMPTY_OUTBOX_COUNTS,
    remainderBasis,
  };
  for (const row of rows) {
    const status = asOutboxStatus(row.status);
    if (status === null) {
      // An unknown status string (a row written by another build, or
      // hand-edited) is still not folded into `pending` or `deadLettered` —
      // mislabelling it would make the burn-down claim something it did not
      // measure. But it is not DROPPED either: an unaccounted row is carried in
      // its own bucket, where it disqualifies the lane from `drained` instead of
      // vanishing into a reassuring zero.
      foldUnaccountedRow(counts, row);
      continue;
    }
    foldOutboxStatusGroup(counts, status, row);
  }
  return counts;
}

function foldOutboxStatusGroup(
  counts: OutboxBurndownCounts,
  status: OutboxStatus,
  row: OutboxStatusGroupRow
): void {
  switch (status) {
    case OutboxStatus.Pending:
      counts.pending = toCount(row.n);
      counts.readyPending = Math.min(toCount(row.n), toCount(row.ready));
      counts.oldestPendingSinceIso = row.oldest;
      return;
    case OutboxStatus.DeadLettered:
      counts.deadLettered = toCount(row.n);
      return;
    case OutboxStatus.Withheld:
      counts.withheld = toCount(row.n);
      return;
    default:
      // Unreachable through the type system — passing `status` into a `never`
      // parameter is what makes a newly-added member fail `tsc` here. At RUNTIME
      // the row still lands in the unaccounted bucket, never a throw: a
      // burn-down sample that crashes on an unfamiliar row reports nothing at
      // all about the lane.
      foldUnaccountedRow(counts, row, status);
      return;
  }
}

/**
 * Carry a row this build cannot account for — an unknown status string, or a
 * member the switch above has not been taught — in its own bucket.
 *
 * The optional `never` parameter is the compile-time half: the exhaustive switch
 * hands it `status`, which only typechecks while every member is handled.
 */
function foldUnaccountedRow(
  counts: OutboxBurndownCounts,
  row: OutboxStatusGroupRow,
  _unhandled?: never
): void {
  counts.unmeasuredRows += toCount(row.n);
}

/**
 * ISS-7096: pending rows parked under this lane's `<lanePrefix>:parked:%`
 * partitions. Prefix-matched with `substr` rather than `LIKE` — the lane
 * prefix contains `_`, which `LIKE` reads as a single-character wildcard
 * (see `AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX`'s warning).
 */
function readSessionParked(
  reader: DesktopPrismaReader,
  sourceKey: string
): Promise<CountRow[]> {
  const lane = splitAgentSessionSyncSourceKey(sourceKey);
  if (!lane) {
    return Promise.resolve([]);
  }
  const parkedPrefix = `${lane.lanePrefix}:${PARKED_OUTBOX_KEY_SEGMENT}:`;
  return reader.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS n
       FROM agent_session_sync_outbox
      WHERE substr(source_key, 1, length($1)) = $1
        AND status = $2`,
    parkedPrefix,
    OutboxStatus.Pending
  );
}

function readSessionOutbox(
  reader: DesktopPrismaReader,
  sourceKey: string,
  nowIso: string
): Promise<OutboxStatusGroupRow[]> {
  return reader.$queryRawUnsafe<OutboxStatusGroupRow[]>(
    `SELECT status,
            COUNT(*) AS n,
            ${OLDEST_PENDING_SINCE_SQL} AS oldest,
            ${READY_ROWS_SQL} AS ready
       FROM agent_session_sync_outbox
      WHERE source_key = $1
      GROUP BY status`,
    sourceKey,
    nowIso
  );
}

function readInvocationOutbox(
  reader: DesktopPrismaReader,
  sourceKey: string,
  nowIso: string
): Promise<InvocationStatusGroupRow[]> {
  return reader.$queryRawUnsafe<InvocationStatusGroupRow[]>(
    `SELECT status,
            COUNT(*) AS n,
            ${OLDEST_PENDING_SINCE_SQL} AS oldest,
            SUM(LENGTH(payload)) AS bytes,
            ${READY_ROWS_SQL} AS ready
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1
      GROUP BY status`,
    sourceKey,
    nowIso
  );
}

function readInvocationPendingSessions(
  reader: DesktopPrismaReader,
  sourceKey: string
): Promise<CountRow[]> {
  return reader.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(DISTINCT external_session_id) AS n
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND status = $2`,
    sourceKey,
    OutboxStatus.Pending
  );
}

function readTranscriptGroups(
  reader: DesktopPrismaReader
): Promise<TranscriptStatusGroupRow[]> {
  return reader.$queryRawUnsafe<TranscriptStatusGroupRow[]>(
    `SELECT status, COUNT(*) AS n, MIN(updated_at) AS oldest
       FROM transcript_sync_state
      GROUP BY status`
  );
}

function readTranscriptBytes(
  reader: DesktopPrismaReader
): Promise<TranscriptBytesRow[]> {
  const placeholders = TRANSCRIPT_IN_FLIGHT_STATUSES.map(
    (_status, index) => `$${index + 1}`
  ).join(", ");
  return reader.$queryRawUnsafe<TranscriptBytesRow[]>(
    `SELECT SUM(MAX(COALESCE(last_size, 0) - synced_byte_offset, 0)) AS bytes
       FROM transcript_sync_state
      WHERE status IN (${placeholders})`,
    ...TRANSCRIPT_IN_FLIGHT_STATUSES
  );
}

function readCursors(
  reader: DesktopPrismaReader,
  sourceKeys: string[]
): Promise<SyncStateRow[]> {
  const placeholders = sourceKeys
    .map((_key, index) => `$${index + 1}`)
    .join(", ");
  return reader.$queryRawUnsafe<SyncStateRow[]>(
    `SELECT source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, updated_at, data_revision
       FROM sync_state
      WHERE source_key IN (${placeholders})`,
    ...sourceKeys
  );
}

/**
 * Parse a `sync_state` JSON-array column into string ids. The column is
 * unconstrained TEXT, so anything can be in there; a value that is not an array
 * of strings yields an EMPTY list rather than a guess, and the caller reports
 * what it could actually measure.
 */
function parseIdArray(value: unknown): readonly string[] {
  // These are Prisma `Json` columns. Depending on the driver they arrive either
  // already-parsed or as the raw TEXT SQLite stores, so BOTH shapes are handled
  // — assuming one silently yields an empty list, which here would read as
  // "nothing abandoned, cursor at the start" and quietly inflate the backlog.
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * ISS-11327: the lane's keyset ranking key, spelled once so both disjuncts of the
 * remainder count below use the identical expression the lane drains with.
 */
const COMPONENT_CURSOR_CANONICAL_RANK_SQL =
  componentCursorCanonicalRankSql("last_seen_at");

/**
 * How many local `agent_components` rows the inventory sweep has NOT reached.
 *
 * The predicate mirrors the lane's own keyset read
 * (`listAgentComponentCursorRows`, `main/database/component-sync-source.ts`)
 * EXACTLY — a burn-down that counted with a different predicate than the lane
 * drains with would reconcile against nothing. On a never-persisted cursor the
 * `('', '')` keyset matches every row, which is precisely the lane's own first
 * backfill set.
 *
 * ISS-11327 is what that "EXACTLY" now costs: the lane pages on the RANKING KEY
 * (`componentCursorCanonicalRankSql`, `last_seen_at` read as an instant) and persists
 * that ranked value as `observed_top_updated_at`, so this count reads the same
 * expression. Left on the raw `COALESCE`, it would compare a ranked watermark against
 * stored bytes and report 0 for a lane that still owes rows — and the caller
 * deliberately keeps `null` (unqueried) distinguishable from a number precisely so a
 * zero can be read as "caught up", which is the false all-clear that would produce.
 *
 * Cost: unchanged, and it was never the index's to serve — the `COALESCE` wrapper was
 * already non-sargable, so `idx_agent_components_last_seen` could not serve this
 * before the rank either and SQLite scanned the table either way. That is accepted
 * deliberately — it is one `COUNT(*)` over a few-thousand-row local inventory, on the
 * reader pool, once a minute. The alternative was reporting `null` forever, and an
 * unmeasured lane can never be shown as caught up.
 */
function readComponentRowsRemaining(
  reader: DesktopPrismaReader,
  watermark: string,
  lastId: string
): Promise<CountRow[]> {
  return reader.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS n
       FROM agent_components
      WHERE ${COMPONENT_CURSOR_CANONICAL_RANK_SQL} > $1
         OR (${COMPONENT_CURSOR_CANONICAL_RANK_SQL} = $1 AND id > $2)`,
    watermark,
    lastId
  );
}

/**
 * Count `idle` rows the current target is still owed, with the lane's OWN
 * stranded predicate — the same `AND` of {@link strandedCloudAckWhere} and
 * {@link strandedCursorWhere} that `requeueStrandedMissingBlobs` re-arms with,
 * so the number the burn-down prints is exactly the set the sweep will requeue.
 *
 * Offline both helpers narrow to their conservative arms, which is the right
 * stance here too: with no target the cursor's domain is unknowable, so this
 * reports only rows that were never delivered by anyone.
 */
function readStrandedIdleTranscripts(
  reader: DesktopPrismaReader,
  computeTargetId: string | null
): Promise<number> {
  return reader.transcriptSyncState.count({
    where: {
      status: TranscriptSyncStatus.Idle,
      AND: [
        strandedCloudAckWhere(computeTargetId),
        strandedCursorWhere(computeTargetId),
      ],
    },
  });
}

function foldTranscriptGroups(
  rows: TranscriptStatusGroupRow[],
  bytesRows: TranscriptBytesRow[],
  strandedIdleFiles: number
): TranscriptBurndownCounts {
  let inFlightFiles = 0;
  let deadFiles = 0;
  let unmeasuredRows = 0;
  let oldestInFlightUpdatedAtIso: string | null = null;
  for (const row of rows) {
    const status = asTranscriptSyncStatus(row.status);
    if (status === TranscriptSyncStatus.Dead) {
      deadFiles = toCount(row.n);
      continue;
    }
    if (status === null) {
      // Same rule as the outbox lanes: a status this build cannot read is
      // carried as unaccounted rather than dropped, so a version-skewed ledger
      // row cannot silently qualify the lane as caught up. A KNOWN-but-settled
      // status (`idle`) is a different thing and is genuinely skipped below.
      unmeasuredRows += toCount(row.n);
      continue;
    }
    if (!TRANSCRIPT_IN_FLIGHT_STATUSES.includes(status)) {
      continue;
    }
    inFlightFiles += toCount(row.n);
    if (
      row.oldest !== null &&
      (oldestInFlightUpdatedAtIso === null ||
        row.oldest < oldestInFlightUpdatedAtIso)
    ) {
      oldestInFlightUpdatedAtIso = row.oldest;
    }
  }
  return {
    inFlightFiles,
    strandedIdleFiles,
    deadFiles,
    bytesRemaining: toCount(bytesRows[0]?.bytes),
    oldestInFlightUpdatedAtIso,
    unmeasuredRows,
  };
}

/**
 * ISS-8768: has THE IDENTITY SIGNED IN NOW ever PROMOTED an invocation
 * generation out of the template key — i.e. has it ever had a real delivery
 * target?
 *
 * The one fact that separates "never paired" from "paired but offline right now"
 * when the live delivery key is null, and it is durable rather than live, which
 * is the point: connectivity comes and goes, a promotion cursor does not.
 *
 * Scoped to `pairedComputeTargetId` — the CURRENT identity's own live-or-retained
 * target, recovered from {@link SyncBurndownQuery.sessionSourceKey} rather than
 * the strict-online {@link SyncBurndownQuery.transcriptComputeTargetId} —
 * deliberately, not to any row `source_key <> templateKey` happens to name
 * (davetho review). On a shared
 * machine, account A pairing and promoting first leaves cursor rows behind that
 * an unrelated, still-unpaired account B would otherwise inherit as "proof" it
 * had paired too, reporting B's real backlog as the old zero this ticket exists
 * to stop. A `null` target (this identity has never paired to anything) answers
 * `false` without a query — no row, however many other identities left behind,
 * can be proof for an identity that has never promoted one of its own.
 */
async function hasPromotedInvocationDeliveryCursor(
  reader: DesktopPrismaReader,
  pairedComputeTargetId: string | null
): Promise<boolean> {
  if (pairedComputeTargetId === null) {
    return false;
  }
  const rows = await reader.$queryRawUnsafe<{ one: number }[]>(
    `SELECT 1 AS one
       FROM agent_component_invocation_sync_cursors
      WHERE source_key = $1
      LIMIT 1`,
    buildAgentComponentInvocationSyncSourceKey(pairedComputeTargetId)
  );
  return rows.length > 0;
}

/**
 * The current identity's OWN compute target, durable across an offline gap —
 * recovered from {@link SyncBurndownQuery.sessionSourceKey}, which is built from
 * the identity-bound live-or-retained resolver
 * (`agent-sync/retained-compute-target-identity.ts`), never the strict-online one
 * {@link SyncBurndownQuery.transcriptComputeTargetId} reads. Reusing that key
 * instead of threading a fourth compute-target getter through the reporter and
 * composition layers keeps this identity-bound value in exactly the one place it
 * is already computed.
 */
function pairedComputeTargetIdFrom(query: SyncBurndownQuery): string | null {
  if (query.sessionSourceKey === null) {
    return null;
  }
  return (
    splitAgentSessionSyncSourceKey(query.sessionSourceKey)?.computeTargetId ??
    null
  );
}

async function readInvocationCounts(
  reader: DesktopPrismaReader,
  query: SyncBurndownQuery
): Promise<InvocationBurndownCounts> {
  if (query.invocationSourceKey === null) {
    // ISS-8768: a null delivery key means nothing has been PROMOTED, not that
    // nothing is owed. Returning all-zeros here made the observer whose whole
    // purpose is "not running is not synced" report `items=0` against a 3,031-row
    // template backlog on an unpaired install — a measured zero standing in for
    // an unmeasured one, and the number every stall detector reads.
    //
    // But the key is null in TWO different situations, and only one of them can
    // be counted. `getTranscriptComputeTargetId` is null when merely OFFLINE as
    // well as when never paired, and without the real target the probe's
    // already-delivered half (the LEFT JOIN on the delivery cursor) cannot be
    // evaluated — every session with a pending template row would count as owed,
    // including ones this machine already delivered. That is the same fabricated
    // number as the zero, in the other direction, and it would page a healthy
    // machine over a three-minute connectivity blip.
    //
    // So the probe runs only when THIS IDENTITY has NEVER promoted anything,
    // which is the state that makes "the whole template backlog is owed" exactly
    // true. A paired-but-offline machine keeps the old zeros: unchanged from
    // before this change, and the stall detector requires a measured remainder,
    // so it stays silent rather than paging on a number nobody can compute.
    if (
      await hasPromotedInvocationDeliveryCursor(
        reader,
        pairedComputeTargetIdFrom(query)
      )
    ) {
      return {
        ...EMPTY_INVOCATION_COUNTS,
        // ISS-10082: stated rather than inherited from the spread, because this
        // is the branch that changes behaviour. Nothing here was read — the
        // delivery key is gone and the probe's already-delivered half cannot be
        // evaluated without it — so every count below is a placeholder, and a
        // paired-but-offline lane now answers `remaining_unknown` where it used
        // to answer `drained` off these zeros.
        remainderBasis: SyncLaneRemainderBasis.Unqueried,
      };
    }
    const templates = await loadPendingInvocationTemplates(
      reader,
      NO_DELIVERY_TARGET_SOURCE_KEY,
      query.invocationTemplateSourceKey,
      "",
      PENDING_TEMPLATE_PROBE_LIMIT,
      query.identity
    );
    return {
      ...EMPTY_INVOCATION_COUNTS,
      // ISS-10082: `counted`, not `unqueried`, and the distinction is the whole
      // point of this branch. The probe above is a real bounded read, and the
      // outbox zeros it leaves in place are structural rather than placeholders:
      // promotion clones outbox rows and writes this target's delivery cursor in
      // one transaction, so a target that has never promoted has no rows under
      // that key to count. Calling this branch unqueried would null the backlog
      // the comment above exists to report.
      remainderBasis: SyncLaneRemainderBasis.Counted,
      pendingTemplateSessions: templates.length,
      pendingTemplateSessionsTruncated:
        templates.length >= PENDING_TEMPLATE_PROBE_LIMIT,
    };
  }
  const [groups, sessions, templates] = await Promise.all([
    readInvocationOutbox(reader, query.invocationSourceKey, query.nowIso),
    readInvocationPendingSessions(reader, query.invocationSourceKey),
    // The lane's OWN predicate, not a status count — see the module header.
    loadPendingInvocationTemplates(
      reader,
      query.invocationSourceKey,
      query.invocationTemplateSourceKey,
      "",
      PENDING_TEMPLATE_PROBE_LIMIT,
      query.identity
    ),
  ]);
  const base = foldOutboxGroups(groups, SyncLaneRemainderBasis.Counted);
  let pendingPayloadBytes = 0;
  for (const row of groups) {
    if (asOutboxStatus(row.status) === OutboxStatus.Pending) {
      pendingPayloadBytes = toCount(row.bytes);
    }
  }
  return {
    ...base,
    pendingSessions: toCount(sessions[0]?.n),
    // Every pending row under the delivery key is one PART of a chunked
    // generation, so the pending row count IS the chunk backlog.
    pendingParts: base.pending,
    pendingPayloadBytes,
    pendingTemplateSessions: templates.length,
    pendingTemplateSessionsTruncated:
      templates.length >= PENDING_TEMPLATE_PROBE_LIMIT,
  };
}

/**
 * Depth for the cursor-sweep lane, read AFTER the cursor so the count is taken
 * from the same committed snapshot as the cursor position it is relative to.
 *
 * A null `componentSourceKey` means the lane has no compute target, so there is
 * no cursor to measure against and the remainder is genuinely UNKNOWN — `null`,
 * never `0`. That distinction is the whole point: a zero here reads as "caught
 * up" and would let the all-lanes verdict claim a clean bill of health for a
 * lane that has not looked.
 */
async function readComponentInventoryCounts(
  reader: DesktopPrismaReader,
  componentSourceKey: string | null,
  cursorsBySourceKey: Record<string, DurableCursorRow>
): Promise<ComponentInventoryBurndownCounts> {
  if (componentSourceKey === null) {
    return {
      rowsRemaining: null,
      deadLetteredCount: 0,
      remainderBasis: SyncLaneRemainderBasis.Unqueried,
    };
  }
  const cursor = cursorsBySourceKey[componentSourceKey];
  const rows = await readComponentRowsRemaining(
    reader,
    cursor?.observedTopUpdatedAt ?? "",
    cursor?.observedIdsAtTopUpdatedAt[0] ?? ""
  );
  return {
    rowsRemaining: toCount(rows[0]?.n),
    // Durable, unlike the lane's in-memory boundary tracker: these are the ids
    // the lane recorded as ABANDONED in `sync_state`. A lane that gave up on
    // rows must never read as caught up.
    deadLetteredCount: cursor?.deadLetteredIds.length ?? 0,
    remainderBasis: SyncLaneRemainderBasis.Counted,
  };
}

/**
 * Build the burn-down readers over `prisma`. Composed into the SQLite
 * `AgentSessionSyncSource` so the main process reaches them through the same
 * db-host proxy as every other sync read — the query in and the sample out are
 * plain structured-clone-safe objects, so the proxy forwards them unchanged.
 */
export function createSyncBurndownReaders(
  prisma: DesktopPrisma
): SyncBurndownReaders {
  return {
    readSyncBurndown(
      query: SyncBurndownQuery
    ): Promise<SyncBurndownStoreSample> {
      const cursorKeys = [query.sessionSourceKey, query.componentSourceKey]
        .filter((key): key is string => key !== null)
        .filter((key) => key.length > 0);
      return prisma.read((client) =>
        // ONE committed snapshot for the whole sample. These aggregates share a
        // pooled reader but, without a read transaction, not a point in time: a
        // writer committing between the status counts and the byte sum or the
        // cursor read yields a sample whose pieces never coexisted — an
        // already-drained queue paired with a pre-drain cursor is exactly the
        // shape `detectCursorStall` misreads as a frozen cursor. The reader
        // connection is `query_only` and the libSQL `deferred` transaction pins
        // the snapshot, so this adds no writer contention.
        client.$transaction(async (tx) => {
          // ISS-10082 review: ONE binding for both the short-circuit and the
          // label it produces. Two copies of the condition forty lines apart is
          // how a widened short-circuit keeps answering `counted` for a read
          // that never ran — this ticket's own defect, regressed with no test
          // failure. A local const rather than a boolean so the narrowing does
          // the work and neither branch needs a second null check.
          const sessionSourceKey = query.sessionSourceKey;
          const [
            sessionGroups,
            sessionParkedRows,
            invocationCounts,
            transcriptGroups,
            transcriptBytes,
            strandedIdleTranscripts,
            cursorRows,
          ] = await Promise.all([
            sessionSourceKey === null
              ? Promise.resolve<OutboxStatusGroupRow[]>([])
              : readSessionOutbox(tx, sessionSourceKey, query.nowIso),
            sessionSourceKey === null
              ? Promise.resolve<CountRow[]>([])
              : readSessionParked(tx, sessionSourceKey),
            readInvocationCounts(tx, query),
            readTranscriptGroups(tx),
            readTranscriptBytes(tx),
            readStrandedIdleTranscripts(tx, query.transcriptComputeTargetId),
            cursorKeys.length === 0
              ? Promise.resolve<SyncStateRow[]>([])
              : readCursors(tx, cursorKeys),
          ]);
          const cursorsBySourceKey: Record<string, DurableCursorRow> =
            Object.create(null);
          for (const row of cursorRows) {
            cursorsBySourceKey[row.source_key] = {
              sourceKey: row.source_key,
              observedTopUpdatedAt: row.observed_top_updated_at,
              observedIdsAtTopUpdatedAt: parseIdArray(
                row.observed_ids_at_top_updated_at
              ),
              deadLetteredIds: parseIdArray(row.dead_lettered_ids),
              updatedAt: row.updated_at,
              dataRevision: toCount(row.data_revision),
            };
          }
          const componentInventory = await readComponentInventoryCounts(
            tx,
            query.componentSourceKey,
            cursorsBySourceKey
          );
          return {
            sessionOutbox: {
              // ISS-10082: the session reads above are skipped wholesale on a
              // null key, so `[]` here is "nobody looked", not "the queue is
              // empty". One branch, unlike the invocation lane's two.
              ...foldOutboxGroups(
                sessionGroups,
                sessionSourceKey === null
                  ? SyncLaneRemainderBasis.Unqueried
                  : SyncLaneRemainderBasis.Counted
              ),
              parkedPending: toCount(sessionParkedRows[0]?.n),
            },
            invocationOutbox: invocationCounts,
            transcript: foldTranscriptGroups(
              transcriptGroups,
              transcriptBytes,
              strandedIdleTranscripts
            ),
            componentInventory,
            cursorsBySourceKey,
          };
        })
      );
    },
  };
}
