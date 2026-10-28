import { FRUSTRATION_SCORE_VERSION } from "@repo/api/src/frustration-score-contract";
import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import type {
  LocalArtifactSessionUsage,
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  deriveBranchParticipationFromEvidence,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  REPOSITORY_FULL_NAME_MAX_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/lib/session-trace/derivation";
import { isMeteredApi } from "../../shared/billing-mode.js";
import {
  computeFrustrationRaw,
  deriveFrustrationInput,
} from "../../shared/frustration-score.js";
import type {
  resolveSessionAttribution,
  SessionAttributionResolverCache,
} from "../agent-sync/agent-session-attribution.js";
import type {
  AgentSessionAnalyticsAgentTypeGroup,
  AgentSessionAnalyticsAggregate,
  AgentSessionAnalyticsToolGroup,
  AgentSessionCountFilters,
  AgentSessionUsageAggregate,
  AgentSessionUsageAggregateFilters,
  RepositoryScopedSessionIdsOptions,
  SessionCursorRow,
  SessionListCursorPage,
  SessionListCursorPageRequest,
} from "../agent-sync/agent-session-read-model.js";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
} from "../agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SyncedSessionLoadOptions,
} from "../agent-sync/agent-session-sync-source.js";
import {
  resolveBillingModeForRow,
  resolveTokenUsageCostUsd,
} from "../agent-sync/agent-session-token-cost-resolution.js";
import {
  parseJsonObjectText,
  parseJsonValueText,
} from "../agent-sync/agent-sync-json-text.js";
import { createAttributionYieldCadence } from "../agent-sync/attribution-path-memo.js";
import {
  deriveSessionLastActivityAt,
  resolveSessionLastActivityAt,
} from "../agent-sync/session-date-window.js";
import { resolveBillingMode } from "../cost/billing-mode-detector.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { addStorageTokenCounts } from "../cost/token-counts.js";
import {
  buildArtifactSessionMarkers,
  mergeSessionMarkers,
} from "../session/session-artifact-markers.js";
import { LocalReadFailedRead } from "../telemetry/local-read-failed-diagnostics.js";
import { aggregateReadFailure } from "./aggregate-read-failure.js";
import { boundNonCommitArtifactRefs } from "./artifact-ref-budget.js";
import {
  branchLifecycleEventsForPersistedBranchLink,
  branchLifecycleEventsForPersistedPrLink,
} from "./branch-lifecycle-events.js";
import {
  createComponentSyncReaders,
  selectComponentUsageRows,
} from "./component-sync-source.js";
import { buildSessionComponentUsageField } from "./component-usage-budget.js";
import { SESSION_STARTED_AT_BOUNDS_EXPR } from "./db-constants.js";
import {
  localTimeZone,
  tokenCountValue,
  toolInvocationPredicate,
} from "./db-helpers.js";
import { throwIfStoreReadCancelled } from "./db-host/store-read-cancellation.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type {
  SqliteAgentRow,
  SqliteArtifactLinkRow,
  SqliteComponentUsageRow,
  SqliteEventRow,
  SqlitePullRequestLifecycleRow,
  SqlitePullRequestRow,
  SqliteSessionAnalyticsRow,
  SqliteSessionRow,
  SqliteTokenEventRow,
  SqliteTokenUsageRow,
} from "./db-row-types.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "./prisma-client.js";
import {
  resolveAnalyticsRepositoryGroups,
  resolveRepositoryFullNameStoredFirst,
} from "./repository-facet.js";
import { countSqliteSessionsForFilters } from "./session-aggregate-filters.js";
import {
  ANALYTICS_EVENT_ERROR_PREDICATE,
  analyticsIsoMsExpr,
} from "./session-analytics-sql.js";
import { readSqliteSessionCompactFilterCapabilities } from "./session-compact-filter-capabilities.js";
import { createSessionDetailLinkReaders } from "./session-detail-link-reads.js";
import {
  groupRowsBySessionId,
  selectRowsByIds,
} from "./session-detail-mappers.js";
import { createSessionDetailReaders } from "./session-detail-reads.js";
import { createSessionEventPageReader } from "./session-event-page-read.js";
import { listSqliteSessionCursorPage } from "./session-list-cursor-read.js";
import { readSessionListProjection } from "./session-list-projection-read.js";
import { readNarrowedUsageRows } from "./session-narrowed-usage-query.js";
import { invalidSessionCostAggregateSql } from "./session-quality-sql.js";
import { listSqliteRepositoryScopedSessionIds } from "./session-repository-scoped-reads.js";
import {
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  resolveTraceEndMs,
} from "./session-trace.js";
import { resolveArtifactLinkBranch } from "./session-trace-branch-resolution.js";
import type {
  UsageBoundsRow,
  UsageHarnessCountRow,
  UsageModelCountRow,
  UsageRepoCountRow,
  UsageTokenGroupRow,
  UsageUserCountRow,
} from "./session-usage-aggregate.js";
import { foldSqliteUsageAggregate } from "./session-usage-aggregate.js";
import { readResolvedUsageSnapshot } from "./session-usage-filter-resolution.js";
import { selectViewedSessionIds } from "./session-viewership-store.js";
import { assertValidSessionWorkOperands } from "./session-work-operand-validation.js";
import {
  persistResolvedRepoFullNames,
  type RepoFullNameWriteBack,
  resolveSyncAttributions,
} from "./sync-attribution-resolution.js";
import { createSyncBurndownReaders } from "./sync-burndown-store.js";
import { createSyncDeliveryStateDelegates } from "./sync-delivery-state-delegates.js";
import {
  type ActivitySegmentReadBounds,
  resolveEventRowFetchLimit,
  type SyncedSegmentQueryRow,
  selectBoundedActivitySegments,
  selectEventRows,
} from "./sync-source-bounded-reads.js";
import { persistLocalFrustration } from "./sync-source-frustration-writeback.js";
import {
  branchRefPriorityField,
  resolveLinkObservedAt,
} from "./sync-source-link-fields.js";
import { toArtifactRefRelation } from "./sync-source-link-relation.js";
import { attachOperationEvidence } from "./sync-source-operation-evidence.js";
import {
  indexActivityMetrics,
  readActivityMetrics,
  readArtifactLinkRows,
  readPullRequestLifecycleRows,
  readPullRequestRows,
  readSessionAnalyticsRows,
  type SqliteSessionActivityMetricsRow,
  syncedActivityMetricsField,
} from "./sync-source-rollup-reads.js";
import {
  groupSegmentsBySessionId,
  resolveSyncedSessionTiling,
} from "./sync-source-segment-rows.js";
import {
  mapSyncedSessionAnalytics,
  resolveSyncedSessionCostUsd,
} from "./sync-source-session-analytics.js";
import {
  authoritativeCostPatch,
  componentInvocationCountPatch,
} from "./sync-source-session-patches.js";
import {
  findSqliteExistingSessionIds,
  findSqliteLocallyOversizedSessions,
  selectSessionRows,
  sqliteFlagToNullableBoolean,
  toSyncedSessionHead,
} from "./sync-source-session-rows.js";
import {
  selectInvocationCountRows,
  selectTokenUsageRows,
} from "./sync-source-usage-rows.js";
import { buildCommitArtifactRef } from "./synced-commit-ref.js";
import {
  downgradeMonitoredSessionActivity,
  monitoredActivityOnlyRefsFromMetadata,
  monitoredSessionActivityFromEvidence,
  withoutMonitoredActivityOnlyMetadata,
} from "./synced-monitored-session-activity.js";
import {
  boundedWireString,
  buildPullRequestArtifactRefFacts,
  buildSyncedSessionPrRef,
} from "./synced-pull-request-ref.js";
import {
  chunkIds,
  planSyncedSessionHydration,
  SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
} from "./synced-session-hydration-plan.js";
import { selectTokenEventRows } from "./token-event-columns.js";
import { mapSyncedTokenEvent } from "./token-event-sync.js";
import { mapTraceTokenEvents } from "./trace-token-event-mapper.js";

export function createSqliteSessionSyncSource(
  prisma: DesktopPrisma,
  // FEA-3568: the desktop diagnostic sink (openSqliteAgentDatabase's `options.log`)
  // so the sync assembly can surface an over-cap activity-segment truncation.
  log: (message: string) => void = () => {
    // no-op default so existing/test call sites need no change
  },
  // ISS-9865: the segment read's row thresholds, defaulted to the production
  // constants. Parameterized at the FACTORY (not on `SyncedSessionLoadOptions`,
  // which is a per-call shape production callers share) so the refusal at the
  // absolute ceiling can be driven through this whole lane — read, strip stamp,
  // chunker, ack — by a suite that seeds a handful of rows instead of half a
  // million. Production passes nothing.
  activitySegmentReadBounds?: ActivitySegmentReadBounds
): AgentSessionSyncSource {
  const source: AgentSessionSyncSource = {
    readSessionCompactFilterCapabilities: () =>
      readSqliteSessionCompactFilterCapabilities(prisma),
    // ISS-5387: the aggregate, read-only burn-down reads. Kept in their own
    // module so this grandfathered file carries the wiring only.
    ...createSyncBurndownReaders(prisma),
    // ISS-5567 / ISS-5617: the session-scoped LINK reads the session detail
    // needs — its branch artifact, and its unbounded document links.
    ...createSessionDetailLinkReaders(prisma),
    // ISS-9857: the whole-run counts and token cost points the detail reads
    // beside its bounded prefix, and the keyset events page past it.
    ...createSessionDetailReaders(prisma),
    ...createSessionEventPageReader(prisma),
    async listAllSessionCursorRows(): Promise<SessionCursorRow[]> {
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(`
        SELECT id, updated_at
        FROM sessions
        ORDER BY updated_at DESC, id DESC
      `)
      );
    },
    // ISS-4535 (@whitlockk) / ISS-4558: the pre-hydration Repository-facet id read,
    // extracted to `session-repository-scoped-reads.ts` (this file is
    // shrink-only grandfathered) — same delegation shape as
    // `listSessionCursorPage` below.
    async listRepositoryScopedSessionIds(
      repositories: readonly string[],
      cache: SessionAttributionResolverCache,
      options?: RepositoryScopedSessionIdsOptions
    ): Promise<string[]> {
      return await listSqliteRepositoryScopedSessionIds(
        prisma,
        repositories,
        cache,
        options
      );
    },
    async listSessionCursorPage(
      request: SessionListCursorPageRequest
    ): Promise<SessionListCursorPage> {
      // FEA-2036 (SQLite): the PGlite-era storage-corruption recovery wrapper was
      // dropped in the SQLite migration; libSQL surfaces its own errors and the
      // db-host auto-restarts, so the read runs directly.
      return listSqliteSessionCursorPage(prisma, request);
    },
    async projectSessionList(input) {
      return readSessionListProjection(prisma, source, input);
    },
    async listTopSessionCursorRows(): Promise<SessionCursorRow[]> {
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(`
        WITH top_cursor AS (
          SELECT updated_at
          FROM sessions
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )
        SELECT id, updated_at
        FROM sessions
        WHERE updated_at = (SELECT updated_at FROM top_cursor)
        ORDER BY updated_at DESC, id DESC
      `)
      );
    },
    // Sync selection is driven by `sessions.updated_at` (the FEA-1962 cursor
    // watermark). This also carries branch/PR artifact-ref changes (FEA-2729):
    // link writes happen inside importSession, which bumps updated_at in the
    // same pass (see the SYNC INVARIANT in write-core.ts), so a session whose
    // refs changed is re-selected here. A dedicated per-kind ref cursor is
    // therefore redundant under the current whole-session sync model; it would
    // only be needed if links were ever written outside importSession.
    //
    // PRD-536 E1: the incremental scan advances past everything strictly newer
    // than the watermark timestamp, PLUS re-reads the tied-top-timestamp cluster
    // while EXCLUDING the exact set of ids already observed at that timestamp —
    // rather than the previous `updated_at >= $1` watermark (which re-read the
    // WHOLE top cluster every tick, then filtered it back out in JS) OR a naive
    // `(updated_at, id) > ($1, $2)` id-boundary (which silently SKIPPED a
    // genuinely-new sibling row landing at the SAME top `updated_at` with an id
    // sorting BELOW the highest already-seen id — data loss: `id > $2` excludes
    // it forever, and `updated_at` is NOT guaranteed strictly greater for a new
    // row, e.g. two writes landing in the same millisecond).
    //
    // The predicate is `updated_at > $1 OR (updated_at = $1 AND id NOT IN
    // (<observed ids>))`. The exclusion set is the durable
    // `observedIdsAtTopUpdatedAt` — the exact ids already accepted at the top
    // timestamp — so a NEW lower-id sibling at that timestamp IS selected
    // (correctness) while already-seen ids are excluded (so the seen top cluster
    // is not needlessly re-emitted — the keyset perf win is preserved: only the
    // small tied-top cluster is re-read, never the whole corpus). An EMPTY
    // observed set re-selects the whole tied-top group (nothing to exclude),
    // which the outbox + server idempotently dedupe.
    //
    // Safe because every import writer advances `sessions.updated_at` STRICTLY
    // FORWARD past the row's current value rather than assigning the pass's `now`
    // (ISS-8871; `sessionSyncWatermarkTarget` owns it and documents the
    // no-orderable-successor decline). `now` alone would let a stale tie take a
    // no-op write and stay unselectable inside the observed id set. Changed rows
    // land at `updated_at > cursorTs`; disjunct 2 rescues a NEW top-sharing row.
    async listUpdatedSessionCursorRows(
      sinceUpdatedAt: string,
      observedTopIds: readonly string[]
    ): Promise<SessionCursorRow[]> {
      // SQLite has no array-parameter / `= ANY(...)` form, so the exclusion set
      // is expanded to positional placeholders (`$2, $3, …`) and threaded as
      // individual params (the `__IDS__`-expansion convention this file uses
      // elsewhere). An EMPTY set omits the `NOT IN` term entirely — SQLite
      // rejects `NOT IN ()` — so the whole tied-top group is re-selected and the
      // caller's `previousTopIds` JS filter dedupes it.
      const exclusionClause =
        observedTopIds.length > 0
          ? `AND id NOT IN (${observedTopIds
              .map((_, index) => `$${index + 2}`)
              .join(", ")})`
          : "";
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(
          `
          SELECT id, updated_at
          FROM sessions
          WHERE updated_at > $1
             OR (updated_at = $1 ${exclusionClause})
          ORDER BY updated_at DESC, id DESC
        `,
          sinceUpdatedAt,
          ...observedTopIds
        )
      );
    },
    async loadSyncedSessions(
      ids: string[],
      cache: SessionAttributionResolverCache,
      options?: SyncedSessionLoadOptions
    ): Promise<SyncedAgentSession[]> {
      const sessions = await loadSqliteSyncedSessions(
        prisma,
        ids,
        cache,
        options,
        log,
        activitySegmentReadBounds
      );
      // FEA-4022: cache the sync-time frustration signal back into the local
      // `sessions` column so the desktop's own surfaces can read it without
      // recomputing, and a resync does not have to re-derive it. Best-effort:
      // the authoritative value already rides in the returned payload, so a
      // write-back failure must not fail the sync.
      if (!options?.readOnly) {
        await persistLocalFrustration(prisma, sessions).catch(() => {
          // Non-fatal — the payload still carries the computed value.
        });
      }
      return sessions;
    },
    /**
     * ISS-6031: the existence probe the sync lane uses before it may conclude a
     * queued session is gone. Deliberately the narrowest read in this module —
     * `SELECT id FROM sessions` and nothing else — so it can still answer when
     * the full hydration above cannot.
     */
    findExistingSessionIds(ids: string[]): Promise<string[]> {
      return findSqliteExistingSessionIds(prisma, ids);
    },
    async findLocallyOversizedSessions(
      ids: string[],
      maxBytes: number
    ): Promise<{ id: string; payloadBytes: number }[]> {
      return findSqliteLocallyOversizedSessions(prisma, ids, maxBytes);
    },
    /**
     * FEA-1834: lightweight load for the usage summary — session metadata +
     * tokenUsageByModel only (no agents/events/token_events/artifact_links/
     * attribution). Folds identically in `buildUsageSummary`; far cheaper to
     * re-run on the live cadence as the corpus grows.
     */
    async loadUsageSessions(ids: string[]): Promise<SyncedAgentSession[]> {
      return loadSqliteUsageSessions(prisma, ids);
    },
    /**
     * FEA-1834 / PLN-941 §4: O(grouped) usage aggregation. Two grouped queries
     * (token SUM/COUNT by billing_mode/harness/model + per-harness session
     * counts) replace hydrating every session, so the summary stays cheap on the
     * live cadence as the corpus grows. The fold lives in
     * `getSharedAgentSessionUsage`.
     *
     * ISS-10573: a failed LOCAL aggregate degrades to the Sessions surface's
     * existing stated-unavailable — `usageError` on the combined page-data read,
     * the sanitized source error on the direct channel — never a raw driver
     * error reaching the handler and never a fabricated zero summary.
     * Cancellation (ISS-9802) and db-host lifecycle failures (ISS-4483 /
     * ISS-5808) are rethrown UNCHANGED, because both are positively classified
     * downstream: replacing either would turn the caller's own abort, or the
     * quiet reconnecting state, into a hard error card.
     */
    async aggregateUsage(
      filters: AgentSessionUsageAggregateFilters
    ): Promise<AgentSessionUsageAggregate> {
      try {
        // FEA-4299: the Repository facet options fold resolves each distinct cwd
        // to its `repositoryFullName`; a fresh per-request attribution cache
        // keeps those lookups consistent within this read (as
        // `aggregateAnalytics` does).
        return await aggregateSqliteUsage(prisma, filters, {
          attributionByCwd: new Map(),
          launchMetadataRootByCwd: new Map(),
          repoFullNameByPath: new Map(),
        });
      } catch (error) {
        throw aggregateReadFailure(
          error,
          LocalReadFailedRead.UsageAggregate,
          log
        );
      }
    },
    /**
     * FEA-4142: metadata-only `COUNT(*)` for the count-only badge read. One
     * grouped SQL read over the `sessions` table replaces hydrating the corpus
     * into JS just to size the list. ISS-6787: migration 0039's
     * `(status, ended_at)` partial index does NOT cover this predicate — see
     * {@link countSqliteSessionsForFilters}.
     */
    countSessions(filters: AgentSessionCountFilters): Promise<number> {
      return countSqliteSessionsForFilters(prisma, filters);
    },
    /**
     * FEA-2038: O(grouped) analytics aggregation. Grouped reads (byTool over
     * events, byAgentType over agents, byRepository over per-cwd token/error
     * rollups) replace hydrating the whole filtered corpus into JS — the db-host
     * OOM (exit code 5). The cwd→repositoryFullName resolution and final fold
     * live in `getSharedAgentSessionAnalytics`; the shared `cache` keeps
     * attribution lookups consistent with the read request.
     *
     * ISS-10606: a failure rejects exactly as `aggregateUsage` does. It used to
     * resolve an empty aggregate, which the caller cannot tell from a store with
     * no sessions.
     */
    async aggregateAnalytics(
      filters: AgentSessionUsageAggregateFilters,
      cache: SessionAttributionResolverCache
    ): Promise<AgentSessionAnalyticsAggregate> {
      try {
        return await aggregateSqliteAnalytics(prisma, filters, cache);
      } catch (error) {
        throw aggregateReadFailure(
          error,
          LocalReadFailedRead.AnalyticsAggregate,
          log
        );
      }
    },
    // FEA-3781: durable delivery state lives beside this module, one delegate
    // slice per table — ./sync-cursor-state.ts (the keyset cursor) with
    // ./sync-lane-run-state.ts (this lane's durable lane run), and
    // ./sync-outbox-store.ts (the per-session outbox). This module builds sync
    // PAYLOADS; what has already been delivered is a separate concern.
    ...createSyncDeliveryStateDelegates(prisma, log),
    // Gap B (#2570 follow-up): expose the component inventory readers on the
    // sync source so the sync service's component lane can batch-read updated
    // `agent_components` and pack them for `POST /desktop/components/sync`.
    ...createComponentSyncReaders(prisma),
  };
  return source;
}

async function aggregateSqliteUsage(
  prisma: DesktopPrisma,
  filters: AgentSessionUsageAggregateFilters,
  cache: SessionAttributionResolverCache
): Promise<AgentSessionUsageAggregate> {
  // ISS-10573: yield before, never inside, the snapshot's wall-clock budget.
  // This also admits cancellation (ISS-9802) and queued reads (FEA-2264).
  await yieldDbHostLoop();

  if (filters.quality && filters.quality !== "all") {
    const rows = await readResolvedUsageSnapshot(
      prisma,
      filters,
      async (snapshot, clause, params, validation) => {
        await assertValidSessionWorkOperands(
          snapshot,
          validation.clause,
          validation.params
        );
        return readNarrowedUsageRows(snapshot, clause, params);
      }
    );
    await yieldDbHostLoop();
    return foldSqliteUsageAggregate(prisma, rows, cache, true);
  }

  // The all-quality fast path keeps its six grouped reads on one reader snapshot.
  // Narrowed quality materializes its costly correlated cohort just once above.
  const {
    tokenRows,
    harnessRows,
    primaryModelRows,
    userRows,
    repoRows,
    boundsRow,
  } = await readResolvedUsageSnapshot(
    prisma,
    filters,
    async (tx, clause, params, validation) => {
      await assertValidSessionWorkOperands(
        tx,
        validation.clause,
        validation.params
      );
      const tokenResult = await tx.$queryRawUnsafe<UsageTokenGroupRow[]>(
        `
        SELECT
          s.billing_mode AS billing_mode,
          s.harness AS harness,
          t.model AS model,
          -- Current and pre-compaction baseline tokens share one usage basis.
          SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)) AS input_tokens,
          SUM(COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)) AS output_tokens,
          SUM(COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0)) AS cache_read_tokens,
          SUM(COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0)) AS cache_write_tokens,
          COUNT(DISTINCT t.session_id) AS session_count,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          ${invalidSessionCostAggregateSql("t.cost_usd_estimated")} AS invalid_estimated_cost,
          -- Reprice unpriced rows on that same effective token basis.
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0) ELSE 0 END) AS unpriced_cache_write_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_1h_tokens, 0) ELSE 0 END) AS unpriced_cache_write_1h_tokens
        FROM token_usage t
        JOIN sessions s ON s.id = t.session_id
        ${clause}
        GROUP BY s.billing_mode, s.harness, t.model
        ORDER BY s.harness, t.model, s.billing_mode
      `,
        ...params
      );

      const harnessResult = await tx.$queryRawUnsafe<UsageHarnessCountRow[]>(
        `
        SELECT s.harness AS harness, COUNT(*) AS session_count
        FROM sessions s
        ${clause}
        GROUP BY s.harness
        ORDER BY s.harness
      `,
        ...params
      );

      // FEA-4303: per-PRIMARY-model session counts. Grouped on the single
      // displayed model `s.model` (the exact value the Sessions table paints in
      // its Model column and the same field the local Model filter predicate
      // matches), NOT the per-token-usage `t.model` in `tokenGroups` (which
      // spans secondary/subagent models). Counted from `sessions` (not
      // `token_usage`) so token-less sessions still count — mirroring the
      // harness/owner counts above. Sources the Model filter facet options so
      // options, predicate, and column share one primary-model vocabulary.
      const primaryModelResult = await tx.$queryRawUnsafe<UsageModelCountRow[]>(
        `
        SELECT s.model AS model, COUNT(*) AS session_count
        FROM sessions s
        ${clause}
        GROUP BY s.model
        ORDER BY s.model
      `,
        ...params
      );

      // ISS-4613: per-owner counts over the SAME all-quality corpus as
      // `totalSessions` and every sibling facet — owner-facet-session-population.test.ts.
      const userResult = await tx.$queryRawUnsafe<UsageUserCountRow[]>(
        `
        SELECT s.user_id AS user_id, COUNT(*) AS session_count
        FROM sessions s
        ${clause}
        GROUP BY s.user_id
        ORDER BY s.user_id
      `,
        ...params
      );

      // FEA-4299: per-(cwd, stored repo) session counts sourcing the Repository
      // facet options. The durable `repo_full_name` column (the FEA-3555
      // write-back cache) is selected so the fold below can fall back to it as
      // the LIST/render path does: the fold resolves the LIVE cwd first and
      // uses the stored repo ONLY when the live worktree lookup fails (e.g. a
      // deleted worktree). Without the stored fallback the facet would drop a
      // repo the row still renders (live returns null) and re-introduce the
      // exact un-filterable divergence. Counted from `sessions` so token-less
      // sessions still contribute their repo option.
      const repoResult = await tx.$queryRawUnsafe<UsageRepoCountRow[]>(
        `
        SELECT s.cwd AS cwd, s.repo_full_name AS repo_full_name, COUNT(*) AS session_count
        FROM sessions s
        ${clause}
        GROUP BY s.cwd, s.repo_full_name
        ORDER BY s.cwd, s.repo_full_name
      `,
        ...params
      );

      // Earliest/latest session start across the same filtered corpus. Uses the
      // NULL-fallback bounds expr (not the epoch-fallback filter expr) so legacy
      // rows with no real start are ignored by MIN/MAX rather than pinning the
      // earliest bound to 1970. Returned as ISO-8601 UTC strings so the JS side
      // never re-parses an ambiguous format; MIN/MAX over zero contributing rows
      // yield NULL → null bounds (graceful empty state).
      const boundsResult = await tx.$queryRawUnsafe<UsageBoundsRow[]>(
        `
        SELECT
          MIN(${SESSION_STARTED_AT_BOUNDS_EXPR}) AS earliest_session_at,
          MAX(${SESSION_STARTED_AT_BOUNDS_EXPR}) AS latest_session_at
        FROM sessions s
        ${clause}
      `,
        ...params
      );

      return {
        tokenRows: tokenResult,
        harnessRows: harnessResult,
        primaryModelRows: primaryModelResult,
        userRows: userResult,
        repoRows: repoResult,
        boundsRow: boundsResult[0] ?? null,
      };
    }
  );

  // ISS-10573: cancellation after the snapshot must precede repo probes and
  // any fill-back for a discarded answer.
  await yieldDbHostLoop();

  return foldSqliteUsageAggregate(
    prisma,
    { tokenRows, harnessRows, primaryModelRows, userRows, repoRows, boundsRow },
    cache,
    filters.quality !== undefined && filters.quality !== "all"
  );
}

/**
 * FEA-2038: O(grouped) analytics aggregation. Runs grouped reads over the SAME
 * filtered session set that `buildUsageFilterClause` selects (reused verbatim
 * so the corpus matches the hydrate filter), then
 * resolves each distinct `cwd` to its attribution via the shared `cache` and
 * merges per-cwd repository rows into their resolved `repositoryFullName` —
 * mirroring `buildAnalytics`'s per-tool / per-agent-type / per-repository fold
 * exactly. No session/event/agent/token rows are
 * hydrated into JS, eliminating the db-host OOM (exit code 5).
 */
async function aggregateSqliteAnalytics(
  prisma: DesktopPrisma,
  filters: AgentSessionUsageAggregateFilters,
  cache: SessionAttributionResolverCache
): Promise<AgentSessionAnalyticsAggregate> {
  const durStart = analyticsIsoMsExpr("a.started_at");
  const durEnd = analyticsIsoMsExpr("a.ended_at");
  // durMs: NULL when started_at/ended_at is NULL or empty-string, else the
  // integer-ms difference. Mirrors `durationBetween`'s `!(startedAt && endedAt)`
  // null guard, then `end.getTime() - start.getTime()`.
  const durMs =
    "(CASE WHEN a.started_at IS NULL OR a.started_at = '' OR a.ended_at IS NULL OR a.ended_at = '' " +
    `THEN NULL ELSE ${durEnd} - ${durStart} END)`;
  const eventErrorPredicate = ANALYTICS_EVENT_ERROR_PREDICATE.replaceAll(
    "{col}",
    "e.event_type"
  );

  // Yield before the snapshot, never inside its wall-clock budget.
  await yieldDbHostLoop();

  const { toolRows, agentRows, repoRows, repoCostRows } =
    await readResolvedUsageSnapshot(
      prisma,
      filters,
      async (tx, clause, params, validation) => {
        await assertValidSessionWorkOperands(
          tx,
          validation.clause,
          validation.params
        );
        const toolRows = await tx.$queryRawUnsafe<
          {
            tool_name: string;
            invocation_count: number | string | null;
            error_count: number | string | null;
            session_count: number | string | null;
          }[]
        >(
          `
        -- byTool — events joined to filtered sessions, over the tool-bearing rows.
        --
        -- ISS-5493: exclude empty tool names as the hydrated fold does; retain
        -- the idx_events_tool_session partial-index predicate.
        SELECT
          e.tool_name AS tool_name,
          COUNT(*) AS invocation_count,
          SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count,
          COUNT(DISTINCT e.session_id) AS session_count
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        ${clause}
        ${clause ? "AND" : "WHERE"} ${toolInvocationPredicate("e.tool_name")}
        GROUP BY e.tool_name
      `,
          ...params
        );
        throwIfStoreReadCancelled();

        // byAgentType — agents joined to the filtered sessions, grouped by the
        // COALESCE(subagent_type, type, 'unknown') identity.
        const agentRows = await tx.$queryRawUnsafe<
          {
            agent_type: string;
            count: number | string | null;
            success_count: number | string | null;
            failed_count: number | string | null;
            duration_total_ms: number | string | null;
            duration_count: number | string | null;
          }[]
        >(
          `
        SELECT
          COALESCE(a.subagent_type, a.type, 'unknown') AS agent_type,
          COUNT(*) AS count,
          SUM(CASE WHEN (lower(a.status) LIKE '%success%' OR lower(a.status) LIKE '%complete%' OR lower(a.status) LIKE '%done%') THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN (lower(a.status) LIKE '%error%' OR lower(a.status) LIKE '%fail%') THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN ${durMs} IS NOT NULL AND ${durMs} >= 0 THEN ${durMs} ELSE 0 END) AS duration_total_ms,
          SUM(CASE WHEN ${durMs} IS NOT NULL AND ${durMs} >= 0 THEN 1 ELSE 0 END) AS duration_count
        FROM agents a
        JOIN sessions s ON s.id = a.session_id
        ${clause}
        GROUP BY COALESCE(a.subagent_type, a.type, 'unknown')
      `,
          ...params
        );
        throwIfStoreReadCancelled();

        // byRepository — per-cwd rollup. Token sums are summed PER SESSION first
        // (a CTE) to avoid the token_usage join fanning out the per-session error
        // count; the error count is likewise a per-session sub-aggregate. Grouped
        // by the RAW cwd; JS resolves+merges to repositoryFullName below.
        //
        // FEA-3318: the token sums fold the pre-compaction `baseline_*` into the
        // effective total (current + baseline), matching the hydrate loader
        // (FEA-2922) that backs `buildAnalytics`'s repository fold — so a compacted
        // session's displayed tokens (and the cost the rollup below reprices from
        // them) reflect all incurred tokens, not just the post-compaction subset.
        const repoResult = await tx.$queryRawUnsafe<
          {
            cwd: string | null;
            repo_full_name: string | null;
            session_count: number | string | null;
            input_tokens: string | null;
            output_tokens: string | null;
            error_count: number | string | null;
          }[]
        >(
          `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd, s.repo_full_name AS repo_full_name
          FROM sessions s
          ${clause}
        ),
        per_session_tokens AS (
          -- FEA-3317: fold pre-compaction baseline_* into the reported per-repo
          -- token totals so they match the hydrate buildAnalytics repository fold
          -- path (sumTokenUsage over effective tokenUsageByModel) for compacted
          -- rows. baseline_* is NOT NULL DEFAULT 0 → current-only when never
          -- compacted.
          SELECT t.session_id AS session_id,
            SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)) AS input_tokens,
            SUM(COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)) AS output_tokens
          FROM token_usage t
          JOIN filtered f ON f.id = t.session_id
          GROUP BY t.session_id
        ),
        per_session_errors AS (
          -- ISS-5493 considered sourcing this from the materialized
          -- session_analytics.error_events (same error/fail predicate, one
          -- fewer events pass). It must NOT: that rollup is only written at
          -- import, boot-backfill, and the targeted heals, and the backfill
          -- anti-joins sessions MISSING a row rather than refreshing stale
          -- ones. A hook-ingested session (Claude runs in "hooks" collection
          -- mode, where FEA-1839 deliberately starts no live watcher) therefore
          -- has no rollup row at all until the next boot, so a rollup-sourced
          -- error count reads 0 for the whole app run while the hydrate path
          -- reports the real number — the same screen contradicting itself.
          SELECT e.session_id AS session_id,
            SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count
          FROM events e
          JOIN filtered f ON f.id = e.session_id
          GROUP BY e.session_id
        )
        SELECT
          f.cwd AS cwd,
          f.repo_full_name AS repo_full_name,
          COUNT(*) AS session_count,
          SUM(COALESCE(pt.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(pt.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(pe.error_count, 0)) AS error_count
        FROM filtered f
        LEFT JOIN per_session_tokens pt ON pt.session_id = f.id
        LEFT JOIN per_session_errors pe ON pe.session_id = f.id
        GROUP BY f.cwd, f.repo_full_name
      `,
          ...params
        );
        throwIfStoreReadCancelled();

        // Per-(cwd, model) cost rollup. Mirrors `aggregateSqliteUsage`'s cost
        // fold structure: stored `cost_usd_estimated` sums for priced rows, and
        // the unpriced token sums per model so the JS fold can apply
        // `resolveTokenUsageCostUsd` once per (cwd, model) group — equal to pricing
        // each row then summing (linear in tokens) — matching the hydrate loader's
        // per-row `resolveTokenUsageCostUsd(...) ?? 0` accumulated by `sumTokenUsage`.
        //
        // FEA-3318: the unpriced token sums fold the pre-compaction `baseline_*`
        // into the effective total (current + baseline), the same reprice the
        // boot reprice (`repriceUnpricedTokenUsageChunk` in token-cost-maintenance.ts, FEA-2879) and the hydrate
        // loader (FEA-2922, `input_tokens + baseline_input`, …) apply. Without it a
        // compacted + unpriced session is repriced from its post-compaction subset
        // only, undercounting per-repository cost. This mirrors the priced/unpriced
        // fold shape of `aggregateSqliteUsage`, which (as of FEA-3317) also folds
        // `baseline_*` into both its reported and unpriced-token sums, so the
        // usage/insights reader no longer carries the compacted undercount either.
        const repoCostResult = await tx.$queryRawUnsafe<
          {
            cwd: string | null;
            repo_full_name: string | null;
            model: string | null;
            estimated_cost_usd: number | null;
            unpriced_input_tokens: string | null;
            unpriced_output_tokens: string | null;
            unpriced_cache_read_tokens: string | null;
            unpriced_cache_write_tokens: string | null;
            unpriced_cache_write_1h_tokens: string | null;
          }[]
        >(
          `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd, s.repo_full_name AS repo_full_name
          FROM sessions s
          ${clause}
        )
        SELECT
          f.cwd AS cwd,
          f.repo_full_name AS repo_full_name,
          t.model AS model,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          -- FEA-3317: fold pre-compaction baseline_* into the unpriced-token sums
          -- so the per-(cwd, model) on-the-fly reprice below prices the EFFECTIVE
          -- total, keeping this cost rollup mirrored EXACTLY with
          -- aggregateSqliteUsage (both undercounted compacted pricing misses).
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0) ELSE 0 END) AS unpriced_cache_write_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_1h_tokens, 0) ELSE 0 END) AS unpriced_cache_write_1h_tokens
        FROM token_usage t
        JOIN filtered f ON f.id = t.session_id
        GROUP BY f.cwd, f.repo_full_name, t.model
      `,
          ...params
        );

        return {
          toolRows,
          agentRows,
          repoRows: repoResult,
          repoCostRows: repoCostResult,
        };
      }
    );

  await yieldDbHostLoop();

  const byTool: AgentSessionAnalyticsToolGroup[] = toolRows.map((row) => ({
    toolName: row.tool_name,
    invocationCount: Number(row.invocation_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
  }));

  const byAgentType: AgentSessionAnalyticsAgentTypeGroup[] = agentRows.map(
    (row) => ({
      agentType: row.agent_type,
      count: Number(row.count ?? 0),
      successCount: Number(row.success_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      durationTotalMs: Number(row.duration_total_ms ?? 0),
      durationCount: Number(row.duration_count ?? 0),
    })
  );

  const byRepository = await resolveAnalyticsRepositoryGroups(
    repoRows,
    repoCostRows,
    cache
  );

  return { byTool, byAgentType, byRepository };
}

/**
 * Full load: session metadata plus every hydrated relation (agents, events,
 * token_events, artifact_links) and resolved attribution. Detail, analytics,
 * and sync use this; production list and usage share only its pure assembly fold.
 *
 * ISS-6105: hydrates in chunks whose boundaries are planned against each
 * session's estimated heap (`planSyncedSessionHydration`), so peak tracks a
 * working-set budget rather than the caller's id count. The attribution `cache`
 * is shared across chunks so cross-chunk cwd resolution is still de-duplicated.
 *
 * FEA-2038 OOM fix: `options.omitEventData` drops the per-event `data` JSON blob
 * (it is still SELECTed for `tool_name`/`event_type`, but the multi-KB parsed
 * `data` object is NOT retained). The full-corpus analytics and legacy list
 * callers only read `event.toolName`/`event.eventType` (never
 * `event.data`), yet they hydrate the ENTIRE corpus at once, so retaining every
 * event's `data` blob across the whole corpus was the dominant peak-memory term
 * that OOM-killed the db-host child during the first-launch backfill. Callers
 * that DO read `event.data` (the single-session detail path, the per-branch
 * trace, and the cloud-sync payload builder) leave this off and keep full data;
 * those are bounded to one session / one branch / one sync batch, not the corpus.
 *
 * ISS-5407: `options.eventRowCap` additionally bounds that read's ROW COUNT per
 * session — only the session-detail reader sets it (see the option's own doc).
 */
async function loadSqliteSyncedSessions(
  prisma: DesktopPrisma,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: SyncedSessionLoadOptions,
  log: (message: string) => void = () => {
    // no-op default: callers that don't wire a sink stay silent
  },
  activitySegmentReadBounds?: ActivitySegmentReadBounds
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  // Each chunk hydrates on a SINGLE pooled reader connection (one prisma.read),
  // so a chunk's ~10 relation reads share one connection; separate chunks
  // round-robin across the pool, letting a concurrent sync/dashboard read run on
  // the other reader.
  //
  // ISS-6105: a lone id has no boundary to choose, so it skips the sizing read
  // outright — the session-detail lane must not pay a round trip to be told the
  // only chunk it could possibly form.
  if (ids.length === 1) {
    const chunk = await prisma.read((reader) =>
      loadSqliteSyncedSessionsChunk(
        reader,
        ids,
        cache,
        options,
        log,
        activitySegmentReadBounds
      )
    );
    // FEA-3555: flush the durable repo-name write-backs AFTER the read closes,
    // so the `prisma.write` never nests inside the `prisma.read` above.
    if (!options?.readOnly) {
      await persistResolvedRepoFullNames(prisma, chunk.repoFullNameWriteBacks);
    }
    return chunk.sessions;
  }
  const out: SyncedAgentSession[] = [];
  const chunks = await planSyncedSessionHydration(prisma, ids, options, log);
  for (let i = 0; i < chunks.length; i++) {
    const loaded = await prisma.read((reader) =>
      loadSqliteSyncedSessionsChunk(
        reader,
        chunks[i],
        cache,
        options,
        log,
        activitySegmentReadBounds
      )
    );
    for (const session of loaded.sessions) {
      out.push(session);
    }
    // FEA-3555: persist this chunk's repo-name write-backs outside the read.
    if (!options?.readOnly) {
      await persistResolvedRepoFullNames(prisma, loaded.repoFullNameWriteBacks);
    }
    // FEA-2264: yield a macrotask between chunks so a full-corpus hydration (the
    // analytics/legacy-list fallback and the cloud-sync payload build) cannot
    // hold the STORE thread's loop for seconds in one go — libSQL is synchronous
    // on that single JS thread, so without a real loop turn the queued renderer
    // reads stay blocked across every chunk. Measured (ISS-8246 M2): a read
    // asking to run mid-sweep starts at 2109 ms with this boundary and 2763 ms
    // without; the longest silent window goes 296 ms → 1287 ms. Skipping the
    // final chunk avoids an idle turn; concatenation order is unchanged.
    if (i < chunks.length - 1) {
      await yieldDbHostLoop();
    }
  }
  return out;
}

/** A hydrated chunk plus the FEA-3555 durable repo-name write-backs it produced. */
type SyncedSessionsChunk = {
  sessions: SyncedAgentSession[];
  repoFullNameWriteBacks: RepoFullNameWriteBack[];
};

async function loadSqliteSyncedSessionsChunk(
  reader: DesktopPrismaReadClient,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: SyncedSessionLoadOptions,
  log: (message: string) => void = () => {
    // no-op default: callers that don't wire a sink (tests) stay silent
  },
  activitySegmentReadBounds?: ActivitySegmentReadBounds
): Promise<SyncedSessionsChunk> {
  if (ids.length === 0) {
    return { sessions: [], repoFullNameWriteBacks: [] };
  }
  const sessionRows = await selectSessionRows(reader, ids, options);
  const tokenRows = await selectTokenUsageRows(reader, ids);
  const invocationCountBySessionId = await selectInvocationCountRows(
    reader,
    ids
  );
  const agentRows = await selectRowsByIds<SqliteAgentRow>(
    reader,
    `
      SELECT
        id,
        session_id,
        name,
        type,
        subagent_type,
        status,
        current_tool,
        started_at,
        updated_at,
        ended_at,
        awaiting_input_since,
        parent_agent_id,
        metadata
      FROM agents
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, started_at ASC, id ASC
    `,
    ids
  );
  // FEA-2038 OOM fix (DBA pass): when the caller won't read `event.data`, omit
  // the column from the SELECT entirely rather than SELECTing it and dropping the
  // parsed object after the fact. The libSQL driver materializes the full result
  // set (`result.rows`) in memory before the JS-side omit runs, so SELECTing the
  // multi-KB `data` text for every event of the WHOLE corpus (the legacy list/analytics
  // full-hydration path) was still the dominant peak-memory term that OOM-killed
  // the db-host child during a large first-launch backfill — even though the
  // parsed object was never retained. On a 20k-session / 2M-event corpus this is
  // the difference between ~1.3 GB and ~0.1 GB of materialized event text. The
  // omitted column is aliased back to `data` (as SQL NULL) so the row shape is
  // unchanged; the omit branch in `assembleSyncedSessions` never reads it. Detail/
  // trace/sync callers keep `omitEventData` off and still get the full blob.
  //
  // ISS-5407: the blob was only HALF the exposure — the detail caller keeps the
  // full `data` AND, until now, read every row with no `LIMIT`. `eventRowCap`
  // bounds that caller's row count per session (see `selectEventRows`).
  const eventDataColumn = options?.omitEventData ? "NULL AS data" : "data";
  const eventRows = await selectEventRows(
    reader,
    ids,
    eventDataColumn,
    options?.eventRowCap
  );
  const tokenEventRows = await selectTokenEventRows(reader, ids, options);
  // FEA-3568: the per-session activity-segment tiling for cloud upsync. Read via
  // the typed read delegate (not raw SQL) so the BIGINT bounds and the JSONB
  // `evidence_layers` column are parsed for us. ISS-9865: over-ceiling sessions
  // are keyset-paged in bounded pages so the FULL tiling is read and shipped
  // (chunked across sync parts by chunkOversizedSession). Under-ceiling sessions
  // are batched in one statement. NB: the bound must be per session; one `take`
  // on a multi-id `IN (...)` query caps the TOTAL across the batch (rows ordered
  // by sessionId), which would silently drop later sessions' segments entirely.
  const activitySegments = await selectBoundedActivitySegments(
    reader,
    ids,
    activitySegmentReadBounds
  );
  const sessionActivityMetricsRows = await readActivityMetrics(reader, ids);
  const sessionAnalyticsRows = await readSessionAnalyticsRows(reader, ids);
  const artifactLinkRows = await readArtifactLinkRows(reader, ids, options);
  const pullRequestRows = await readPullRequestRows(reader, ids);
  // FEA-2732: PR lifecycle facts the `artifacts` row doesn't carry (closed
  // timestamp from the per-session `pull_requests` store), keyed per session by
  // (repo_full_name, pr_number) to enrich the `pull_request` artifactRef.
  const pullRequestLifecycleRows = await readPullRequestLifecycleRows(
    reader,
    ids
  );
  // T-8.6: per-session component usage — additive on the cloud-sync payload.
  // FEA-2718 decoupled this from `omitEventData`: the sync payload builder now
  // sets `omitEventData: true` (it no longer ships event `data`) yet STILL needs
  // components, so it passes `includeComponentUsage: true` explicitly. The flag
  // defaults to `!omitEventData`, preserving every prior caller — the
  // legacy list/analytics full-corpus reads (omitEventData, no components) and the
  // detail/branch reads (full data, components) are unchanged.
  const includeComponentUsage =
    options?.includeComponentUsage ?? !options?.omitEventData;
  const componentUsageBySessionId = includeComponentUsage
    ? await selectComponentUsageRows(reader, ids)
    : new Map<string, SqliteComponentUsageRow[]>();
  // ISS-7830: which of these threads a user has opened. Ungated on purpose —
  // this runs in the db-host child, which has its own module registry and never
  // registers the main-side Labs resolver, so a gate read here would be the
  // `false` default forever. The gate lives at the CAPTURE instead, so with the
  // flag off this table is empty and the set is empty by construction rather
  // than by suppression — and no state exists where a recorded view is withheld
  // from the classification that already shipped to the cloud.
  const viewedSessionIds = await selectViewedSessionIds(reader, ids);
  // FEA-3555: attribution is now resolved per SESSION (not per cwd) so the
  // durable stored `repo_full_name` fallback / write-back is applied per row.
  // Any live-resolved names that differ from the stored ones are returned as
  // `writeBacks` and persisted by the caller OUTSIDE this read (a `prisma.write`
  // cannot nest inside the `prisma.read` this runs under).
  const { bySessionId, writeBacks } = await resolveSyncAttributions(
    sessionRows,
    cache,
    groupRowsBySessionId(artifactLinkRows)
  );
  const sessions = assembleSyncedSessions(ids, {
    sessionRows,
    agentRows,
    eventRows,
    tokenRows,
    tokenEventRows,
    segmentRows: activitySegments.rows,
    // ISS-9865: the read's OWN verdict on which tilings it refused at the
    // absolute ceiling. Carried, never re-derived from the row count — a refused
    // session sends zero rows, exactly like one that has no tiling.
    segmentOverflowSessionIds: activitySegments.overflowedSessionIds,
    sessionAnalyticsRows,
    sessionActivityMetricsRows,
    artifactLinkRows,
    pullRequestRows,
    pullRequestLifecycleRows,
    componentUsageBySessionId,
    invocationCountBySessionId,
    viewedSessionIds,
    omitEventData: options?.omitEventData ?? false,
    includeMonitoredSessionActivity:
      options?.includeMonitoredSessionActivity ?? false,
    // ISS-5407 (stage review): the row limit this read actually applied, so the
    // assembly can tell PER SESSION whether its `eventRows` are the whole stream
    // or a chronological PREFIX. Only a session that hit the limit falls back to
    // the stored `last_activity_at`; see the `eventRowFetchLimit` doc.
    eventRowFetchLimit: resolveEventRowFetchLimit(options?.eventRowCap),
    resolveAttribution: (sessionId) => bySessionId.get(sessionId) ?? undefined,
    log,
  });
  return {
    sessions: await attachOperationEvidence(reader, sessions),
    repoFullNameWriteBacks: writeBacks,
  };
}

/**
 * FEA-1834: lightweight load for the usage summary. Fetches only the `sessions`
 * and `token_usage` rows; the agents/events/token_events/artifact_links queries
 * and attribution resolution the full load performs are skipped because
 * `buildUsageSummary`/`matchesQuery` never read them. The skipped inputs simply
 * arrive empty at `assembleSyncedSessions`, so the usage projection cannot drift
 * from the full one — it is far cheaper to re-run on the live cadence as the
 * corpus grows.
 */
async function loadSqliteUsageSessions(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > SYNCED_SESSION_HYDRATE_CHUNK_SIZE) {
    const out: SyncedAgentSession[] = [];
    for (const chunk of chunkIds(ids, SYNCED_SESSION_HYDRATE_CHUNK_SIZE)) {
      const loaded = await loadSqliteUsageSessions(prisma, chunk);
      for (const session of loaded) {
        out.push(session);
      }
    }
    return out;
  }
  const { sessionRows, tokenRows, invocationCountBySessionId } =
    await prisma.read(async (reader) => ({
      sessionRows: await selectSessionRows(reader, ids),
      tokenRows: await selectTokenUsageRows(reader, ids),
      invocationCountBySessionId: await selectInvocationCountRows(reader, ids),
    }));
  // ISS-5271: resolve each session's repository identity STORED-FIRST — the
  // SAME ruled precedence the LIST/render path and the SQL `aggregateUsage` /
  // `aggregateAnalytics` folds use, so this explicit-id path can never advertise
  // a repo the facet's own fold would not. The stored `repo_full_name` is a
  // trusted persisted projection (authored by the live-first SYNC lane, which
  // remains the freshness producer); live resolution runs only for a row with
  // no stored name whose cwd still exists. A fresh per-request cache dedupes
  // the residual lookups across the (typically small) explicit id set. A row
  // that resolves to no repo either way yields no attribution (renders
  // "Unknown", not a facet option).
  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  const repoFullNameById = new Map<string, string | null>();
  // ISS-5272 (M3/C5): keep this fold cooperative now that the shared memo can
  // resolve every row without an `execFile` await to hand back the loop.
  const yieldTick = createAttributionYieldCadence();
  for (const row of sessionRows) {
    await yieldTick();
    repoFullNameById.set(
      row.id,
      await resolveRepositoryFullNameStoredFirst(
        row.cwd,
        row.repo_full_name,
        cache
      )
    );
  }
  return assembleSyncedSessions(ids, {
    sessionRows,
    agentRows: [],
    eventRows: [],
    // ISS-5443: this load fetches no event rows, so the event-derived
    // last-activity is unavailable here — read the stored column, which is the
    // same value the SQL date window bounds on.
    preferStoredLastActivityAt: true,
    tokenRows,
    invocationCountBySessionId,
    tokenEventRows: [],
    segmentRows: [],
    sessionAnalyticsRows: [],
    sessionActivityMetricsRows: [],
    artifactLinkRows: [],
    pullRequestRows: [],
    pullRequestLifecycleRows: [],
    resolveAttribution: (sessionId) => {
      const repositoryFullName = repoFullNameById.get(sessionId) ?? null;
      if (repositoryFullName === null) {
        return undefined;
      }
      return {
        repositoryFullName,
        worktreePath: null,
        sourceArtifactId: null,
        baseBranch: null,
      };
    },
  });
}

/**
 * Pure per-session fold shared by both loads: it never touches the database, so
 * the full and usage paths differ only in which row sets (and attribution) they
 * hand in. Empty relation rows naturally yield `agents: []` / `events: []` and
 * no artifact/PR refs.
 */
function assembleSyncedSessions(
  ids: string[],
  rows: {
    sessionRows: SqliteSessionRow[];
    agentRows: SqliteAgentRow[];
    eventRows: SqliteEventRow[];
    tokenRows: SqliteTokenUsageRow[];
    tokenEventRows: SqliteTokenEventRow[];
    segmentRows: SyncedSegmentQueryRow[];
    /** ISS-9865: sessions whose tiling the read REFUSED — see {@link BoundedActivitySegments}. */
    segmentOverflowSessionIds?: ReadonlySet<string>;
    sessionAnalyticsRows: SqliteSessionAnalyticsRow[];
    sessionActivityMetricsRows?: SqliteSessionActivityMetricsRow[];
    artifactLinkRows: SqliteArtifactLinkRow[];
    pullRequestRows: SqlitePullRequestRow[];
    pullRequestLifecycleRows: SqlitePullRequestLifecycleRow[];
    /** T-8.6: per-session component usage rows, grouped by session_id. */
    componentUsageBySessionId?: Map<string, SqliteComponentUsageRow[]>;
    /**
     * ISS-5801: per-session count of locally materialized component
     * invocations. Every hydration path supplies it (see
     * `selectInvocationCountRows`); absent — legacy callers/tests — coalesces
     * to 0, which reproduces the pre-ISS-5801 classification.
     */
    invocationCountBySessionId?: Map<string, number>;
    /** Exact agent counts for the list-only read, which omits agent graphs. */
    listAgentCountBySessionId?: ReadonlyMap<string, number>;
    /**
     * ISS-7830: the subset of `ids` a user has navigated INTO, read from
     * `session_viewership`. Overrides the launch-time headless default for an
     * agent-spawned thread (`session-trace-autonomy-input.ts`).
     *
     * Optional, and ABSENT means unviewed rather than unknown — every read that
     * omits it (the lightweight usage load, every legacy caller) keeps the
     * pre-ISS-7830 classification. That is also what the `threadViewershipSignal`
     * Labs flag being off produces, so the off state costs no query.
     */
    viewedSessionIds?: ReadonlySet<string>;
    // When true, skip parsing/retaining each event's `data` JSON blob (the
    // dominant per-event memory cost). Callers that never read `event.data`
    // (full-corpus legacy list/analytics reads) set this to bound peak memory; callers
    // that do (detail/branch-trace/sync payload) leave it false. Defaults to
    // false so the usage path — which passes no event rows — is unaffected.
    omitEventData?: boolean;
    /** Capability-gated projection; local detail/list readers omit this carrier. */
    includeMonitoredSessionActivity?: boolean;
    /**
     * ISS-5407: the per-session row limit the event read applied (`eventRowCap + 1`
     * — see `resolveEventRowFetchLimit`), or absent when the read was unbounded.
     *
     * A session whose loaded rows REACH that limit is one whose stream is larger
     * than what was served, so its `lastActivityAt` derivation below would answer
     * "the last event we bothered to read" rather than when the run last did
     * anything. That is not merely imprecise: `resolveSessionTimelineWindow`
     * extends a truncated detail's axis to `endedAt ?? lastActivityAt` precisely so
     * a partial run cannot render as a complete one, and a prefix-derived
     * `lastActivityAt` collapses that extension onto the last PLOTTED row —
     * silently no-opping the guard for a still-running session (no `endedAt`).
     * Those sessions fall back to the stored `sessions.last_activity_at` column,
     * which ingest maintains as exactly this formula over the WHOLE stream.
     *
     * Deliberately per SESSION, not per read. A bounded read whose session came in
     * UNDER the limit loaded the whole stream, so its derivation is already the
     * right answer — and ISS-4833's desktop semantics (the detail's rendered
     * `lastActivityAt` is event-derived, NOT the column, which on this surface is
     * the retention/window anchor) must not move for it. The divergent-column
     * case remains in `test/session-detail-event-cap.test.ts`.
     */
    eventRowFetchLimit?: number;
    // FEA-3555: keyed by session id (not cwd) so the per-row durable
    // `repo_full_name` fallback / write-back can be applied.
    resolveAttribution: (
      sessionId: string
    ) => ReturnType<typeof resolveSessionAttribution>;
    // FEA-3568: optional diagnostic sink (the desktop `options.log`) used to make
    // an over-cap activity-segment truncation visible instead of a silent cloud
    // undercount. Absent on paths that never carry segments (the usage load).
    log?: (message: string) => void;
    /**
     * ISS-5443: read `lastActivityAt` from the stored `sessions.last_activity_at`
     * column instead of deriving it from `eventRows`.
     *
     * Set ONLY by the lightweight usage load, which fetches no event rows at all
     * — so its derivation silently collapsed every session to `started_at`, and
     * the usage half then windowed on a different timestamp than the Sessions
     * list beside it. Deliberately NOT set on the full hydration path: there the
     * events ARE loaded and the derivation picks the same INSTANT as the column
     * whenever the events canonicalize (ISS-5497 made that true; where they do
     * not, it is no more divergent than before), and that path feeds both the
     * cloud sync payload and the Session Timeline axis,
     * whose desktop-specific event-derived semantics ISS-4833 owns and this
     * change must not move.
     */
    preferStoredLastActivityAt?: boolean;
  }
): SyncedAgentSession[] {
  const artifactLinksBySessionId = groupRowsBySessionId(rows.artifactLinkRows);
  const pullRequestsBySessionId = groupRowsBySessionId(rows.pullRequestRows);
  // FEA-2732: PR lifecycle facts (closed timestamp) grouped by session, keyed
  // per session by `${repo}#${number}` to enrich the `pull_request` artifactRef.
  const pullRequestLifecycleBySessionId = groupRowsBySessionId(
    rows.pullRequestLifecycleRows
  );

  const sessionsById = new Map(rows.sessionRows.map((row) => [row.id, row]));
  const agentsBySessionId = groupRowsBySessionId(rows.agentRows);
  const eventsBySessionId = groupRowsBySessionId(rows.eventRows);
  const tokenUsageBySessionId = groupRowsBySessionId(rows.tokenRows);
  const tokenEventsBySessionId = groupRowsBySessionId(rows.tokenEventRows);
  const segmentsBySessionId = groupSegmentsBySessionId(rows.segmentRows);
  const sessionAnalyticsBySessionId = new Map(
    rows.sessionAnalyticsRows.map((row) => [row.session_id, row])
  );
  const metricsById = indexActivityMetrics(rows.sessionActivityMetricsRows);
  // T-8.6: component usage map (may be absent for non-sync paths like usage/analytics)
  const componentUsageBySessionId =
    rows.componentUsageBySessionId ??
    new Map<string, SqliteComponentUsageRow[]>();

  return ids.flatMap((id) => {
    const row = sessionsById.get(id);
    if (!row) {
      return [];
    }
    const attribution = rows.resolveAttribution(row.id);
    const storedMetadata = parseJsonObjectText(row.metadata);
    const metadata = withoutMonitoredActivityOnlyMetadata(storedMetadata);
    const invocationCount = rows.invocationCountBySessionId?.get(id) ?? 0;

    const linkRows = artifactLinksBySessionId.get(id) ?? [];
    const artifactRefs: SyncedArtifactRef[] = [];
    const prRefs: SyncedSessionPrRef[] = [];
    // FEA-2732: per-session PR lifecycle facts, keyed by `${repo}#${number}`.
    const prLifecycleByKey = new Map<string, SqlitePullRequestLifecycleRow>();
    for (const lc of pullRequestLifecycleBySessionId.get(id) ?? []) {
      if (lc.repo_full_name && lc.pr_number != null) {
        prLifecycleByKey.set(`${lc.repo_full_name}#${lc.pr_number}`, lc);
      }
    }
    for (const link of linkRows) {
      // ISS-8882: `repositoryFullName` is REQUIRED `.max(200)` on every ref
      // schema, and the batch is one parse. A stored slug past the bound drops
      // the whole ref here — never truncated, a shorter slug is a different repo.
      const repo = boundedWireString(
        link.repo_full_name,
        REPOSITORY_FULL_NAME_MAX_LENGTH
      );
      if (link.target_kind === "closedloop_artifact" && link.slug) {
        const relation = toArtifactRefRelation(link.relation);
        const observedAt = resolveLinkObservedAt(link);
        artifactRefs.push({
          kind: ArtifactRefTargetKind.ClosedloopArtifact,
          slug: link.slug,
          isPrimary: link.is_primary,
          method: link.method,
          ...(relation ? { relation } : {}),
          ...(observedAt ? { observedAt } : {}),
        });
      } else if (
        link.target_kind === "branch" &&
        repo &&
        link.branch_name &&
        link.branch_name.length <= BRANCH_NAME_MAX_LENGTH
      ) {
        // FEA-2729: sync the session's branch links with method/relation so the
        // cloud can distinguish a branch written-to from one merely started on.
        // Relation is required — an absent/unknown stored relation is the
        // conservative `workspace` (read) assumption, not write evidence.
        //
        // Deploy-ordering constraint (deferred, PLN-1296): branch refs ride the
        // existing `artifactRefs` array without a schema-version bump, so a
        // cloud that predates FEA-2729 (slug-only ref schema) would reject a
        // session carrying one. This is safe because the cloud is deployed
        // ahead of desktop app releases; if that ordering ever changes,
        // capability-gate this emission or move branch refs to a version-safe
        // optional field.
        const observedAt = resolveLinkObservedAt(link);
        const relation =
          toArtifactRefRelation(link.relation) ?? ArtifactRefRelation.Workspace;
        const branchLifecycleEvents =
          branchLifecycleEventsForPersistedBranchLink(
            link,
            relation,
            observedAt
          );
        const branchParticipation = deriveBranchParticipationFromEvidence({
          relation,
          method: link.method,
          branchLifecycleEvents,
        });
        const monitoredSessionActivity = rows.includeMonitoredSessionActivity
          ? monitoredSessionActivityFromEvidence(link.link_evidence ?? null)
          : undefined;
        artifactRefs.push({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: repo,
          branchName: link.branch_name,
          method: link.method,
          relation,
          ...branchRefPriorityField(link.priority),
          ...(branchParticipation ? { branchParticipation } : {}),
          ...(observedAt ? { observedAt } : {}),
          ...(branchLifecycleEvents.length > 0
            ? { branchLifecycleEvents }
            : {}),
          ...(monitoredSessionActivity ? { monitoredSessionActivity } : {}),
        });
      } else if (
        link.target_kind === "pull_request" &&
        repo &&
        link.pr_number != null
      ) {
        const observedAt = resolveLinkObservedAt(link);
        const relation =
          toArtifactRefRelation(link.relation) ??
          ArtifactRefRelation.Referenced;
        const branchLifecycleEvents = branchLifecycleEventsForPersistedPrLink(
          link,
          relation,
          observedAt
        );
        const lifecycle = prLifecycleByKey.get(`${repo}#${link.pr_number}`);
        const monitoredSessionActivity = rows.includeMonitoredSessionActivity
          ? monitoredSessionActivityFromEvidence(link.link_evidence ?? null)
          : undefined;
        // FEA-2732: emit the PR as a fact-carrying `pull_request` artifactRef the
        // cloud syncs into PullRequestDetail. Same deploy-ordering note as branch
        // refs above: the enriched fields are optional, so a cloud that predates
        // FEA-2732 strips them (the ref kind has shipped since FEA-2729).
        const headBranch = boundedWireString(link.branch_name, 300);
        artifactRefs.push({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: repo,
          prNumber: link.pr_number,
          method: link.method,
          relation,
          ...(observedAt ? { observedAt } : {}),
          ...(branchLifecycleEvents.length > 0
            ? { branchLifecycleEvents }
            : {}),
          ...(monitoredSessionActivity ? { monitoredSessionActivity } : {}),
          ...(headBranch ? { branchName: headBranch } : {}),
          ...buildPullRequestArtifactRefFacts(link, lifecycle),
        });
        const prRef = buildSyncedSessionPrRef(link);
        if (prRef) {
          prRefs.push(prRef);
        }
      } else if (link.target_kind === "commit" && repo) {
        const commitRef = buildCommitArtifactRef(
          link,
          repo,
          toArtifactRefRelation(link.relation) ?? ArtifactRefRelation.Created
        );
        if (commitRef) {
          artifactRefs.push(commitRef);
        }
      }
    }
    if (rows.includeMonitoredSessionActivity) {
      artifactRefs.push(
        ...monitoredActivityOnlyRefsFromMetadata(storedMetadata)
      );
    }
    // FEA-2711 / ISS-4448+4449: bound the artifactRefs array to the desktop
    // PRODUCER cap (`MAX_SYNCED_ARTIFACT_REFS_PRODUCER`, 100), NOT the raised
    // cloud validator cap (`MAX_SYNCED_ARTIFACT_REFS`, 500). A new desktop must
    // never emit a total array an old `.max(100)` cloud rejects — that would
    // fail cloud validation and, because the whole batch is validated with one
    // parse, reject up to 200 sessions and silently stall sync. The validator
    // raise is receive-side + deploy-order-safe; this producer slice stays 100.
    //
    // FEA-2731: commit refs are LOWEST priority — branch/PR/closedloop refs are
    // load-bearing (branch refs drive FR12 org visibility), so keep those first
    // and let commits fill only the remaining budget.
    //
    // ISS-4448+4449: WITHIN the non-commit budget, `closedloop_artifact`
    // (document) refs get a guaranteed floor so a PR-heavy session can't starve
    // its document links to zero. ISS-5764: the commit count is passed so prose
    // mentions cannot spend slots these commits need. See the budget helper.
    const commitRefs = artifactRefs.filter(
      (ref) => ref.kind === ArtifactRefTargetKind.Commit
    );
    const nonCommitRefs = artifactRefs.filter(
      (ref) => ref.kind !== ArtifactRefTargetKind.Commit
    );
    const boundedNonCommitRefs = boundNonCommitArtifactRefs(
      nonCommitRefs,
      commitRefs.length
    );
    const activityCoverageTruncated =
      boundedNonCommitRefs.length < nonCommitRefs.length;
    const boundedArtifactRefs = [
      ...boundedNonCommitRefs,
      ...commitRefs.slice(
        0,
        Math.max(
          0,
          MAX_SYNCED_ARTIFACT_REFS_PRODUCER - boundedNonCommitRefs.length
        )
      ),
    ].map((ref) =>
      activityCoverageTruncated ? downgradeMonitoredSessionActivity(ref) : ref
    );
    const tokenUsageByModel: SyncedAgentSessionTokenUsage[] = (
      tokenUsageBySessionId.get(id) ?? []
    ).map((tokenRow) => {
      // FEA-2922: fold the pre-compaction baselines into the effective totals so
      // the per-model sync projection matches the session_analytics rollup
      // (input_tokens + baseline_input, …) and the effective-priced cost. Raw
      // post-compaction counts here would undercount any compacted session.
      const inputTokens = addStorageTokenCounts(
        tokenRow.input_tokens,
        tokenRow.baseline_input,
        "sync.input"
      );
      const outputTokens = addStorageTokenCounts(
        tokenRow.output_tokens,
        tokenRow.baseline_output,
        "sync.output"
      );
      const cacheReadTokens = addStorageTokenCounts(
        tokenRow.cache_read_tokens,
        tokenRow.baseline_cache_read,
        "sync.cache_read"
      );
      const cacheWriteTokens = addStorageTokenCounts(
        tokenRow.cache_write_tokens,
        tokenRow.baseline_cache_write,
        "sync.cache_write"
      );
      // FEA-3419: additive TTL subdivision. Current-only (compaction baselines
      // carry no per-request data → unclassified by design); null = absent.
      const cacheWrite5mTokens =
        tokenRow.cache_write_5m_tokens === null ||
        tokenRow.cache_write_5m_tokens === undefined
          ? null
          : tokenCountValue(
              tokenRow.cache_write_5m_tokens,
              "sync.cache_write_5m"
            );
      const cacheWrite1hTokens =
        tokenRow.cache_write_1h_tokens === null ||
        tokenRow.cache_write_1h_tokens === undefined
          ? null
          : tokenCountValue(
              tokenRow.cache_write_1h_tokens,
              "sync.cache_write_1h"
            );
      const estimatedCostUsd = resolveTokenUsageCostUsd({
        ...tokenRow,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        cache_write_1h_tokens: cacheWrite1hTokens,
      });
      return {
        model: tokenRow.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        ...(cacheWrite5mTokens === null && cacheWrite1hTokens === null
          ? {}
          : { cacheWrite5mTokens, cacheWrite1hTokens }),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      };
    });
    // ISS-4881: raw per-event token rows prefer their persisted transport
    // identity; untouched legacy rows retain the old content-hash fallback.
    const sessionTokenEventRows = tokenEventsBySessionId.get(id) ?? [];
    const tokenEvents: SyncedAgentSessionTokenEvent[] =
      sessionTokenEventRows.map((eventRow) =>
        mapSyncedTokenEvent(id, eventRow)
      );
    const sessionAnalyticsRow = sessionAnalyticsBySessionId.get(id);
    // ISS-7818: the nullable cloud column shipped first with ISS-7813, so this
    // producer now sends an explicit `null` when neither persisted candidate can
    // support a number. `resolveSyncedSessionCostUsd` owns why each candidate
    // must prove itself finite and non-negative, why the authoritative column is
    // only reached over a fully-priced window, and why a real zero stays zero.
    const sessionAnalytics = mapSyncedSessionAnalytics(
      sessionAnalyticsRow,
      resolveSyncedSessionCostUsd(
        sessionAnalyticsRow?.est_cost,
        row.cost_usd_estimated,
        tokenUsageBySessionId.get(id) ?? []
      )
    );
    const sessionEventRows = eventsBySessionId.get(id) ?? [];
    const timelineRows = buildTraceTimelineRows(metadata, sessionEventRows);
    const traceTokenEvents = mapTraceTokenEvents(id, sessionTokenEventRows);
    const traceFields = buildSessionTraceSyncFields({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      metadata,
      attribution,
      artifactLinkBranch: resolveArtifactLinkBranch(linkRows),
      events: sessionEventRows,
      timelineRows,
      tokenEvents: traceTokenEvents,
      localPullRequests: pullRequestsBySessionId.get(id) ?? [],
      viewedByUser: rows.viewedSessionIds?.has(id) ?? false,
    });
    const { markers: traceMarkers, ...traceFieldsWithoutMarkers } = traceFields;

    // FEA-4022 (PLN-1481): fold this session's language heuristic, nearby-error
    // spikes, and already-derived trace-signal counts into the raw, UNBOUNDED
    // frustration signal, reusing the merged FEA-3928 scorer (never
    // reimplemented). Computed here at sync-source assembly from the same event
    // rows + trace fields the payload carries; the value flows to the cloud
    // (persisted only when the org opted in) and Insights. Turn text comes from
    // the event `summary` (present on every path — the sync builder omits only
    // the heavy `data` blob, and `summary` is the primary turn-text source).
    const frustrationRaw = computeFrustrationRaw(
      deriveFrustrationInput(
        sessionEventRows.map((eventRow) => ({
          eventType: eventRow.event_type,
          summary: eventRow.summary,
          data: eventRow.data,
        })),
        {
          steeringEpisodes: traceFields.steeringEpisodes,
          correctionCount: traceFields.correctionSources?.length,
          phaseLoopbacks: traceFields.phaseLoopbacks?.length,
          throttles: traceFields.throttles?.length,
        }
      )
    );

    // FEA-3427: anchor artifact (commit/PR) marker coordinates to the same
    // corrected wall-clock end (last real activity) the trace buckets/span use,
    // not the days-long re-sync-bumped updated_at window.
    const artifactMarkers = buildArtifactSessionMarkers({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      endMs: resolveTraceEndMs({
        updatedAt: row.updated_at,
        endedAt: row.ended_at,
        timelineRows,
        tokenEvents: traceTokenEvents,
      }),
      links: linkRows,
      timelineRows: timelineRows.map((timelineRow) => ({
        createdAt: timelineRow.createdAt,
      })),
    });
    const markers = mergeSessionMarkers(
      traceMarkers ?? [],
      artifactMarkers
    ).slice(0, SESSION_TRACE_SOURCE_LIMITS.markers);
    // PLN-1034: genuine activity = the latest agent event, floored at the
    // session start. Deliberately NOT row.updated_at (bumped by OTEL ingest /
    // enrichment / sync writes).
    //
    // ISS-5443: read the DENORMALIZED `sessions.last_activity_at` column when
    // this SELECT projected it. That column is maintained inside the same ingest
    // transaction that writes the events (`recomputeSessionLastActivityAt`) as
    // the fold below's instant — in canonical UTC since ISS-5497, not verbatim
    // event text — and it is the value the Sessions list SORTS by and every
    // Sessions date window bounds on — so reading it is what makes the hydrated
    // fold agree with the SQL paths instead of re-deriving a second opinion.
    // Re-deriving was not merely redundant: `loadSqliteUsageSessions` (the
    // lightweight usage fallback) loads NO event rows, so the derivation there
    // collapsed every session to its `started_at` and the usage half windowed on
    // a different timestamp than the list beside it.
    //
    // The event-derived max stays as the fallback for a load that did not
    // project the column, and for a row whose column is unusable (a pre-0005
    // install whose backfill has not run). ISS-6795 moved that fold to
    // {@link deriveSessionLastActivityAt}, beside the resolver it feeds, so the
    // readings it must reject stay stated once against the SQL it mirrors.
    let lastActivityAt = deriveSessionLastActivityAt(
      row.started_at ?? null,
      sessionEventRows
    );
    // ISS-5407: this session's rows REACHED the read's per-session limit, so what
    // the derivation above returned is the max over a PREFIX. See the
    // `eventRowFetchLimit` doc for why only these sessions switch bases.
    const eventReadTruncated =
      rows.eventRowFetchLimit !== undefined &&
      sessionEventRows.length >= rows.eventRowFetchLimit;
    if (rows.preferStoredLastActivityAt || eventReadTruncated) {
      lastActivityAt = resolveSessionLastActivityAt(
        row.last_activity_at,
        lastActivityAt
      );
    }

    // ISS-4541 / ISS-9865: what this session's activity tiling contributes to
    // the payload — the full tiling, or the stripped-and-owed declaration a
    // refused one ships. `resolveSyncedSessionTiling` owns that decision and the
    // diagnostic that explains it.
    const tiling = resolveSyncedSessionTiling({
      sessionId: id,
      segments: segmentsBySessionId.get(id) ?? [],
      refused: rows.segmentOverflowSessionIds?.has(id) === true,
      log: rows.log,
    });

    return [
      {
        ...toSyncedSessionHead(row),
        harness: row.harness,
        billingMode: resolveBillingModeForRow(row),
        cwd: row.cwd,
        model: row.model,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        lastActivityAt,
        endedAt: row.ended_at,
        awaitingInputSince: row.awaiting_input_since,
        endsWithError: sqliteFlagToNullableBoolean(row.ends_with_error),
        metadata,
        ...(row.user_id ? { userId: row.user_id } : {}),
        ...(row.organization_id ? { organizationId: row.organization_id } : {}),
        deviceTimeZone: localTimeZone(),
        dataRevision: row.data_revision,
        ...componentInvocationCountPatch(invocationCount),
        ...(rows.listAgentCountBySessionId?.has(id)
          ? { listAgentCount: rows.listAgentCountBySessionId.get(id) }
          : {}),
        // FEA-4022: the raw frustration signal + scorer version. Always emitted
        // by this build; the cloud persists them only when the org opted into
        // `calculateSessionFrustration`, else drops them at ingest.
        frustrationRaw,
        frustrationScoreVersion: FRUSTRATION_SCORE_VERSION,
        ...authoritativeCostPatch(row, rows.log),
        ...(attribution ? { attribution } : {}),
        ...traceFieldsWithoutMarkers,
        ...(markers.length > 0 ? { markers } : {}),
        ...(boundedArtifactRefs.length > 0
          ? { artifactRefs: boundedArtifactRefs }
          : {}),
        prRefs,
        agents: (agentsBySessionId.get(id) ?? []).map((agentRow) => ({
          externalAgentId: agentRow.id,
          name: agentRow.name,
          type: agentRow.type,
          subagentType: agentRow.subagent_type,
          status: agentRow.status,
          currentTool: agentRow.current_tool,
          startedAt: agentRow.started_at,
          updatedAt: agentRow.updated_at,
          endedAt: agentRow.ended_at,
          awaitingInputSince: agentRow.awaiting_input_since,
          parentExternalAgentId: agentRow.parent_agent_id,
          metadata: parseJsonObjectText(agentRow.metadata),
        })),
        events: sessionEventRows.map((eventRow) => ({
          externalEventId: String(eventRow.id),
          agentExternalId: eventRow.agent_id,
          eventType: eventRow.event_type,
          toolName: eventRow.tool_name,
          summary: eventRow.summary,
          // Omit the heavy `data` blob entirely when the caller won't read it,
          // so the parsed object is never allocated/retained for the corpus.
          ...(rows.omitEventData
            ? {}
            : { data: parseJsonValueText(eventRow.data) }),
          createdAt: eventRow.created_at,
        })),
        tokenUsageByModel,
        // FEA-2730: additive per-session sections. Emit only when present so a
        // session with no rows sends nothing (an omitted array/rollup never
        // clears previously synced cloud rows).
        ...(tokenEvents.length > 0 ? { tokenEvents } : {}),
        // FEA-3568: additive activity-segment tiling for cloud upsync. Omitted
        // when empty so a session with no segments never clears cloud rows (the
        // cloud no-ops on absence, replace-on-open + append-idempotent on
        // presence). ISS-4541: the FULL tiling ships here; an oversized tiling is
        // chunked across sync parts (or dead-lettered), never truncated — so the
        // partial-tiling `activitySegmentRowsTruncated` signal is no longer
        // emitted (the transport cap can no longer produce a partial cloud tiling).
        ...tiling,
        ...(sessionAnalytics ? { sessionAnalytics } : {}),
        // ISS-10721: the one section that sends an explicit `null` rather than
        // omitting — see `syncedActivityMetricsField` for why a retraction here
        // is not the same claim as an absent part.
        ...syncedActivityMetricsField(metricsById, id),
        // T-8.6: additive per-session component usage, emitted IN FULL
        // (ISS-6884) — the per-payload MAX_SESSION_COMPONENT_USAGE bound is
        // honored by the chunker, which paginates the set across sync parts on
        // whole (kind,key) boundaries. Omitted when empty so a session with no
        // component rows sends nothing (never clears cloud rows).
        ...buildSessionComponentUsageField(
          componentUsageBySessionId.get(id) ?? [],
          metadata,
          (message) => rows.log?.(`sync-source: session ${id} ${message}`)
        ),
      },
    ];
  });
}

/** Shared assembly input shape for the list-only reader. */
export type SessionAssemblyRows = Parameters<typeof assembleSyncedSessions>[1];

/**
 * FEA-1684: Query local SQLite for per-artifact session usage (token totals,
 * session count, estimated cost). Returns zero-valued entries for slugs with
 * no linked sessions so callers always get a result for every input slug.
 *
 * Cost is summed from persisted token_usage estimates; missing estimates
 * contribute zero at this numeric summary boundary.
 */
export async function getArtifactSessionUsage(
  prisma: DesktopPrisma,
  slugs: string[]
): Promise<LocalArtifactSessionUsage[]> {
  if (slugs.length === 0) {
    return [];
  }
  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(", ");

  // Session counts per slug (COUNT DISTINCT session_id).
  const countRows = await prisma.client.$queryRawUnsafe<
    {
      slug: string;
      session_count: string;
    }[]
  >(
    `
      SELECT a.slug, COUNT(DISTINCT sal.session_id) AS session_count
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      WHERE a.kind = 'closedloop_artifact'
        AND a.slug IN (${placeholders})
      GROUP BY a.slug
    `,
    ...slugs
  );

  // Token totals per (slug, model) — needed for per-model cost computation.
  const modelRows = await prisma.client.$queryRawUnsafe<
    {
      slug: string;
      model: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_usd_estimated: string | null;
      unpriced_input_tokens: string | null;
      unpriced_output_tokens: string | null;
      unpriced_cache_read_tokens: string | null;
      unpriced_cache_write_tokens: string | null;
      unpriced_cache_write_1h_tokens: string | null;
    }[]
  >(
    `
      -- FEA-3391: fold the pre-compaction baselines into the effective totals
      -- (input_tokens + baseline_input, …) so per-artifact cost attribution
      -- counts all incurred tokens, not just the post-compaction subset. The
      -- raw current columns undercount any compacted session; the unpriced
      -- sums below reprice from the same folded totals. Mirrors the
      -- session_analytics upsert fold in session-analytics-rollup.ts.
      SELECT
        a.slug,
        tu.model,
        -- FEA-3317: fold pre-compaction baseline_* into BOTH the reported token
        -- totals and the unpriced-token reprice sums, mirroring
        -- aggregateSqliteUsage / aggregateSqliteAnalytics and the sync
        -- projection, so a compacted artifact session reports its effective
        -- (current + baseline) tokens and reprices its cost on that total.
        -- baseline_* is NOT NULL DEFAULT 0 → current-only when never compacted.
        COALESCE(SUM(COALESCE(tu.input_tokens, 0) + COALESCE(tu.baseline_input, 0)), 0) AS input_tokens,
        COALESCE(SUM(COALESCE(tu.output_tokens, 0) + COALESCE(tu.baseline_output, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(tu.cache_read_tokens, 0) + COALESCE(tu.baseline_cache_read, 0)), 0) AS cache_read_tokens,
        COALESCE(SUM(COALESCE(tu.cache_write_tokens, 0) + COALESCE(tu.baseline_cache_write, 0)), 0) AS cache_write_tokens,
        SUM(tu.cost_usd_estimated) AS cost_usd_estimated,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.input_tokens, 0) + COALESCE(tu.baseline_input, 0) ELSE 0 END) AS unpriced_input_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.output_tokens, 0) + COALESCE(tu.baseline_output, 0) ELSE 0 END) AS unpriced_output_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_read_tokens, 0) + COALESCE(tu.baseline_cache_read, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_write_tokens, 0) + COALESCE(tu.baseline_cache_write, 0) ELSE 0 END) AS unpriced_cache_write_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_write_1h_tokens, 0) ELSE 0 END) AS unpriced_cache_write_1h_tokens
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      JOIN token_usage tu ON tu.session_id = sal.session_id
      WHERE a.kind = 'closedloop_artifact'
        AND a.slug IN (${placeholders})
      GROUP BY a.slug, tu.model
    `,
    ...slugs
  );

  const sessionCountBySlug = new Map(
    countRows.map((r) => [r.slug, Number(r.session_count)])
  );

  // Group model rows by slug, aggregate tokens + cost.
  const modelRowsBySlug = new Map<string, typeof modelRows>();
  for (const row of modelRows) {
    const existing = modelRowsBySlug.get(row.slug);
    if (existing) {
      existing.push(row);
    } else {
      modelRowsBySlug.set(row.slug, [row]);
    }
  }

  return slugs.map((slug) => {
    const sessionCount = sessionCountBySlug.get(slug) ?? 0;
    const rows = modelRowsBySlug.get(slug);
    if (!rows || rows.length === 0) {
      return {
        artifactSlug: slug,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      };
    }
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCostUsd = 0;
    for (const r of rows) {
      const input = tokenCountValue(r.input_tokens, "artifact.input");
      const output = tokenCountValue(r.output_tokens, "artifact.output");
      const cacheRead = tokenCountValue(
        r.cache_read_tokens,
        "artifact.cache_read"
      );
      const cacheWrite = tokenCountValue(
        r.cache_write_tokens,
        "artifact.cache_write"
      );
      totalInput = addStorageTokenCounts(totalInput, input, "artifact.input");
      totalOutput = addStorageTokenCounts(
        totalOutput,
        output,
        "artifact.output"
      );
      totalCacheRead = addStorageTokenCounts(
        totalCacheRead,
        cacheRead,
        "artifact.cache_read"
      );
      totalCacheWrite = addStorageTokenCounts(
        totalCacheWrite,
        cacheWrite,
        "artifact.cache_write"
      );
      totalCostUsd +=
        Number(r.cost_usd_estimated ?? 0) +
        (resolveTokenUsageCostUsd({
          session_id: "",
          model: r.model,
          input_tokens: tokenCountValue(
            r.unpriced_input_tokens,
            "artifact.unpriced_input"
          ),
          output_tokens: tokenCountValue(
            r.unpriced_output_tokens,
            "artifact.unpriced_output"
          ),
          cache_read_tokens: tokenCountValue(
            r.unpriced_cache_read_tokens,
            "artifact.unpriced_cache_read"
          ),
          cache_write_tokens: tokenCountValue(
            r.unpriced_cache_write_tokens,
            "artifact.unpriced_cache_write"
          ),
          cache_write_1h_tokens: tokenCountValue(
            r.unpriced_cache_write_1h_tokens,
            "artifact.unpriced_cache_write_1h"
          ),
          cost_usd_estimated: null,
        }) ?? 0);
    }
    return {
      artifactSlug: slug,
      sessionCount,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      estimatedCostUsd: totalCostUsd,
    };
  });
}

export async function loadSqliteMeteredUsageRows(
  prisma: DesktopPrisma,
  cutoffIso: string
): Promise<MeteredUsageRow[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      {
        session_id: string;
        started_at: string;
        billing_mode: string | null;
        harness: string | null;
        model: string;
        input_tokens: unknown;
        output_tokens: unknown;
        cache_read_tokens: unknown;
        cache_write_tokens: unknown;
        baseline_input: unknown;
        baseline_output: unknown;
        baseline_cache_read: unknown;
        baseline_cache_write: unknown;
      }[]
    >(
      `
      SELECT
        s.id AS session_id,
        s.started_at AS started_at,
        s.billing_mode AS billing_mode,
        s.harness AS harness,
        tu.model AS model,
        tu.input_tokens AS input_tokens,
        tu.output_tokens AS output_tokens,
        tu.cache_read_tokens AS cache_read_tokens,
        tu.cache_write_tokens AS cache_write_tokens,
        tu.baseline_input AS baseline_input,
        tu.baseline_output AS baseline_output,
        tu.baseline_cache_read AS baseline_cache_read,
        tu.baseline_cache_write AS baseline_cache_write
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      WHERE s.started_at >= $1
      ORDER BY s.started_at ASC, tu.model ASC
    `,
      cutoffIso
    )
  );
  const out: MeteredUsageRow[] = [];
  for (const row of rows) {
    const billingMode = resolveBillingMode({
      billingMode: row.billing_mode,
      harness: row.harness,
    });
    if (!isMeteredApi(billingMode)) {
      continue;
    }
    // FEA-3390: fold the pre-compaction baselines into the effective totals so
    // metered reconciliation compares the full incurred token counts to the
    // provider bill. The raw current columns hold only the post-compaction
    // subset, which would undercount any compacted session (and falsely read as
    // a provider over-charge). Mirrors the cloud-sync per-model fold above.
    out.push({
      sessionId: row.session_id,
      model: row.model,
      startedAt: row.started_at,
      billingMode,
      inputTokens: addStorageTokenCounts(
        row.input_tokens,
        row.baseline_input,
        "metered.input"
      ),
      outputTokens: addStorageTokenCounts(
        row.output_tokens,
        row.baseline_output,
        "metered.output"
      ),
      cacheReadTokens: addStorageTokenCounts(
        row.cache_read_tokens,
        row.baseline_cache_read,
        "metered.cache_read"
      ),
      cacheWriteTokens: addStorageTokenCounts(
        row.cache_write_tokens,
        row.baseline_cache_write,
        "metered.cache_write"
      ),
    });
  }
  return out;
}
