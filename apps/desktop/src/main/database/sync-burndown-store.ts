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
 *  - **Trace comments** — `GROUP BY sync_status`, served by
 *    `idx_trace_comments_sync_status`, plus a `LIKE` over the `replies` JSON for
 *    per-reply pending work. That second read is unindexed, but it is the same
 *    scan this lane's own drain tick already runs every 10 seconds, so once per
 *    sample is strictly cheaper than what the lane already costs.
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
 * target-scoped delivery `source_key`. Counting
 * `WHERE status = 'pending'` across the table reports the ~3.5k unscoped
 * TEMPLATE rows as a cloud backlog. They are never-attempted definitions the
 * lane clones from, not undelivered work. See
 * `invocation-sync-pending-templates.ts`.
 *
 * Nothing here reads payload BODIES, session titles, or file paths — only
 * counts, byte sizes, timestamps, and durable cursor positions.
 */

import {
  asOutboxStatus,
  OutboxStatus,
} from "../../shared/sync-lane-contract.js";
import {
  asTraceCommentSyncStatus,
  isPendingTraceCommentSyncStatus,
  PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES,
} from "../../shared/trace-comment-sync-status-contract.js";
import {
  asTranscriptSyncStatus,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";
import { loadPendingInvocationTemplates } from "./invocation-sync-pending-templates.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import {
  strandedCloudAckWhere,
  strandedCursorWhere,
} from "./transcript-sync-settle.js";

/**
 * Ceiling on the template-migration probe. The predicate is a keyset-paged
 * SELECT, so it is read with a bound rather than an unbounded `COUNT` — a
 * burn-down must not become an O(N) scan to report that N is large. At the cap
 * the sample reports `pendingTemplateSessionsTruncated`, and the burn-down line
 * says `>= N` rather than pretending the number is exact.
 */
const PENDING_TEMPLATE_PROBE_LIMIT = 200;

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
   * ISS-5973: the sample's own instant, ISO-8601. The outbox reads compare each
   * row's `next_attempt_at` against it to separate deferred work from eligible
   * work, and taking it from the caller keeps that boundary pinnable in a test
   * instead of depending on SQLite's clock.
   */
  nowIso: string;
};

/** Queue depth for one outbox-shaped lane. */
export type OutboxBurndownCounts = {
  pending: number;
  /**
   * Of {@link pending}, the rows whose backoff deadline has elapsed — counted
   * with the same `next_attempt_at IS NULL OR next_attempt_at <= now` predicate
   * `readyOutboxWhere` drains on, so "eligible" here and "eligible" there cannot
   * disagree.
   *
   * A queue that is entirely deferred is completing nothing BY SCHEDULE, and the
   * no-progress detector needs to tell that apart from a queue that is eligible
   * and being ignored.
   */
  readyPending: number;
  deadLettered: number;
  /** `created_at` of the oldest still-`pending` row, or null when none. */
  oldestPendingEnqueuedAtIso: string | null;
  /**
   * Rows whose `status` string this build cannot classify — written by another
   * build, or corrupt. They are counted rather than dropped: silently discarding
   * them turns a version-skewed row into a reassuring zero and can qualify the
   * lane as drained when it is holding work nobody can account for.
   */
  unmeasuredRows: number;
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

/**
 * Depth for the trace-comment lane. This lane stores its queue ON the entity row
 * (`trace_comments.sync_status`) rather than in a separate outbox — a difference
 * in storage shape, not a statement that it owes nothing.
 */
export type TraceCommentBurndownCounts = {
  /** Comments whose own CRUD delivery is still owed. */
  pendingComments: number;
  /** Comments carrying at least one reply the cloud has not accepted. */
  pendingReplyComments: number;
  /** `created_at` of the oldest pending comment — genuinely authoring time. */
  oldestPendingCreatedAtIso: string | null;
  /** Rows whose `sync_status` this build cannot classify. */
  unmeasuredRows: number;
};

/** One durable cursor row, read straight from `sync_state`. */
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
};

/** Everything one burn-down sample reads, in raw store terms. */
export type SyncBurndownStoreSample = {
  sessionOutbox: OutboxBurndownCounts;
  invocationOutbox: InvocationBurndownCounts;
  transcript: TranscriptBurndownCounts;
  componentInventory: ComponentInventoryBurndownCounts;
  traceComments: TraceCommentBurndownCounts;
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
  pending: 0,
  readyPending: 0,
  deadLettered: 0,
  oldestPendingEnqueuedAtIso: null,
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

function foldOutboxGroups(rows: OutboxStatusGroupRow[]): OutboxBurndownCounts {
  const counts: OutboxBurndownCounts = { ...EMPTY_OUTBOX_COUNTS };
  for (const row of rows) {
    const status = asOutboxStatus(row.status);
    if (status === OutboxStatus.Pending) {
      counts.pending = toCount(row.n);
      counts.readyPending = Math.min(toCount(row.n), toCount(row.ready));
      counts.oldestPendingEnqueuedAtIso = row.oldest;
    } else if (status === OutboxStatus.DeadLettered) {
      counts.deadLettered = toCount(row.n);
    } else if (status === null) {
      // An unknown status string (a row written by another build, or
      // hand-edited) is still not folded into `pending` or `deadLettered` —
      // mislabelling it would make the burn-down claim something it did not
      // measure. But it is not DROPPED either: an unaccounted row is carried in
      // its own bucket, where it disqualifies the lane from `drained` instead of
      // vanishing into a reassuring zero.
      counts.unmeasuredRows += toCount(row.n);
    }
  }
  return counts;
}

function readSessionOutbox(
  reader: DesktopPrismaReader,
  sourceKey: string,
  nowIso: string
): Promise<OutboxStatusGroupRow[]> {
  return reader.$queryRawUnsafe<OutboxStatusGroupRow[]>(
    `SELECT status,
            COUNT(*) AS n,
            MIN(created_at) AS oldest,
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
            MIN(created_at) AS oldest,
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
 * How many local `agent_components` rows the inventory sweep has NOT reached.
 *
 * The predicate mirrors the lane's own keyset read
 * (`main/database/component-sync-source.ts:131-152`) EXACTLY, `COALESCE` and
 * all — a burn-down that counted with a different predicate than the lane
 * drains with would reconcile against nothing. On a never-persisted cursor the
 * `('', '')` keyset matches every row, which is precisely the lane's own first
 * backfill set.
 *
 * Cost: the `COALESCE(last_seen_at, '')` wrapper is non-sargable, so
 * `idx_agent_components_last_seen` cannot serve this and SQLite scans the table.
 * That is accepted deliberately — it is one `COUNT(*)` over a
 * few-thousand-row local inventory, on the reader pool, once a minute. The
 * alternative was reporting `null` forever, and an unmeasured lane can never be
 * shown as caught up.
 */
function readComponentRowsRemaining(
  reader: DesktopPrismaReader,
  watermark: string,
  lastId: string
): Promise<CountRow[]> {
  return reader.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS n
       FROM agent_components
      WHERE COALESCE(last_seen_at, '') > $1
         OR (COALESCE(last_seen_at, '') = $1 AND id > $2)`,
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

async function readInvocationCounts(
  reader: DesktopPrismaReader,
  query: SyncBurndownQuery
): Promise<InvocationBurndownCounts> {
  if (query.invocationSourceKey === null) {
    return { ...EMPTY_INVOCATION_COUNTS };
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
      PENDING_TEMPLATE_PROBE_LIMIT
    ),
  ]);
  const base = foldOutboxGroups(groups);
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
 * Trace-comment depth.
 *
 * Two reads, mirroring the two places this lane keeps pending work:
 *
 *  - `GROUP BY sync_status` over the column, served by
 *    `idx_trace_comments_sync_status`. Exact, and it also surfaces statuses this
 *    build cannot classify instead of dropping them.
 *  - a `LIKE` over the `replies` JSON for per-reply pending work, which the
 *    column cannot express. That predicate is unindexed — but it is the SAME
 *    scan `listPendingLocalTraceCommentTargets` already performs every 10
 *    seconds on this lane's own drain tick, so running it once per burn-down
 *    sample is strictly cheaper than what the lane already costs.
 *
 * Deliberately NOT scope-filtered, unlike the lane's own drain query. A comment
 * orphaned by an account switch no longer matches
 * `traceCommentScopeConditionSql()` and will never be retried — so it is
 * permanently undelivered local work, and a burn-down that asks "how much is
 * still owed to the cloud" must count it even though the lane will not drain it.
 * The two numbers answer different questions on purpose.
 */
function readTraceCommentGroups(
  reader: DesktopPrismaReader
): Promise<OutboxStatusGroupRow[]> {
  return reader.$queryRawUnsafe<OutboxStatusGroupRow[]>(
    `SELECT sync_status AS status, COUNT(*) AS n, MIN(created_at) AS oldest
       FROM trace_comments
      GROUP BY sync_status`
  );
}

function readTraceCommentPendingReplies(
  reader: DesktopPrismaReader
): Promise<CountRow[]> {
  const placeholders = PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES.map(
    (_status, index) => `CAST(replies AS TEXT) LIKE $${index + 1}`
  ).join(" OR ");
  return reader.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS n FROM trace_comments WHERE ${placeholders}`,
    ...PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES.map((status) => `%${status}%`)
  );
}

function foldTraceCommentGroups(
  rows: OutboxStatusGroupRow[],
  replyRows: CountRow[]
): TraceCommentBurndownCounts {
  let pendingComments = 0;
  let unmeasuredRows = 0;
  let oldestPendingCreatedAtIso: string | null = null;
  for (const row of rows) {
    const status = asTraceCommentSyncStatus(row.status);
    if (status === null) {
      unmeasuredRows += toCount(row.n);
      continue;
    }
    if (!isPendingTraceCommentSyncStatus(status)) {
      continue;
    }
    pendingComments += toCount(row.n);
    if (
      row.oldest !== null &&
      (oldestPendingCreatedAtIso === null ||
        row.oldest < oldestPendingCreatedAtIso)
    ) {
      oldestPendingCreatedAtIso = row.oldest;
    }
  }
  return {
    pendingComments,
    pendingReplyComments: toCount(replyRows[0]?.n),
    oldestPendingCreatedAtIso,
    unmeasuredRows,
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
    return { rowsRemaining: null, deadLetteredCount: 0 };
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
          const [
            sessionGroups,
            invocationCounts,
            transcriptGroups,
            transcriptBytes,
            strandedIdleTranscripts,
            traceCommentGroups,
            traceCommentReplyRows,
            cursorRows,
          ] = await Promise.all([
            query.sessionSourceKey === null
              ? Promise.resolve<OutboxStatusGroupRow[]>([])
              : readSessionOutbox(tx, query.sessionSourceKey, query.nowIso),
            readInvocationCounts(tx, query),
            readTranscriptGroups(tx),
            readTranscriptBytes(tx),
            readStrandedIdleTranscripts(tx, query.transcriptComputeTargetId),
            readTraceCommentGroups(tx),
            readTraceCommentPendingReplies(tx),
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
            sessionOutbox: foldOutboxGroups(sessionGroups),
            invocationOutbox: invocationCounts,
            transcript: foldTranscriptGroups(
              transcriptGroups,
              transcriptBytes,
              strandedIdleTranscripts
            ),
            componentInventory,
            traceComments: foldTraceCommentGroups(
              traceCommentGroups,
              traceCommentReplyRows
            ),
            cursorsBySourceKey,
          };
        })
      );
    },
  };
}
