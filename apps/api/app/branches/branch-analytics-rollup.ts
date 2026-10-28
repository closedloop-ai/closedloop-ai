import { Prisma, withDb } from "@repo/database";
import {
  setAppSpanAttributes,
  withAppSpan,
} from "@repo/observability/tracing/spans";
import { selectIncompleteMaterializedSessions } from "./branch-analytics-rollup-completeness";
import {
  BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS,
  BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS,
  BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS,
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupAggregateRow,
  type BranchAnalyticsRollupBatchSummary,
  type BranchAnalyticsRollupDateWindow,
  type BranchAnalyticsRollupDueSummary,
  type BranchAnalyticsRollupFailureCategory,
  type BranchAnalyticsRollupOrganizationFailure,
  type BranchAnalyticsRollupOrganizationRow,
  type BranchAnalyticsRollupReadClient,
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupState,
  type BranchAnalyticsRollupStateRow,
  BranchAnalyticsRollupUnavailableReason,
  type BranchAnalyticsRollupWriteClient,
  type BranchAnalyticsSessionRollupRefreshSummary,
  type RefreshBranchAnalyticsRollupBatchInput,
  type RefreshBranchAnalyticsSessionRollupsInput,
  type RefreshDueBranchAnalyticsRollupsInput,
} from "./branch-analytics-rollup-contract";
import { classifyBranchAnalyticsRollupFailure } from "./branch-analytics-rollup-failure";
import { readSourceWatermarkAndRefreshBatch } from "./branch-analytics-rollup-refresh-reads";
import {
  branchAnalyticsRollupBucketPartsSql,
  branchAnalyticsRollupEdgePartsSql,
  planBranchAnalyticsRollupWindow,
} from "./branch-analytics-rollup-window";
import {
  deleteBranchAnalyticsSessionRollups,
  recordBranchAnalyticsRollupFailure,
  upsertBranchAnalyticsRollupState,
  upsertBranchAnalyticsSessionRollups,
} from "./branch-analytics-rollup-write";

/** Read the precomputed Branch analytics token-event projection when fresh. */
export function readMaterializedBranchEventAggregates(
  db: BranchAnalyticsRollupReadClient,
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: BranchAnalyticsRollupDateWindow | undefined,
  now = new Date()
): Promise<BranchAnalyticsRollupReadResult> {
  if (sessionIds.length === 0) {
    return Promise.resolve({
      status: BranchAnalyticsRollupReadStatus.Available,
      rows: [],
    });
  }
  return withAppSpan(
    "branches.analytics.rollup.read",
    async () =>
      readMaterializedBranchEventAggregatesWithSpan(
        db,
        organizationId,
        sessionIds,
        dateWindow,
        now
      ),
    {
      "branches.analytics.rollup.read.session_count": sessionIds.length,
      "branches.analytics.rollup.read.source": BRANCH_ANALYTICS_ROLLUP_SOURCE,
    }
  );
}

/**
 * The instant a rollup is trustworthy for every one of `sessionIds`, or
 * `undefined`: the state is Fresh and within its lag ceiling, and no session is
 * missing from it or behind its own source. The gate `readMaterialized...`
 * applies, for callers that read the rollup's rows themselves (ISS-12346).
 */
export async function readBranchAnalyticsRollupAsOf(
  db: BranchAnalyticsRollupReadClient,
  organizationId: string,
  sessionIds: readonly string[],
  now: Date
): Promise<Date | undefined> {
  const state = await readBranchAnalyticsRollupState(db, organizationId);
  const availability = evaluateRollupAvailability(state, now);
  if (
    availability.status === BranchAnalyticsRollupReadStatus.Unavailable ||
    !state?.asOf
  ) {
    return;
  }
  const incomplete = await selectIncompleteMaterializedSessions(db, {
    organizationId,
    sessionIds,
    asOf: state.asOf,
  });
  return incomplete.length > 0 ? undefined : state.asOf;
}

/** Refresh one bounded receive-time batch for an organization. */
export async function refreshBranchAnalyticsRollupBatch(
  input: RefreshBranchAnalyticsRollupBatchInput
): Promise<BranchAnalyticsRollupBatchSummary> {
  const now = input.now ?? new Date();
  try {
    return await withDb.tx(
      (tx) =>
        refreshBranchAnalyticsRollupBatchTx(tx, {
          ...input,
          now,
        }),
      {
        maxWait: BRANCH_ANALYTICS_ROLLUP_TX_MAX_WAIT_MS,
        timeout: BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS,
      }
    );
  } catch (error) {
    await recordBranchAnalyticsRollupFailureBestEffort(
      input.organizationId,
      error,
      now
    );
    throw error;
  }
}

/** Refresh due organizations sequentially so the cron never fans out DB work. */
export async function refreshDueBranchAnalyticsRollups(
  input: RefreshDueBranchAnalyticsRollupsInput = {}
): Promise<BranchAnalyticsRollupDueSummary> {
  const now = input.now ?? new Date();
  const organizationLimit = normalizeLimit(
    input.organizationLimit,
    BRANCH_ANALYTICS_ROLLUP_MAX_ORGANIZATION_LIMIT,
    BRANCH_ANALYTICS_ROLLUP_DEFAULT_ORGANIZATION_LIMIT
  );
  // Probed one past the bound. A page of exactly `organizationLimit` due
  // organizations means every one of them ran, so only the extra row proves the
  // page left work behind — `length >= organizationLimit` reported truncation
  // that had not happened, on the most common shape there is.
  const duePage = await selectDueBranchAnalyticsRollupOrganizations(
    now,
    organizationLimit + 1
  );
  const organizationLimitReached = duePage.length > organizationLimit;
  const organizations = duePage.slice(0, organizationLimit);
  const backlog = measureDueSelectionBacklog(organizations, now);
  setAppSpanAttributes({
    "branches.analytics.rollup.refresh.never_rolled_up_organizations":
      backlog.neverRolledUpOrganizations,
    // Omitted rather than sent as a sentinel when nothing stamped was due: a
    // `-1` or `0` age reads as a measurement on every dashboard that plots it.
    ...(backlog.oldestDueAsOfAgeMs === null
      ? {}
      : {
          "branches.analytics.rollup.refresh.oldest_due_as_of_age_ms":
            backlog.oldestDueAsOfAgeMs,
        }),
  });
  const summaries: BranchAnalyticsRollupBatchSummary[] = [];
  const deadline = Date.now() + BRANCH_ANALYTICS_ROLLUP_DUE_BUDGET_MS;
  let failedOrganizations = 0;
  let budgetExhausted = false;
  const failureCategories = new Set<BranchAnalyticsRollupFailureCategory>();
  const failures: BranchAnalyticsRollupOrganizationFailure[] = [];
  for (const organization of organizations) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    try {
      summaries.push(
        await refreshBranchAnalyticsRollupBatch({
          organizationId: organization.organizationId,
          sessionLimit: input.sessionLimit,
          now,
        })
      );
    } catch (error) {
      failedOrganizations += 1;
      // ISS-9831: the failure was swallowed here and `last_error_code` is
      // cleared by the org's next successful refresh, so a burst of
      // `state_error` reads (113 of them on 2026-09-04) left no durable record
      // of WHAT failed. Accumulated rather than set per failure: span
      // attributes overwrite by key, so assigning inside the loop would report
      // only the last organization's category and hide every earlier, possibly
      // different, cause in the same run.
      const failureCategory = classifyBranchAnalyticsRollupFailure(error);
      failureCategories.add(failureCategory);
      if (failures.length < BRANCH_ANALYTICS_ROLLUP_REPORTED_FAILURE_LIMIT) {
        failures.push({
          organizationId: organization.organizationId,
          failureCategory,
        });
      }
      setAppSpanAttributes({
        "branches.analytics.rollup.refresh.failed_organizations":
          failedOrganizations,
        "branches.analytics.rollup.refresh.failure_categories": [
          ...failureCategories,
        ]
          .sort()
          .join(","),
      });
    }
  }
  return summarizeDueRefresh({
    backlog,
    budgetExhausted,
    failedOrganizations,
    failureCategories: [...failureCategories].sort(),
    failures,
    organizationLimitReached,
    organizations: organizations.length,
    summaries,
  });
}

/**
 * Refresh the projection for specific sessions inside the caller's transaction.
 * The cron producer and future ingest hooks share this set-based operation.
 */
export async function refreshBranchAnalyticsSessionRollupsTx(
  tx: BranchAnalyticsRollupWriteClient,
  input: RefreshBranchAnalyticsSessionRollupsInput
): Promise<BranchAnalyticsSessionRollupRefreshSummary> {
  const sessionArtifactIds = distinctValues(input.sessionArtifactIds);
  if (sessionArtifactIds.length === 0) {
    return { deletedRows: 0, upsertedRows: 0 };
  }
  const deletedRows = await deleteBranchAnalyticsSessionRollups(
    tx,
    input.organizationId,
    sessionArtifactIds,
    input.asOf
  );
  const upsertedRows = await upsertBranchAnalyticsSessionRollups(
    tx,
    input.organizationId,
    sessionArtifactIds,
    input.asOf
  );
  return { deletedRows, upsertedRows };
}

/** Transactional implementation exported for focused tests and existing callers. */
export async function refreshBranchAnalyticsRollupBatchTx(
  tx: BranchAnalyticsRollupWriteClient,
  input: RefreshBranchAnalyticsRollupBatchInput & { now: Date }
): Promise<BranchAnalyticsRollupBatchSummary> {
  const sessionLimit = normalizeLimit(
    input.sessionLimit,
    BRANCH_ANALYTICS_ROLLUP_MAX_SESSION_LIMIT,
    BRANCH_ANALYTICS_ROLLUP_DEFAULT_SESSION_LIMIT
  );
  const {
    sourceWatermarkEventCreatedAt,
    malformedSessionCount,
    purgedRows,
    sessionRefreshBatch,
  } = await readSourceWatermarkAndRefreshBatch(
    tx,
    input.organizationId,
    input.now,
    sessionLimit
  );
  if (malformedSessionCount > 0n) {
    setAppSpanAttributes({
      "branches.analytics.rollup.refresh.malformed_session_count": Number(
        malformedSessionCount
      ),
    });
  }
  const sessionArtifactIds = distinctValues(
    sessionRefreshBatch.map((row) => row.agentSessionId)
  );
  const sessionRefresh = await refreshBranchAnalyticsSessionRollupsTx(tx, {
    organizationId: input.organizationId,
    sessionArtifactIds,
    asOf: input.now,
  });
  const materializedThroughEventCreatedAt =
    await readMaterializedThroughEventCreatedAt(tx, input.organizationId);
  // Backfill-first ordering makes the last row decisive: if the bound was hit
  // on a re-synced row, every session that was MISSING or behind its source
  // watermark fit inside this batch and was just materialized.
  const backfillComplete =
    sessionRefreshBatch.length < sessionLimit ||
    !sessionRefreshBatch.at(-1)?.needsBackfill;
  const lagSeconds = calculateRollupLagSeconds(
    sourceWatermarkEventCreatedAt,
    materializedThroughEventCreatedAt
  );
  const nextState = resolveNextRollupState({
    backfillComplete,
    lagSeconds,
  });
  await upsertBranchAnalyticsRollupState(tx, {
    organizationId: input.organizationId,
    state: nextState,
    sourceWatermarkEventCreatedAt,
    materializedThroughEventCreatedAt,
    asOf: input.now,
    lagSeconds,
    backfillCompletedAt: backfillComplete ? input.now : null,
    receivedReconciledThrough:
      sessionRefreshBatch.length < sessionLimit ? input.now : null,
  });
  return {
    organizationId: input.organizationId,
    sessionsRefreshed: sessionArtifactIds.length,
    deletedRows: Number(purgedRows) + sessionRefresh.deletedRows,
    upsertedRows: sessionRefresh.upsertedRows,
    complete: backfillComplete,
    lagSeconds,
    sourceWatermarkEventCreatedAt,
    materializedThroughEventCreatedAt,
  };
}

async function readMaterializedBranchEventAggregatesWithSpan(
  db: BranchAnalyticsRollupReadClient,
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: BranchAnalyticsRollupDateWindow | undefined,
  now: Date
): Promise<BranchAnalyticsRollupReadResult> {
  const state = await readBranchAnalyticsRollupState(db, organizationId);
  const availability = evaluateRollupAvailability(state, now);
  setRollupAvailabilitySpanAttributes(availability, state, now);
  if (availability.status === BranchAnalyticsRollupReadStatus.Unavailable) {
    return availability;
  }
  const windowed = Boolean(dateWindow?.startDate || dateWindow?.endDate);
  // `state.asOf` is non-null on every Available path — `evaluateRollupAvailability`
  // refuses a missing one as `stale_clock` — but neither the completeness gate
  // nor the edge read below can be pinned to a clock the types say might be
  // absent.
  const asOf = state?.asOf;
  const windowPlan =
    windowed && dateWindow && asOf
      ? planBranchAnalyticsRollupWindow(dateWindow)
      : undefined;
  if (windowed && !windowPlan) {
    const result = unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.DateWindowUnsupported,
      state
    );
    setRollupAvailabilitySpanAttributes(result, state, now);
    return result;
  }
  const incompleteSessions = asOf
    ? await selectIncompleteMaterializedSessions(db, {
        organizationId,
        sessionIds,
        asOf,
      })
    : [];
  if (incompleteSessions.length > 0) {
    const result = unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      state
    );
    setRollupAvailabilitySpanAttributes(result, state, now);
    setAppSpanAttributes({
      "branches.analytics.rollup.read.incomplete_session_count":
        incompleteSessions.length,
    });
    return result;
  }
  const rows = await db.$queryRaw<BranchAnalyticsRollupAggregateRow[]>(
    Prisma.sql`
      WITH requested_sessions AS MATERIALIZED (
        SELECT DISTINCT unnest(
          ARRAY[${Prisma.join(sessionIds)}]::uuid[]
        ) AS id
      ),
      deduplicated_buckets AS MATERIALIZED (
        ${branchAnalyticsRollupBucketPartsSql(organizationId, windowPlan)}
        ${
          windowPlan && asOf
            ? branchAnalyticsRollupEdgePartsSql(
                organizationId,
                windowPlan,
                asOf
              )
            : Prisma.empty
        }
      )
      SELECT
        bucket."agentSessionId",
        SUM(bucket.input_tokens) AS "sumInputTokens",
        SUM(bucket.output_tokens) AS "sumOutputTokens",
        SUM(bucket.cache_read_tokens) AS "sumCacheReadTokens",
        SUM(bucket.cache_write_tokens) AS "sumCacheWriteTokens",
        SUM(bucket.estimated_cost) AS "sumEstimatedCost",
        MIN(bucket.min_input_tokens) AS "minInputTokens",
        MIN(bucket.min_output_tokens) AS "minOutputTokens",
        MIN(bucket.min_cache_read_tokens) AS "minCacheReadTokens",
        MIN(bucket.min_cache_write_tokens) AS "minCacheWriteTokens",
        MIN(bucket.min_estimated_cost) AS "minEstimatedCost",
        SUM(bucket.estimated_cost_event_count) AS "estimatedCostCount",
        SUM(bucket.event_count) AS "eventCount"
      FROM deduplicated_buckets bucket
      GROUP BY bucket."agentSessionId"
    `
  );
  setAppSpanAttributes({
    "branches.analytics.rollup.read.available": true,
    "branches.analytics.rollup.read.row_count": rows.length,
    "branches.analytics.rollup.read.windowed": windowed,
    // How many partial days this answer had to read from the source. 0 is the
    // pure fast path; ISS-9831 measured 742 of 743 production windows landing
    // there, so a rising value means a caller stopped sending day-aligned bounds.
    "branches.analytics.rollup.read.window_edge_ranges":
      (windowPlan?.headRange ? 1 : 0) + (windowPlan?.tailRange ? 1 : 0),
  });
  return { status: BranchAnalyticsRollupReadStatus.Available, rows };
}

async function readBranchAnalyticsRollupState(
  db: BranchAnalyticsRollupReadClient,
  organizationId: string
): Promise<BranchAnalyticsRollupStateRow | undefined> {
  const rows = await db.$queryRaw<BranchAnalyticsRollupStateRow[]>(Prisma.sql`
    SELECT
      organization_id AS "organizationId",
      state,
      source_watermark_event_created_at AS "sourceWatermarkEventCreatedAt",
      materialized_through_event_created_at AS "materializedThroughEventCreatedAt",
      as_of AS "asOf",
      lag_seconds AS "lagSeconds",
      backfill_completed_at AS "backfillCompletedAt"
    FROM branch_analytics_rollup_states
    WHERE organization_id = ${organizationId}::uuid
  `);
  return rows.at(0);
}

/**
 * ISS-10079. The two classes this selects over are ordered SEPARATELY and then
 * interleaved by rank, because any single merged sequence hands one class the
 * whole page whenever that class outnumbers the bound.
 *
 * What shipped before was a `LEFT JOIN` back to the state table under
 * `ORDER BY state.as_of ASC NULLS FIRST`. An organization with no state row
 * joins to a NULL `as_of`, so every never-rolled-up organization sorted ahead
 * of every organization that carries state — permanently, at any limit.
 * Measured 2026-09-11: 150 never-rolled-up organizations against the default
 * bound of 100 selected zero state-carrying organizations, so their rollups
 * stopped advancing while the cron reported a full batch of healthy work every
 * run. Raising `organizationLimit` only admits more of the same class first.
 *
 * `NULLS LAST` would only invert the starvation — a brand-new organization
 * genuinely needs its first rollup, and until it lands every `/branches` read
 * of it takes the unavailable path. `COALESCE(as_of, created_at)` mixes two
 * clocks ("last refreshed" against "has existed since"), so an organization
 * created two years ago and never rolled up still outranks everything; the
 * population the bug was measured on is exactly that one.
 *
 * So each class keeps its own ordering and gets a reserved share of the bound:
 * rank 1 of each class, then rank 2 of each, and so on. Neither can starve the
 * other at any population size, and a class with fewer rows than its share
 * spends nothing — its ranks simply run out and the other class fills the rest.
 * The classes are disjoint by construction (one requires a state row, the other
 * requires its absence), so `UNION ALL` needs no dedupe.
 *
 * The deeper alternative is to stop modelling "never rolled up" as the ABSENCE
 * of a state row at all — `Organization.githubRepoSyncBootstrapAttemptedAt`
 * (ISS-6590) claims a row before each pass for exactly this reason, and a
 * rollup state row seeded at organization creation would collapse both classes
 * into one `ORDER BY as_of ASC`. It is not done here because that row's absence
 * is load-bearing on the READ side — it is what makes a brand-new organization
 * report `missing` rather than `pending` — so it is a migration, a backfill,
 * and a user-visible reason change, not a selection fix.
 *
 * ponytail: at a bound of 1 the interleave degenerates and the due class takes
 * the only slot. Production runs the default bound of 100 and every bound >= 2
 * gives both classes a slot, so this stays a documented floor rather than a
 * run-to-run rotation nobody can reason about.
 */
function selectDueBranchAnalyticsRollupOrganizations(
  now: Date,
  limit: number
): Promise<BranchAnalyticsRollupOrganizationRow[]> {
  const staleBefore = new Date(
    now.getTime() - BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS
  );
  return withDb((db) =>
    db.$queryRaw<BranchAnalyticsRollupOrganizationRow[]>(Prisma.sql`
      WITH due_state_organizations AS MATERIALIZED (
        -- ISS-10565: a failed refresh leaves as_of on the last good pass, so
        -- its failure time orders it, or it would lead every run that follows.
        SELECT
          state.organization_id,
          state.as_of,
          GREATEST(state.as_of, state.last_error_at) AS last_attempt_at
        FROM branch_analytics_rollup_states state
        WHERE state.state <> ${BranchAnalyticsRollupState.Fresh}
          OR state.backfill_completed_at IS NULL
          OR state.as_of IS NULL
          OR state.as_of < ${staleBefore}
          OR state.lag_seconds IS NULL
          OR state.lag_seconds > ${BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_SECONDS}
        ORDER BY last_attempt_at ASC NULLS FIRST, state.organization_id ASC
        LIMIT ${limit}
      ),
      new_state_organizations AS MATERIALIZED (
        SELECT organization.id AS organization_id, organization.created_at
        FROM organizations organization
        WHERE NOT EXISTS (
          SELECT 1
          FROM branch_analytics_rollup_states state
          WHERE state.organization_id = organization.id
        )
        ORDER BY organization.created_at ASC, organization.id ASC
        LIMIT ${limit}
      ),
      ranked_organizations AS (
        -- NULLS FIRST is deliberate and confined to this class: a state row
        -- with no attempt is the most urgent organization that HAS state, and
        -- the class as a whole is guaranteed its share regardless.
        SELECT
          organization_id,
          as_of,
          TRUE AS has_rollup_state,
          0 AS class_order,
          ROW_NUMBER() OVER (
            ORDER BY last_attempt_at ASC NULLS FIRST, organization_id ASC
          ) AS class_rank
        FROM due_state_organizations
        UNION ALL
        SELECT
          organization_id,
          NULL::timestamp AS as_of,
          FALSE AS has_rollup_state,
          1 AS class_order,
          ROW_NUMBER() OVER (
            ORDER BY created_at ASC, organization_id ASC
          ) AS class_rank
        FROM new_state_organizations
      )
      SELECT
        organization_id AS "organizationId",
        as_of AS "asOf",
        has_rollup_state AS "hasRollupState"
      FROM ranked_organizations
      ORDER BY class_rank ASC, class_order ASC, organization_id ASC
      LIMIT ${limit}
    `)
  );
}

async function readMaterializedThroughEventCreatedAt(
  tx: BranchAnalyticsRollupReadClient,
  organizationId: string
): Promise<Date | null> {
  const rows = await tx.$queryRaw<
    {
      materializedThroughEventCreatedAt: Date | null;
    }[]
  >(Prisma.sql`
    SELECT MAX(source_max_event_created_at) AS "materializedThroughEventCreatedAt"
    FROM branch_analytics_session_rollups
    WHERE organization_id = ${organizationId}::uuid
      AND source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
  `);
  return rows.at(0)?.materializedThroughEventCreatedAt ?? null;
}

function evaluateRollupAvailability(
  state: BranchAnalyticsRollupStateRow | undefined,
  now: Date
): BranchAnalyticsRollupReadResult {
  if (!state) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.Missing
    );
  }
  if (state.state === BranchAnalyticsRollupState.Error) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.StateError,
      state
    );
  }
  if (state.state === BranchAnalyticsRollupState.Pending) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.BackfillIncomplete,
      state
    );
  }
  if (state.state === BranchAnalyticsRollupState.Stale) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.LagExceeded,
      state
    );
  }
  if (state.state !== BranchAnalyticsRollupState.Fresh) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.StateError,
      state
    );
  }
  if (!state.backfillCompletedAt) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.BackfillIncomplete,
      state
    );
  }
  if (!state.asOf || state.asOf.getTime() < rollupStalenessFloor(now)) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.StaleClock,
      state
    );
  }
  const lagSeconds = normalizeLagSeconds(state.lagSeconds);
  if (lagSeconds === undefined) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.LagUnknown,
      state
    );
  }
  if (lagSeconds > BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_SECONDS) {
    return unavailableRollupRead(
      BranchAnalyticsRollupUnavailableReason.LagExceeded,
      state
    );
  }
  return { status: BranchAnalyticsRollupReadStatus.Available, rows: [] };
}

function unavailableRollupRead(
  reason: BranchAnalyticsRollupUnavailableReason,
  state?: BranchAnalyticsRollupStateRow
): BranchAnalyticsRollupReadResult {
  return {
    status: BranchAnalyticsRollupReadStatus.Unavailable,
    reason,
    ...(state ? { state } : {}),
  };
}

function setRollupAvailabilitySpanAttributes(
  result: BranchAnalyticsRollupReadResult,
  state: BranchAnalyticsRollupStateRow | undefined,
  now: Date
): void {
  const lagSeconds = normalizeLagSeconds(state?.lagSeconds);
  const attributes: Record<string, string | number | boolean> = {
    "branches.analytics.rollup.read.available":
      result.status === BranchAnalyticsRollupReadStatus.Available,
  };
  if (result.status === BranchAnalyticsRollupReadStatus.Unavailable) {
    attributes["branches.analytics.rollup.read.unavailable_reason"] =
      result.reason;
  }
  if (lagSeconds !== undefined) {
    attributes["branches.analytics.rollup.read.lag_seconds"] = lagSeconds;
  }
  if (state?.asOf) {
    attributes["branches.analytics.rollup.read.as_of_age_ms"] =
      now.getTime() - state.asOf.getTime();
  }
  setAppSpanAttributes(attributes);
}

function resolveNextRollupState(input: {
  backfillComplete: boolean;
  lagSeconds: number | null;
}): BranchAnalyticsRollupState {
  if (!input.backfillComplete) {
    return BranchAnalyticsRollupState.Pending;
  }
  if (input.lagSeconds === null) {
    return BranchAnalyticsRollupState.Stale;
  }
  if (input.lagSeconds <= BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_SECONDS) {
    return BranchAnalyticsRollupState.Fresh;
  }
  return BranchAnalyticsRollupState.Stale;
}

function calculateRollupLagSeconds(
  sourceWatermarkEventCreatedAt: Date | null,
  materializedThroughEventCreatedAt: Date | null
): number | null {
  if (!sourceWatermarkEventCreatedAt) {
    return 0;
  }
  if (!materializedThroughEventCreatedAt) {
    return null;
  }
  const lagMs =
    sourceWatermarkEventCreatedAt.getTime() -
    materializedThroughEventCreatedAt.getTime();
  return Math.max(0, Math.ceil(lagMs / 1000));
}

function normalizeLagSeconds(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return;
    }
    return value >= 0n ? Number(value) : undefined;
  }
  if (Number.isInteger(value) && Number(value) >= 0) {
    return Number(value);
  }
}

function normalizeLimit(
  value: number | undefined,
  maximum: number,
  fallback: number
): number {
  if (!Number.isSafeInteger(value)) {
    return fallback;
  }
  const safeValue = Number(value);
  return Math.min(maximum, Math.max(1, safeValue));
}

function distinctValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function recordBranchAnalyticsRollupFailureBestEffort(
  organizationId: string,
  error: unknown,
  now: Date
): Promise<void> {
  try {
    await recordBranchAnalyticsRollupFailure(organizationId, error, now);
  } catch {
    setAppSpanAttributes({
      "branches.analytics.rollup.refresh.failure_record_failed": true,
    });
  }
}

function rollupStalenessFloor(now: Date): number {
  return now.getTime() - BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS;
}

function summarizeDueRefresh(
  input: DueRefreshSummaryInput
): BranchAnalyticsRollupDueSummary {
  const { summaries } = input;
  let sessionsRefreshed = 0;
  let upsertedRows = 0;
  let completeOrganizations = 0;
  let incompleteOrganizations = 0;
  let maxLagSeconds: number | null = null;
  for (const summary of summaries) {
    sessionsRefreshed += summary.sessionsRefreshed;
    upsertedRows += summary.upsertedRows;
    if (summary.complete) {
      completeOrganizations += 1;
    } else {
      incompleteOrganizations += 1;
    }
    if (summary.lagSeconds !== null) {
      maxLagSeconds = Math.max(maxLagSeconds ?? 0, summary.lagSeconds);
    }
  }
  return {
    organizations: input.organizations,
    batches: summaries.length,
    sessionsRefreshed,
    upsertedRows,
    completeOrganizations,
    incompleteOrganizations,
    failedOrganizations: input.failedOrganizations,
    failureCategories: input.failureCategories,
    failures: input.failures,
    maxLagSeconds,
    organizationLimitReached: input.organizationLimitReached,
    budgetExhausted: input.budgetExhausted,
    oldestDueAsOfAgeMs: input.backlog.oldestDueAsOfAgeMs,
    neverRolledUpOrganizations: input.backlog.neverRolledUpOrganizations,
  };
}

/**
 * ISS-10079's other half: a starved run already reported
 * `organizationLimitReached`, which says a page was truncated and never which
 * class it was truncated in favour of — so reaching no state-carrying
 * organization at all looked like any other busy run. The selection
 * orders the state-carrying class oldest-cursor-first and always reserves it a
 * share of the page, so the oldest cursor IN the page is the oldest cursor
 * there is — which makes this a free read of how far behind the sweep's oldest
 * work has fallen, with no second query and no row projection paid for a number.
 * The one exception is an organization whose refresh failed since its cursor
 * (ordered by that failure, ISS-10565) and that a truncated page left out.
 */
function measureDueSelectionBacklog(
  organizations: readonly BranchAnalyticsRollupOrganizationRow[],
  now: Date
): DueSelectionBacklog {
  let oldestAsOfMs: number | null = null;
  let neverRolledUpOrganizations = 0;
  for (const organization of organizations) {
    if (!organization.hasRollupState) {
      neverRolledUpOrganizations += 1;
      continue;
    }
    const asOfMs = organization.asOf?.getTime();
    // A state row with no `as_of` is due and urgent but carries no age, and a
    // cursor dated after `now` is a clock that cannot be reconciled — neither
    // is an age, and reporting either as one would be a fabricated measurement.
    if (
      asOfMs === undefined ||
      !Number.isFinite(asOfMs) ||
      asOfMs > now.getTime()
    ) {
      continue;
    }
    if (oldestAsOfMs === null || asOfMs < oldestAsOfMs) {
      oldestAsOfMs = asOfMs;
    }
  }
  return {
    neverRolledUpOrganizations,
    oldestDueAsOfAgeMs:
      oldestAsOfMs === null ? null : now.getTime() - oldestAsOfMs,
  };
}

const BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_SECONDS =
  BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS / 1000;
/**
 * Sessions refreshed per organization visit. Bounds the transaction: each one
 * is re-aggregated in full, so this is the ceiling on a single write. Sized so
 * a whole-organization re-materialization (a desktop re-sync of every session)
 * drains in a few hours at the cron's visit rate, rather than putting an
 * organization's entire session population in one transaction.
 *
 * ISS-9831: 2,000 did NOT bound it below that ceiling, and every `state_error`
 * read was the consequence. Refresh runs failing `prisma_P2028` lasted 69.8s to
 * 99.8s against `BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS` of 60s — the
 * transaction was closed under the batch, not refused a connection. At the
 * ~35-50ms per session that implies, 500 lands a visit near 25s even with the
 * daily re-grain's extra rows, and the largest organization (12,221 sessions on
 * 2026-10-20, ISS-12779) drains a full re-materialization in 25 visits.
 */
const BRANCH_ANALYTICS_ROLLUP_DEFAULT_SESSION_LIMIT = 500;
const BRANCH_ANALYTICS_ROLLUP_MAX_SESSION_LIMIT = 50_000;
/**
 * Every due organization must be visited each run or `as_of` ages past
 * `BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS` and healthy rollups read as stale
 * (ISS-9831: 77 organizations at 10 per run gave a 38.5-minute revisit against
 * a 15-minute ceiling). `organizationLimitReached` on the summary reports when
 * this bound truncated the run.
 */
const BRANCH_ANALYTICS_ROLLUP_DEFAULT_ORGANIZATION_LIMIT = 100;
const BRANCH_ANALYTICS_ROLLUP_MAX_ORGANIZATION_LIMIT = 500;
/**
 * Wall-clock ceiling on one cron invocation. This is a START gate — it stops the
 * loop from BEGINNING another organization — so the run's worst case is this
 * budget plus one whole organization refresh. That refresh's own ceiling is
 * `BRANCH_ANALYTICS_ROLLUP_TX_MAX_WAIT_MS` (waiting for a connection) plus
 * `BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS` (holding the transaction) — 70s — so
 * an organization admitted at 179.9s can still return by 250s, inside the
 * route's `maxDuration` of 300s with the response and its log flush to spare.
 * Without it a slow organization early in the page spends the whole route
 * budget and the run dies mid-page instead of reporting what it skipped.
 */
const BRANCH_ANALYTICS_ROLLUP_DUE_BUDGET_MS = 180_000;
const BRANCH_ANALYTICS_ROLLUP_TX_MAX_WAIT_MS = 10_000;
const BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS = 60_000;
/** Failed organizations named per run, so a mass failure cannot emit an unbounded list. */
const BRANCH_ANALYTICS_ROLLUP_REPORTED_FAILURE_LIMIT = 10;

/** How far behind the sweep's oldest selected work is, measured once per run. */
type DueSelectionBacklog = {
  oldestDueAsOfAgeMs: number | null;
  neverRolledUpOrganizations: number;
};

type DueRefreshSummaryInput = {
  backlog: DueSelectionBacklog;
  budgetExhausted: boolean;
  failedOrganizations: number;
  failureCategories: BranchAnalyticsRollupFailureCategory[];
  failures: BranchAnalyticsRollupOrganizationFailure[];
  organizationLimitReached: boolean;
  organizations: number;
  summaries: readonly BranchAnalyticsRollupBatchSummary[];
};
