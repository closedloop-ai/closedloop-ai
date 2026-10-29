import type { TransactionClient } from "@repo/database";

export const BranchAnalyticsRollupReadStatus = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type BranchAnalyticsRollupReadStatus =
  (typeof BranchAnalyticsRollupReadStatus)[keyof typeof BranchAnalyticsRollupReadStatus];

export const BranchAnalyticsRollupState = {
  Pending: "pending",
  Fresh: "fresh",
  Stale: "stale",
  Error: "error",
} as const;
export type BranchAnalyticsRollupState =
  (typeof BranchAnalyticsRollupState)[keyof typeof BranchAnalyticsRollupState];

export const BranchAnalyticsRollupUnavailableReason = {
  Missing: "missing",
  BackfillIncomplete: "backfill_incomplete",
  SessionRowsMissing: "session_rows_missing",
  StateError: "state_error",
  StaleClock: "stale_clock",
  LagUnknown: "lag_unknown",
  LagExceeded: "lag_exceeded",
  DateWindowUnsupported: "date_window_unsupported",
} as const;
export type BranchAnalyticsRollupUnavailableReason =
  (typeof BranchAnalyticsRollupUnavailableReason)[keyof typeof BranchAnalyticsRollupUnavailableReason];

export const BranchAnalyticsRollupFailureCategory = {
  PrismaCodePrefix: "prisma_",
  SqlStatePrefix: "sqlstate_",
  Unknown: "unknown",
} as const;
export type BranchAnalyticsRollupFailureCategory =
  | typeof BranchAnalyticsRollupFailureCategory.Unknown
  | `${typeof BranchAnalyticsRollupFailureCategory.PrismaCodePrefix}${string}`
  | `${typeof BranchAnalyticsRollupFailureCategory.SqlStatePrefix}${string}`;

export const BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS = 15 * 60 * 1000;
/**
 * How long a producer may be silent before a read stops trusting the state row.
 * It bounds PRODUCER LIVENESS, not data freshness — `lagSeconds` carries that —
 * so it only holds while the cron's worst-case per-organization revisit
 * interval stays well under it. ISS-9831: prod measured an `as_of` age of
 * p50 19.5 min / p95 34.8 min against this 15 min ceiling, because 77
 * organizations were visited 10 per 5-minute run. The value is unchanged and
 * the cadence was fixed instead — see the organization limit and due interval
 * in `branch-analytics-rollup.ts` — because raising it here would loosen how
 * stale a served figure may be.
 */
export const BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS =
  BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS;
/**
 * ISS-10565: how far before a session's materialized `as_of`, or the later
 * pass that confirmed it, the refresh pass still looks for newly received
 * events. `created_at` is stamped when the
 * ingest transaction writes the row, and that transaction may commit up to
 * `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` (30s) later, so an event can carry a
 * `created_at` at or before a pass's cutoff and still be invisible to that pass.
 */
export const BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS = 15 * 60 * 1000;
/**
 * How long an organization's rollup may go unvisited before the sweep considers
 * it due. Deliberately shorter than the 5-minute cron period: an organization
 * refreshed on one run must be due again on the next, or `as_of` ages two cron
 * periods between visits and eats the read's staleness ceiling.
 *
 * It lives here rather than beside the due query because a test that reproduces
 * that query has to derive the SAME window, and a copy there would keep
 * agreeing with itself after this moved.
 */
export const BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS = 4 * 60 * 1000;
/**
 * The rollup grain, and the reason a read can never serve the wrong one.
 *
 * ISS-9831 re-grained the writer from one row per session LIFETIME to one row
 * per session per UTC day, which changes what `bucket_start` MEANS. `source` is
 * part of the table's identity key, so moving its value makes new-grain rows a
 * disjoint set from the rows already stored, rather than a migration: every
 * read, the completeness gate, the watermark, and the refresh queue already
 * filter on it. During the rollout a session that still has only lifetime-grain
 * rows therefore reads as having NO rows, is reported incomplete, and the caller
 * falls back to the source aggregate. There is no window in which a lifetime
 * total can answer a windowed request, because no query can see one.
 */
export const BRANCH_ANALYTICS_ROLLUP_SOURCE =
  "agent_session_token_events_daily" as const;
/**
 * Grains this table has held before. Rows under them are invisible to every
 * read; the refresh's delete step reclaims a session's old-grain rows as it
 * re-materializes that session, so the re-backfill is also the cleanup.
 */
export const BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES = [
  "agent_session_token_events",
] as const;

export type BranchAnalyticsRollupReadClient = Pick<
  TransactionClient,
  "$queryRaw"
>;
export type BranchAnalyticsRollupWriteClient = Pick<
  TransactionClient,
  "$executeRaw" | "$queryRaw"
>;

export type BranchAnalyticsRollupDateWindow = {
  startDate?: Date;
  endDate?: Date;
};

/** Materialized aggregate rows consumed by Branch analytics cost evidence. */
export type BranchAnalyticsRollupReadResult =
  | {
      status: typeof BranchAnalyticsRollupReadStatus.Available;
      rows: BranchAnalyticsRollupAggregateRow[];
    }
  | {
      status: typeof BranchAnalyticsRollupReadStatus.Unavailable;
      reason: BranchAnalyticsRollupUnavailableReason;
      state?: BranchAnalyticsRollupStateRow;
    };

export type BranchAnalyticsRollupAggregateRow = {
  agentSessionId: string;
  sumInputTokens: bigint | number | { toString(): string } | null;
  sumOutputTokens: bigint | number | { toString(): string } | null;
  sumCacheReadTokens: bigint | number | { toString(): string } | null;
  sumCacheWriteTokens: bigint | number | { toString(): string } | null;
  sumEstimatedCost: { toString(): string } | null;
  minInputTokens: bigint | number | { toString(): string } | null;
  minOutputTokens: bigint | number | { toString(): string } | null;
  minCacheReadTokens: bigint | number | { toString(): string } | null;
  minCacheWriteTokens: bigint | number | { toString(): string } | null;
  minEstimatedCost: { toString(): string } | number | null;
  estimatedCostCount: bigint | number | { toString(): string } | null;
  eventCount: bigint | number | { toString(): string } | null;
};

export type BranchAnalyticsRollupStateRow = {
  organizationId: string;
  state: string;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  asOf: Date | null;
  lagSeconds: number | bigint | null;
  backfillCompletedAt: Date | null;
};

export type BranchAnalyticsRollupSessionRefreshRow = {
  agentSessionId: string;
  /**
   * True when the session is MISSING a rollup or behind its source watermark —
   * i.e. the rollup cannot answer for it. False when it is queued only because
   * it was synced since it was materialized (an in-place cost edit, ISS-12779),
   * which a watermark cannot see and so is not read as incompleteness.
   */
  needsBackfill: boolean;
};

export type BranchAnalyticsRollupIncompleteSessionRow = {
  agentSessionId: string;
};

export type BranchAnalyticsRollupSourceWatermarkRow = {
  sourceWatermarkEventCreatedAt: Date | null;
  malformedSessionCount: bigint;
  purgedRows: bigint;
};

export type BranchAnalyticsRollupOrganizationRow = {
  organizationId: string;
  /**
   * The organization's rollup cursor, carried out of the selection query so a
   * run can report how far behind its oldest work is without a second read.
   * Null both for an organization with no state row at all and for one whose
   * state row has never been stamped — `hasRollupState` tells those apart.
   */
  asOf: Date | null;
  /** False for an organization that has never been rolled up at all. */
  hasRollupState: boolean;
};

export type RefreshBranchAnalyticsRollupBatchInput = {
  organizationId: string;
  sessionLimit?: number;
  now?: Date;
};

export type RefreshDueBranchAnalyticsRollupsInput = {
  organizationLimit?: number;
  sessionLimit?: number;
  now?: Date;
};

export type RefreshBranchAnalyticsSessionRollupsInput = {
  organizationId: string;
  sessionArtifactIds: readonly string[];
  asOf: Date;
};

export type BranchAnalyticsSessionRollupRefreshSummary = {
  deletedRows: number;
  upsertedRows: number;
};

/** Progress summary for one bounded organization refresh. */
export type BranchAnalyticsRollupBatchSummary = {
  organizationId: string;
  sessionsRefreshed: number;
  deletedRows: number;
  upsertedRows: number;
  complete: boolean;
  lagSeconds: number | null;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
};

/** Cron-level summary across organizations refreshed in one invocation. */
export type BranchAnalyticsRollupDueSummary = {
  organizations: number;
  batches: number;
  sessionsRefreshed: number;
  upsertedRows: number;
  completeOrganizations: number;
  incompleteOrganizations: number;
  failedOrganizations: number;
  /** Distinct categories across every failed organization this run, sorted. */
  failureCategories: BranchAnalyticsRollupFailureCategory[];
  /** The first failed organizations, capped; `failedOrganizations` is the total. */
  failures: BranchAnalyticsRollupOrganizationFailure[];
  maxLagSeconds: number | null;
  /** True when the due query returned a full page, so organizations were left unvisited. */
  organizationLimitReached: boolean;
  /** True when the run's wall-clock budget stopped it before every due organization was visited. */
  budgetExhausted: boolean;
  /**
   * Age of the oldest STAMPED rollup cursor this run selected, in milliseconds.
   * ISS-10079's starvation was reported as `organizationLimitReached`, which
   * says a page was truncated and never which class it was truncated in favour
   * of — so a run that reached no state-carrying organization at all looked
   * like any other busy run. This is the number that tells them apart: the
   * selection reserves that class a share of every page and orders it
   * oldest-first, so the oldest cursor in the page is the oldest cursor there
   * is. Growing without bound means the sweep is not keeping up.
   *
   * Null when no state-carrying organization carried a readable cursor — either
   * because none was due, or because every one that was has never been stamped
   * (a cursor with no age, not an age of zero) or is dated after the run clock.
   * Those two cases are told apart by `organizations - neverRolledUpOrganizations`:
   * a null age with a non-zero remainder means the whole state-carrying share
   * of the page was unreadable, which is its own alarm.
   */
  oldestDueAsOfAgeMs: number | null;
  /**
   * Organizations in THIS RUN'S PAGE that have never been rolled up at all.
   *
   * It describes the page, not the backlog, so it saturates at that class's
   * reserved share (about half of `organizationLimit`) and pins there for a
   * waiting population of 51 and of 50,000 alike. Read it as page composition —
   * the unsaturating starvation signal is `oldestDueAsOfAgeMs` above.
   */
  neverRolledUpOrganizations: number;
};

export type UpsertBranchAnalyticsRollupStateInput = {
  organizationId: string;
  state: BranchAnalyticsRollupState;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  asOf: Date;
  lagSeconds: number | null;
  backfillCompletedAt: Date | null;
  /**
   * Set only by a pass whose refresh queue fit its batch; `null` keeps the
   * stored value. See `branchSessionReceivedSinceMaterializedSql`.
   */
  receivedReconciledThrough: Date | null;
};

/** One organization a due run failed to refresh, and why. */
export type BranchAnalyticsRollupOrganizationFailure = {
  organizationId: string;
  failureCategory: BranchAnalyticsRollupFailureCategory;
};

/** Scalar source evidence plus the bounded, ordered refresh queue. */
export type BranchAnalyticsRollupRefreshScanRow =
  BranchAnalyticsRollupSourceWatermarkRow & {
    sessionRefreshBatch: BranchAnalyticsRollupSessionRefreshRow[];
  };
