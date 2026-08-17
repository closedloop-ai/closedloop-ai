import { FRUSTRATION_SCORE_VERSION } from "@repo/api/src/frustration-score-contract";
import type { AgentComponentInvocationSyncPart } from "@repo/api/src/types/agent-component-invocation";
import type {
  SyncedActivitySegmentRow,
  SyncedComponent,
  SyncedComponentUsage,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { MAX_SYNCED_COMPONENT_USAGE } from "@repo/api/src/types/agent-session";
import { normalizeActivitySegmentEvidenceLayers } from "@repo/api/src/types/agent-session-activity-evidence";
import type {
  LocalArtifactSessionUsage,
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  COMMIT_SHA_PATTERN,
  deriveBranchParticipationFromEvidence,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  MAX_SYNCED_COMMIT_MESSAGE_LENGTH,
  MAX_SYNCED_SESSION_PR_REFS_PRODUCER,
  PROSE_MENTION_REF_METHODS,
  // FEA-3585: used as a runtime value by toSessionPrRelationType (const-object
  // enum), not just a type — so it moves out of the type-only import block.
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/lib/session-trace/derivation";
import { isMeteredApi } from "../../shared/billing-mode.js";
import {
  computeFrustrationRaw,
  deriveFrustrationInput,
} from "../../shared/frustration-score.js";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import type { AgentComponentInvocationSyncOutboxEntry } from "../agent-sync/agent-component-invocation-sync-service.js";
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
  SyncedAgentSessionAnalytics,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
} from "../agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  OutboxRetryState,
  PersistedSyncState,
  SessionEventCounts,
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
  resolveSessionLastActivityAt,
  SESSION_STARTED_AT_TS_EXPR,
} from "../agent-sync/session-date-window.js";
import { resolveBillingMode } from "../cost/billing-mode-detector.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { addStorageTokenCounts } from "../cost/token-counts.js";
import {
  buildArtifactSessionMarkers,
  mergeSessionMarkers,
} from "../session/session-artifact-markers.js";
import { boundNonCommitArtifactRefs } from "./artifact-ref-budget.js";
import {
  branchLifecycleEventsForBranchLink,
  branchLifecycleEventsForPrLink,
} from "./branch-lifecycle-events.js";
import {
  listAgentComponentCursorRows,
  loadSyncedComponentRows,
} from "./component-sync-source.js";
import { SESSION_STARTED_AT_BOUNDS_EXPR } from "./db-constants.js";
import {
  boundedNonNegativeInt,
  localTimeZone,
  nullableNumber,
  tokenCountValue,
  toolInvocationPredicate,
  validIso,
} from "./db-helpers.js";
import type {
  SqliteAgentRow,
  SqliteArtifactLinkRow,
  SqliteEventRow,
  SqliteGitLocRow,
  SqlitePullRequestLifecycleRow,
  SqlitePullRequestRow,
  SqliteSessionAnalyticsRow,
  SqliteSessionRow,
  SqliteTokenEventRow,
  SqliteTokenUsageRow,
} from "./db-row-types.js";
import { loadReadyInvocationSyncOutboxParts } from "./invocation-sync-outbox-parts.js";
import { prepareInvocationSyncTarget } from "./invocation-sync-promotion.js";
import { COMMIT_SHA_CORRELATION_METHOD } from "./pr-link-maintenance.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "./prisma-client.js";
import {
  resolveAnalyticsRepositoryGroups,
  resolveRepositoryFullNameStoredFirst,
} from "./repository-facet.js";
import { createSessionDetailLinkReaders } from "./session-detail-link-reads.js";
import { listSqliteRepositoryScopedSessionIds } from "./session-repository-scoped-reads.js";
import {
  applyRepoFullNameFillBacks,
  resolveUsageRepoSessionCounts,
} from "./session-usage-aggregate.js";
import {
  persistResolvedRepoFullNames,
  type RepoFullNameWriteBack,
  resolveSyncAttributions,
} from "./sync-attribution-resolution.js";
import { createSyncBurndownReaders } from "./sync-burndown-store.js";
import {
  sqliteAdvanceSyncState,
  sqliteLoadSyncState,
} from "./sync-cursor-state.js";
import {
  sqliteClearOutboxEntries,
  sqliteEnqueueOutboxEntries,
  sqliteLoadPendingOutboxIds,
  sqliteLoadPendingOutboxRetryState,
  sqliteMarkOutboxDeadLettered,
  sqliteRecordOutboxRetry,
  sqliteReEnqueueRecoveredDeadLetter,
} from "./sync-outbox-store.js";
import {
  downgradeMonitoredSessionActivity,
  monitoredActivityOnlyRefsFromMetadata,
  monitoredSessionActivityFromEvidence,
  withoutMonitoredActivityOnlyMetadata,
} from "./synced-monitored-session-activity.js";
import {
  boundedWireString,
  buildPullRequestArtifactRefFacts,
} from "./synced-pull-request-ref.js";
import { selectTokenEventRows } from "./token-event-columns.js";
import { mapSyncedTokenEvent } from "./token-event-sync.js";

// ---------------------------------------------------------------------------
// T-8.6: Agent component inventory cursor row + usage row types
// ---------------------------------------------------------------------------

/** Per-session usage row from `agent_component_session_usage`. */
type SqliteComponentUsageRow = {
  session_id: string;
  component_kind: string;
  component_key: string;
  // FEA-2990: '' sentinel for branch-less buckets; carried to the cloud so it
  // can attribute component usage per-branch when present.
  git_branch: string;
  agent_component_id: string | null;
  harness: string | null;
  invocations: number;
  error_count: number;
  component_version_hash: string | null;
  first_invoked_at: string | null;
  last_invoked_at: string | null;
};

import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import {
  buildListCursorFilterClause,
  buildUsageFilterClause,
  countSqliteSessionsForFilters,
  listCursorPageSortExpression,
} from "./session-aggregate-filters.js";
import { countSqliteSessions } from "./session-count.js";
import {
  groupRowsBySessionId,
  selectRowsByIds,
} from "./session-detail-mappers.js";
import {
  buildDiffStats,
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  resolveArtifactLinkBranch,
  resolveTraceEndMs,
} from "./session-trace.js";
import {
  ACTIVITY_SEGMENT_SYNC_MAX_ROWS,
  resolveEventRowFetchLimit,
  type SyncedSegmentQueryRow,
  selectBoundedActivitySegments,
  selectEventRows,
  selectSessionEventCounts,
} from "./sync-source-bounded-reads.js";
import { persistLocalFrustration } from "./sync-source-frustration-writeback.js";
import {
  findSqliteExistingSessionIds,
  findSqliteLocallyOversizedSessions,
  selectSessionRows,
  sqliteFlagToNullableBoolean,
} from "./sync-source-session-rows.js";
import {
  chunkIds,
  planSyncedSessionHydration,
  SYNCED_SESSION_HYDRATE_CHUNK_SIZE,
} from "./synced-session-hydration-plan.js";
import { mapTraceTokenEvents } from "./trace-token-event-mapper.js";

export function createSqliteSessionSyncSource(
  prisma: DesktopPrisma,
  // FEA-3568: the desktop diagnostic sink (openSqliteAgentDatabase's `options.log`)
  // so the sync assembly can surface an over-cap activity-segment truncation.
  log: (message: string) => void = () => {
    // no-op default so existing/test call sites need no change
  }
): AgentSessionSyncSource {
  return {
    // ISS-5387: the aggregate, read-only burn-down reads. Kept in their own
    // module so this grandfathered file carries the wiring only.
    ...createSyncBurndownReaders(prisma),
    // ISS-5567 / ISS-5617: the session-scoped LINK reads the session detail
    // needs — its branch artifact, and its unbounded document links.
    ...createSessionDetailLinkReaders(prisma),
    async listAllSessionCursorRows(): Promise<SessionCursorRow[]> {
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(`
        SELECT id, updated_at
        FROM sessions
        ORDER BY updated_at DESC, id DESC
      `)
      );
    },
    // ISS-4535 (@wongk) / ISS-4558: the pre-hydration Repository-facet id read,
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
    // row, e.g. a historical import stamps `updated_at = endedAt ?? startedAt`,
    // or two writes land in the same millisecond).
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
    // This is safe because `sessions.updated_at` is stamped to a
    // monotonically-advancing `now` on every content change (write-core
    // `UPDATE sessions SET updated_at = now`), so a genuinely-changed row lands
    // at `updated_at > cursorTs` and is caught by the first disjunct; the
    // second disjunct additionally rescues a NEW row that legitimately shares the
    // top timestamp. `id` is stored raw (uuid) and is unique.
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
        log
      );
      // FEA-4022: cache the sync-time frustration signal back into the local
      // `sessions` column so the desktop's own surfaces can read it without
      // recomputing, and a resync does not have to re-derive it. Best-effort:
      // the authoritative value already rides in the returned payload, so a
      // write-back failure must not fail the sync.
      await persistLocalFrustration(prisma, sessions).catch(() => {
        // Non-fatal — the payload still carries the computed value.
      });
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
    loadSessionEventCounts(
      ids: string[]
    ): Promise<Map<string, SessionEventCounts>> {
      return prisma.read((reader) => selectSessionEventCounts(reader, ids));
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
     */
    aggregateUsage(
      filters: AgentSessionUsageAggregateFilters
    ): Promise<AgentSessionUsageAggregate> {
      // FEA-4299: the Repository facet options fold resolves each distinct cwd
      // to its `repositoryFullName`; a fresh per-request attribution cache keeps
      // those lookups consistent within this read (as `aggregateAnalytics` does).
      return aggregateSqliteUsage(prisma, filters, {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      });
    },
    /**
     * FEA-4142: metadata-only `COUNT(*)` for the count-only badge read. One
     * grouped SQL read over the `sessions` table replaces hydrating the corpus
     * into JS just to size the list. The `(status, ended_at)` partial index
     * (migration 0038) covers the badge's status filter and the indexed
     * `ended_at` values the instant-aware completion bound scans.
     */
    countSessions(filters: AgentSessionCountFilters): Promise<number> {
      return countSqliteSessionsForFilters(prisma, filters);
    },
    /**
     * FEA-2038: O(grouped) analytics aggregation. Three grouped reads in one
     * transaction (byTool over events, byAgentType over agents, byRepository
     * over per-cwd token/error rollups) replace hydrating the whole filtered
     * corpus into JS — the db-host OOM (exit code 5). The cwd→repositoryFullName
     * resolution and final fold live in `getSharedAgentSessionAnalytics`; the
     * shared `cache` keeps attribution lookups consistent with the read request.
     */
    async aggregateAnalytics(
      filters: AgentSessionUsageAggregateFilters,
      cache: SessionAttributionResolverCache
    ): Promise<AgentSessionAnalyticsAggregate> {
      try {
        return await aggregateSqliteAnalytics(prisma, filters, cache);
      } catch {
        // Degrade to the empty aggregate rather than failing the analytics read
        // (e.g. transient storage corruption recovered on the next refresh).
        return emptyAgentSessionAnalyticsAggregate();
      }
    },
    // FEA-3781: durable delivery state lives beside this module, one file per
    // table — ./sync-cursor-state.ts (the keyset cursor) and
    // ./sync-outbox-store.ts (the per-session outbox). This module builds sync
    // PAYLOADS; what has already been delivered is a separate concern.
    // Delegated one-for-one so the source's shape is unchanged.
    loadSyncState(sourceKey: string): Promise<PersistedSyncState | null> {
      return sqliteLoadSyncState(prisma, sourceKey);
    },
    advanceSyncState(
      sourceKey: string,
      state: PersistedSyncState
    ): Promise<void> {
      return sqliteAdvanceSyncState(prisma, sourceKey, state);
    },
    enqueueOutboxEntries(
      sourceKey: string,
      entries: AgentSessionOutboxEntry[]
    ): Promise<void> {
      return sqliteEnqueueOutboxEntries(prisma, sourceKey, entries);
    },
    clearOutboxEntries(sourceKey: string, ids: string[]): Promise<void> {
      return sqliteClearOutboxEntries(prisma, sourceKey, ids);
    },
    recordOutboxRetry(
      sourceKey: string,
      id: string,
      attemptCount: number,
      nextAttemptAt: string,
      reason: string
    ): Promise<void> {
      return sqliteRecordOutboxRetry(
        prisma,
        sourceKey,
        id,
        attemptCount,
        nextAttemptAt,
        reason
      );
    },
    markOutboxDeadLettered(
      sourceKey: string,
      id: string,
      reason: string,
      attemptCount = 0
    ): Promise<void> {
      return sqliteMarkOutboxDeadLettered(
        prisma,
        sourceKey,
        id,
        reason,
        attemptCount
      );
    },
    reEnqueueRecoveredDeadLetter(sourceKey: string, id: string): Promise<void> {
      return sqliteReEnqueueRecoveredDeadLetter(prisma, sourceKey, id);
    },
    loadPendingOutboxIds(sourceKey: string): Promise<string[]> {
      return sqliteLoadPendingOutboxIds(prisma, sourceKey);
    },
    loadPendingOutboxRetryState(
      sourceKey: string
    ): Promise<OutboxRetryState[]> {
      return sqliteLoadPendingOutboxRetryState(prisma, sourceKey);
    },
    prepareInvocationSyncTarget(
      sourceKey: string,
      templateSourceKey: string,
      sessionLimit: number
    ): Promise<void> {
      // ISS-5789: the promotion step itself lives in
      // `invocation-sync-promotion.ts` — its own responsibility, and the one
      // PRD-635 diagnosed. This stays a one-for-one delegation.
      return prepareInvocationSyncTarget(
        prisma,
        sourceKey,
        templateSourceKey,
        sessionLimit
      );
    },
    loadReadyInvocationSyncParts(
      sourceKey: string,
      now: string,
      limit: number
    ): Promise<AgentComponentInvocationSyncOutboxEntry[]> {
      // FEA-3781 split: the invocation outbox's ready-parts read (and the
      // quarantine of an unparseable persisted payload) is owned by its own
      // table module; this stays a one-for-one delegation.
      return loadReadyInvocationSyncOutboxParts(prisma, sourceKey, now, limit);
    },
    async recordInvocationSyncRetry(
      sourceKey: string,
      part: AgentComponentInvocationSyncPart,
      attemptCount: number,
      nextAttemptAt: string,
      error: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.updateMany({
          where: {
            sourceKey,
            externalSessionId: part.externalSessionId,
            externalGenerationId: part.externalGenerationId,
            partIndex: part.partIndex,
            partHash: part.partHash,
            status: OutboxStatus.Pending,
          },
          data: {
            attemptCount,
            nextAttemptAt,
            lastError: error,
            updatedAt: new Date().toISOString(),
          },
        })
      );
    },
    async clearAcknowledgedInvocationSyncPart(
      sourceKey,
      ack
    ): Promise<boolean> {
      const result = await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.deleteMany({
          where: {
            sourceKey,
            externalGenerationId: ack.externalGenerationId,
            partIndex: ack.partIndex,
            partHash: ack.partHash,
            status: OutboxStatus.Pending,
          },
        })
      );
      return result.count === 1;
    },
    async deadLetterInvocationSyncPart(
      sourceKey,
      part,
      attemptCount,
      error
    ): Promise<boolean> {
      const result = await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.updateMany({
          where: {
            sourceKey,
            externalSessionId: part.externalSessionId,
            externalGenerationId: part.externalGenerationId,
            partIndex: part.partIndex,
            partHash: part.partHash,
            status: OutboxStatus.Pending,
          },
          data: {
            status: OutboxStatus.DeadLettered,
            attemptCount,
            nextAttemptAt: null,
            lastError: error,
            updatedAt: new Date().toISOString(),
          },
        })
      );
      return result.count === 1;
    },
    async loadSessionTokenEvents(
      sessionId: string
    ): Promise<TokenEventCostPoint[]> {
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<
          { created_at: string; cost_usd_estimated: number | null }[]
        >(
          "SELECT created_at, cost_usd_estimated FROM token_events WHERE session_id = ? ORDER BY created_at",
          sessionId
        )
      );
      const result: TokenEventCostPoint[] = [];
      for (const row of rows) {
        const tMs = Date.parse(row.created_at);
        if (!Number.isFinite(tMs)) {
          continue;
        }
        result.push({ tMs, costUsd: row.cost_usd_estimated ?? 0 });
      }
      return result;
    },
    // Gap B (#2570 follow-up): expose the component inventory readers on the
    // sync source so the sync service's component lane can batch-read updated
    // `agent_components` and pack them for `POST /desktop/components/sync`.
    async listComponentCursorRows(
      sinceTs: string,
      sinceId: string,
      limit: number
    ) {
      return listAgentComponentCursorRows(prisma, sinceTs, sinceId, limit);
    },
    async loadComponentRows(ids: string[]): Promise<SyncedComponent[]> {
      return loadSyncedComponentRows(prisma, ids);
    },
  };
}

/**
 * T-8.6: Load per-session component usage rows for the given session ids.
 * Grouped by session_id via the returned Map; used by assembleSyncedSessions
 * to emit `components: SyncedComponentUsage[]` on each session object.
 */
export async function selectComponentUsageRows(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<Map<string, SqliteComponentUsageRow[]>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await selectRowsByIds<SqliteComponentUsageRow>(
    reader,
    `
    SELECT
      session_id,
      component_kind,
      component_key,
      git_branch,
      agent_component_id,
      harness,
      invocations,
      error_count,
      component_version_hash,
      first_invoked_at,
      last_invoked_at
    FROM agent_component_session_usage
    WHERE session_id IN (__IDS__)
    ORDER BY session_id ASC, component_kind ASC, component_key ASC, git_branch ASC
    `,
    ids
  );
  const grouped = new Map<string, SqliteComponentUsageRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.session_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.session_id, [row]);
    }
  }
  return grouped;
}

/**
 * Lightweight page cursor for the renderer Sessions list. The default desktop
 * list sort is genuine activity, which is derivable from `events.created_at`
 * plus the session start floor; computing that in SQL lets the list hydrate
 * only the visible page instead of every local session.
 */
async function listSqliteSessionCursorPage(
  prisma: DesktopPrisma,
  request: SessionListCursorPageRequest
): Promise<SessionListCursorPage> {
  const direction = request.sortDir === "asc" ? "ASC" : "DESC";
  const tieDirection = request.sortDir === "asc" ? "ASC" : "DESC";
  const { clause, params } = buildListCursorFilterClause(request);
  // Perf: the last-activity sort reads the denormalized `last_activity_at`
  // column (maintained at ingest by `recomputeSessionLastActivityAt` / the
  // migration backfill) instead of recomputing `MAX(events.created_at)` via a
  // whole-table LEFT JOIN + GROUP BY on every page. The stored value IS exactly
  // the old `COALESCE(MAX(<guarded events.created_at>), <guarded started_at
  // floor>)`, so the ordering and rows are identical. The column is NOT NULL
  // (epoch-floor default, see migration 0005), so the read can ORDER BY the bare
  // column directly — letting `idx_sessions_last_activity` satisfy the sort
  // instead of forcing a temp-b-tree filesort, which a COALESCE wrapper would.
  // `Started` uses the started-at floor, `Updated` (stage 1b) the bare column.
  const sortExpression = listCursorPageSortExpression(request.sortBy);
  // Two independent reads, each its own prisma.read so they round-robin onto
  // separate reader connections and run in parallel (the count is an approximate
  // total — no cross-read snapshot requirement between them). Both carry the
  // SQL-side list filter (buildListCursorFilterClause): the default-7-day +
  // sidebar-search filters run here so only matching rows are hydrated.
  const pageParams = [...params, request.limit, request.offset];
  const limitPlaceholder = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;
  const [total, pageRows] = await Promise.all([
    // SSOT count helper (FEA-2211) — shared with the IPC perf `session_count`
    // dimension so the two never diverge. Carries the same SQL-side list filter.
    prisma.read((reader) => countSqliteSessions(reader, clause, params)),
    prisma.read((reader) =>
      reader.$queryRawUnsafe<SessionCursorRow[]>(
        `
        WITH activity AS (
          SELECT
            s.id,
            s.updated_at,
            ${SESSION_STARTED_AT_SORT_EXPRESSION} AS sort_started_at,
            s.last_activity_at AS sort_last_activity_at
          FROM sessions s
          ${clause}
        )
        SELECT id, updated_at
        FROM activity
        ORDER BY ${sortExpression} ${direction}, id ${tieDirection}
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `,
        ...pageParams
      )
    ),
  ]);
  return {
    rows: pageRows,
    total,
  };
}

// FEA-2036: started-at floor expression for the cursor pagination sort. SQLite
// dialect — the GLOB date-prefix guard mirrors SESSION_STARTED_AT_TS_EXPR. The
// per-event MAX(created_at) that used to be computed here now lives denormalized
// in `sessions.last_activity_at` (see recomputeSessionLastActivityAt); this floor
// remains the `Started` sort key and the COALESCE fallback for un-ingested rows.
const SESSION_STARTED_AT_SORT_EXPRESSION = SESSION_STARTED_AT_TS_EXPR;

async function aggregateSqliteUsage(
  prisma: DesktopPrisma,
  filters: AgentSessionUsageAggregateFilters,
  cache: SessionAttributionResolverCache
): Promise<AgentSessionUsageAggregate> {
  const { clause, params } = buildUsageFilterClause(filters);

  // Run all reads inside one reader-pool snapshot transaction so a sync-cycle
  // write cannot interleave between them (the event loop yields at each await).
  // Without the shared snapshot, a session inserted in the gap would appear in
  // the harness count but not the token groups — or, on a delete, the inverse —
  // transiently miscounting totalSessions until the next refresh. The reader's
  // `deferred` (query_only) transaction pins one committed snapshot for all
  // reads, concurrent with the writer.
  const {
    tokenRows,
    harnessRows,
    primaryModelRows,
    userRows,
    repoRows,
    boundsRow,
  } = await prisma.read((reader) =>
    reader.$transaction(async (tx) => {
      const tokenResult = await tx.$queryRawUnsafe<
        {
          billing_mode: string | null;
          harness: string | null;
          model: string | null;
          input_tokens: string | null;
          output_tokens: string | null;
          cache_read_tokens: string | null;
          cache_write_tokens: string | null;
          session_count: number | null;
          estimated_cost_usd: number | null;
          unpriced_input_tokens: string | null;
          unpriced_output_tokens: string | null;
          unpriced_cache_read_tokens: string | null;
          unpriced_cache_write_tokens: string | null;
          unpriced_cache_write_1h_tokens: string | null;
        }[]
      >(
        `
        SELECT
          s.billing_mode AS billing_mode,
          s.harness AS harness,
          t.model AS model,
          -- FEA-3317: report the EFFECTIVE total (current + pre-compaction
          -- baseline_*) for every row, mirroring the sync projection's
          -- unconditional fold (loadSyncedSessions → tokenUsageByModel) so the
          -- reported token counts stay at SQL-vs-hydrate parity for compacted
          -- rows. Without this, foldUsageAggregate would show a baseline-priced
          -- cost against an undercounted token count. baseline_* is NOT NULL
          -- DEFAULT 0, so this reduces to the current-only value when never
          -- compacted.
          SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)) AS input_tokens,
          SUM(COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)) AS output_tokens,
          SUM(COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0)) AS cache_read_tokens,
          SUM(COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0)) AS cache_write_tokens,
          COUNT(DISTINCT t.session_id) AS session_count,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          -- FEA-3317: an unpriced compacted row is repriced on the fly below via
          -- resolveTokenUsageCostUsd over these sums, so they must carry the
          -- EFFECTIVE total (current + pre-compaction baseline_*), mirroring the
          -- boot reprice in token-cost-maintenance.ts (repriceUnpricedTokenUsageChunk) and the
          -- FEA-2922 sync projection. Without the fold, a post-compaction pricing
          -- miss reprices only the post-compaction subset and undercounts cost.
          -- baseline_* is NOT NULL DEFAULT 0, so COALESCE is defensive and reduces
          -- to the current-only value for never-compacted rows.
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

      const harnessResult = await tx.$queryRawUnsafe<
        {
          harness: string | null;
          session_count: number | null;
        }[]
      >(
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
      const primaryModelResult = await tx.$queryRawUnsafe<
        {
          model: string | null;
          session_count: number | null;
        }[]
      >(
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
      const userResult = await tx.$queryRawUnsafe<
        {
          user_id: string | null;
          session_count: number | null;
        }[]
      >(
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
      const repoResult = await tx.$queryRawUnsafe<
        {
          cwd: string | null;
          repo_full_name: string | null;
          session_count: number | null;
        }[]
      >(
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
      const boundsResult = await tx.$queryRawUnsafe<
        {
          earliest_session_at: string | null;
          latest_session_at: string | null;
        }[]
      >(
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
    })
  );

  const tokenGroups = tokenRows.map((row) => ({
    billingMode: row.billing_mode,
    harness: row.harness,
    model: row.model,
    inputTokens: tokenCountValue(row.input_tokens, "insights.input"),
    outputTokens: tokenCountValue(row.output_tokens, "insights.output"),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "insights.cache_read"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "insights.cache_write"
    ),
    sessionCount: Number(row.session_count ?? 0),
    estimatedCostUsd:
      (nullableNumber(row.estimated_cost_usd) ?? 0) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "insights.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "insights.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "insights.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "insights.unpriced_cache_write"
        ),
        cache_write_1h_tokens: tokenCountValue(
          row.unpriced_cache_write_1h_tokens,
          "insights.unpriced_cache_write_1h"
        ),
        cost_usd_estimated: null,
      }) ?? 0),
  }));

  const harnessSessionCounts = harnessRows.map((row) => ({
    harness: row.harness,
    sessionCount: Number(row.session_count ?? 0),
  }));

  const primaryModelSessionCounts = primaryModelRows.map((row) => ({
    model: row.model,
    sessionCount: Number(row.session_count ?? 0),
  }));

  const userSessionCounts = userRows.map((row) => ({
    userId: row.user_id,
    sessionCount: Number(row.session_count ?? 0),
  }));

  // ISS-5271: stored-first Repository-facet fold (see session-usage-aggregate).
  // The grouped reads above already materialized their rows, so the fill-back
  // write runs strictly outside the reader transaction, through the write queue.
  // Supersedes the ISS-5272 yield cadence this loop briefly carried: stored-first
  // makes the fold map-lookups plus at most a handful of one-time live
  // resolutions, so there is no per-row execFile await left to yield around.
  const { repoSessionCounts, fillBackIntents } =
    await resolveUsageRepoSessionCounts(repoRows, cache);
  await applyRepoFullNameFillBacks(prisma, fillBackIntents);

  const totalSessions = harnessSessionCounts.reduce(
    (sum, entry) => sum + entry.sessionCount,
    0
  );

  return {
    totalSessions,
    earliestSessionAt: boundsRow?.earliest_session_at ?? null,
    latestSessionAt: boundsRow?.latest_session_at ?? null,
    tokenGroups,
    harnessSessionCounts,
    primaryModelSessionCounts,
    userSessionCounts,
    repoSessionCounts,
  };
}

/**
 * FEA-2038: the empty analytics aggregate. Used as the graceful fallback /
 * base when the filtered corpus contributes no rows.
 */
function emptyAgentSessionAnalyticsAggregate(): AgentSessionAnalyticsAggregate {
  return { byTool: [], byAgentType: [], byRepository: [] };
}

// FEA-2038: the error/fail predicate over an event's `event_type`, mirroring
// `ERROR_EVENT_PATTERN = /error|fail/i` in shared-agent-sessions-api.ts. SQLite
// has no case-insensitive regex, so lower() + LIKE substring matches the
// `/i` substring test exactly (the pattern has no anchors/metacharacters).
const ANALYTICS_EVENT_ERROR_PREDICATE =
  "(lower({col}) LIKE '%error%' OR lower({col}) LIKE '%fail%')";

// FEA-2038: integer-ms-since-epoch for a canonical `toISOString()` value
// (`YYYY-MM-DDTHH:MM:SS.mmmZ`), else 0 — matching `new Date(iso).getTime()` and
// `parseSessionDate`'s NaN→epoch(0) fallback. NOT julianday (it drifts and
// fails the golden parity test). `{col}` is substituted with the column ref.
function analyticsIsoMsExpr(col: string): string {
  return (
    `(CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' ` +
    `THEN CAST(strftime('%s', ${col}) AS INTEGER) * 1000 + CAST(substr(${col}, 21, 3) AS INTEGER) ` +
    "ELSE 0 END)"
  );
}

/**
 * FEA-2038: O(grouped) analytics aggregation. Runs three grouped reads in ONE
 * transaction over the SAME filtered session set that `buildUsageFilterClause`
 * selects (reused verbatim so the corpus matches the hydrate filter), then
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
  const { clause, params } = buildUsageFilterClause(filters);

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

  const { toolRows, agentRows, repoRows, repoCostRows } = await prisma.read(
    (reader) =>
      reader.$transaction(async (tx) => {
        const toolResult = await tx.$queryRawUnsafe<
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
        -- ISS-5493: the tool predicate now excludes the empty string as well as
        -- NULL, via the shared toolInvocationPredicate helper. The canonical
        -- buildAnalytics fold this query mirrors skips an event on the falsy
        -- !event.toolName test, so a hook payload carrying an empty tool_name
        -- (live-hook.ts stores it verbatim) produced a meaningless empty-named
        -- group here and none there — a SQL-vs-hydrate divergence the FEA-2038
        -- parity contract below is meant to forbid. Still a partial-index
        -- match: idx_events_tool_session is partial on tool_name IS NOT NULL.
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

        // FEA-2264: yield the db-host loop between the bounded aggregate reads
        // so a queued renderer read is serviced between them rather than waiting
        // for the whole batch. The single transaction is preserved, so the four
        // breakdowns still see one consistent snapshot.
        await yieldDbHostLoop();

        // byAgentType — agents joined to the filtered sessions, grouped by the
        // COALESCE(subagent_type, type, 'unknown') identity.
        const agentResult = await tx.$queryRawUnsafe<
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

        await yieldDbHostLoop();

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

        await yieldDbHostLoop();

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
          toolRows: toolResult,
          agentRows: agentResult,
          repoRows: repoResult,
          repoCostRows: repoCostResult,
        };
      })
  );

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

function selectTokenUsageRows(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<SqliteTokenUsageRow[]> {
  return selectRowsByIds<SqliteTokenUsageRow>(
    reader,
    `
      SELECT
        session_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_write_5m_tokens,
        cache_write_1h_tokens,
        baseline_input,
        baseline_output,
        baseline_cache_read,
        baseline_cache_write,
        created_at,
        cost_usd_estimated
      FROM token_usage
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, model ASC
    `,
    ids
  );
}

/**
 * Full load: session metadata plus every hydrated relation (agents, events,
 * token_events, artifact_links) and resolved attribution. Used by detail/list
 * reads. Shares the per-session assembly with the usage load via
 * `assembleSyncedSessions`, so the two can never project a session differently.
 *
 * ISS-6105: hydrates in chunks whose boundaries are planned against each
 * session's estimated heap (`planSyncedSessionHydration`), so peak tracks a
 * working-set budget rather than the caller's id count. The attribution `cache`
 * is shared across chunks so cross-chunk cwd resolution is still de-duplicated.
 *
 * FEA-2038 OOM fix: `options.omitEventData` drops the per-event `data` JSON blob
 * (it is still SELECTed for `tool_name`/`event_type`, but the multi-KB parsed
 * `data` object is NOT retained). The full-corpus read callers — the sessions
 * LIST and ANALYTICS paths — only read `event.toolName`/`event.eventType` (never
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
  }
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
      loadSqliteSyncedSessionsChunk(reader, ids, cache, options, log)
    );
    // FEA-3555: flush the durable repo-name write-backs AFTER the read closes,
    // so the `prisma.write` never nests inside the `prisma.read` above.
    await persistResolvedRepoFullNames(prisma, chunk.repoFullNameWriteBacks);
    return chunk.sessions;
  }
  const out: SyncedAgentSession[] = [];
  const chunks = await planSyncedSessionHydration(prisma, ids, options, log);
  for (let i = 0; i < chunks.length; i++) {
    const loaded = await prisma.read((reader) =>
      loadSqliteSyncedSessionsChunk(reader, chunks[i], cache, options, log)
    );
    for (const session of loaded.sessions) {
      out.push(session);
    }
    // FEA-3555: persist this chunk's repo-name write-backs outside the read.
    await persistResolvedRepoFullNames(prisma, loaded.repoFullNameWriteBacks);
    // FEA-2264: yield a macrotask between chunks so a full-corpus hydration (the
    // list/analytics filtered fallback and the cloud-sync payload build) cannot
    // hold the db-host loop for multiple seconds in one go. SQLite is
    // synchronous on this single JS thread, so without a real loop turn the
    // queued renderer reads stay blocked across every chunk; a `setImmediate`
    // boundary lets them interleave at chunk granularity. The skip on the final
    // chunk avoids an idle turn before returning. Concatenation order is
    // unchanged, so the assembled result is identical to a single load.
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
  }
): Promise<SyncedSessionsChunk> {
  if (ids.length === 0) {
    return { sessions: [], repoFullNameWriteBacks: [] };
  }
  const sessionRows = await selectSessionRows(reader, ids, options);
  const tokenRows = await selectTokenUsageRows(reader, ids);
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
        task,
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
  // multi-KB `data` text for every event of the WHOLE corpus (the list/analytics
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
  // `evidence_layers` column are parsed for us. ISS-4541: the FULL tiling is read
  // and shipped (chunked across sync parts when oversized — no transport-cap
  // truncation), so the DB `take` is now a memory-safety ceiling
  // (ACTIVITY_SEGMENT_SYNC_MAX_ROWS, far above any realistic tiling), NOT a data
  // cap: a single unbounded `IN (...)` load of tens of thousands of rows would
  // run synchronously on the shared db-host thread every sync cycle — starving
  // every other reader and locking up the app. NB: the bound must be per session;
  // one `take` on a multi-id `IN (...)` query caps the TOTAL across the batch
  // (rows ordered by sessionId), which would silently drop later sessions'
  // segments entirely.
  const segmentRows = await selectBoundedActivitySegments(reader, ids);
  // FEA-2730 (G10): the desktop per-session analytics rollup. `session_id` is
  // the table's primary key, so this yields at most one row per session.
  const sessionAnalyticsRows = await selectRowsByIds<SqliteSessionAnalyticsRow>(
    reader,
    `
      SELECT
        session_id,
        started_at,
        started_day,
        status,
        harness,
        is_human,
        human_turns,
        agent_turns,
        event_count,
        tool_invocations,
        error_events,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        est_cost,
        runtime_ms,
        updated_at
      FROM session_analytics
      WHERE session_id IN (__IDS__)
    `,
    ids
  );
  const artifactLinkRows = await selectRowsByIds<SqliteArtifactLinkRow>(
    reader,
    `
      SELECT
        sal.id AS link_id,
        sal.session_id,
        a.kind AS target_kind,
        a.slug,
        sal.is_primary,
        sal.method,
        sal.evidence AS link_evidence,
        a.repo_full_name,
        a.pr_number,
        a.url,
        sal.relation,
        a.sha,
        a.title,
        a.branch_name,
        a.pr_state,
        a.lines_added,
        a.lines_removed,
        a.files_changed,
        sal.observed_at AS link_observed_at,
        a.committed_at AS artifact_committed_at,
        a.observed_at AS artifact_observed_at,
        a.last_seen_at AS artifact_last_seen_at,
        -- FEA-3329: AUTHORITATIVE PR-opened instant from pull_requests.opened_at
        -- (GitHub metadata via enrichment). A correlated MIN() picks the earliest
        -- known opened time for this (repo, number) so the join stays 1:1 with the
        -- link row (pull_requests holds one row per (harness, session, pr_url), so
        -- the same PR can appear across sessions). NULL until the PR is enriched;
        -- the marker builder then falls back to the observed timestamps.
        (
          SELECT MIN(pr.opened_at)
          FROM pull_requests pr
          WHERE pr.repo_full_name = a.repo_full_name
            AND pr.pr_number = a.pr_number
        ) AS pr_opened_at
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id IN (__IDS__)
      ORDER BY sal.session_id ASC, sal.created_at ASC
    `,
    ids
  );
  const pullRequestRows = await selectRowsByIds<SqlitePullRequestRow>(
    reader,
    `
      SELECT session_id, pr_number, repo_full_name, title, state,
        closed_at, merged_at, observed_at
      FROM (
        SELECT
          sal.session_id AS session_id,
          a.pr_number AS pr_number,
          a.repo_full_name AS repo_full_name,
          a.title AS title,
          UPPER(a.pr_state) AS state,
          NULL AS closed_at,
          NULL AS merged_at,
          a.last_seen_at AS observed_at,
          ROW_NUMBER() OVER (
            PARTITION BY sal.session_id, a.pr_number, a.repo_full_name
            ORDER BY a.last_seen_at DESC
          ) AS rn
        FROM session_artifact_links sal
        JOIN artifacts a ON a.id = sal.artifact_id
        WHERE sal.session_id IN (__IDS__)
          AND a.kind = 'pull_request'
          AND a.pr_number IS NOT NULL
          AND (sal.relation IN ('created', 'workspace')
               OR sal.method = 'harness_pr_link')
      ) ranked
      WHERE rn = 1
      ORDER BY session_id, pr_number, repo_full_name
    `,
    ids
  );
  // FEA-2732: PR lifecycle facts the `artifacts` row doesn't carry — merged/closed
  // timestamps from the per-session `pull_requests` store, plus the latest
  // `is_draft` observation. Keyed per session by (repo_full_name, pr_number) to
  // enrich the `pull_request` artifactRef the cloud syncs into PullRequestDetail.
  const pullRequestLifecycleRows =
    await selectRowsByIds<SqlitePullRequestLifecycleRow>(
      reader,
      `
      SELECT
        pr.session_id AS session_id,
        pr.pr_number AS pr_number,
        pr.repo_full_name AS repo_full_name,
        pr.merged_at AS merged_at,
        pr.closed_at AS closed_at,
        obs.is_draft AS is_draft
      FROM pull_requests pr
      LEFT JOIN (
        SELECT repo_full_name, pr_number, is_draft,
          ROW_NUMBER() OVER (
            PARTITION BY repo_full_name, pr_number
            ORDER BY observed_at DESC
          ) AS rn
        FROM pull_request_status_observations
      ) obs
        ON obs.repo_full_name = pr.repo_full_name
        AND obs.pr_number = pr.pr_number
        AND obs.rn = 1
      WHERE pr.session_id IN (__IDS__)
        AND pr.pr_number IS NOT NULL
        AND pr.repo_full_name IS NOT NULL
    `,
      ids
    );
  // FEA-1899: git LOC rollup. Only sessions that actually committed code
  // (have 'created' commit links) get LOC attributed. Review-only sessions
  // get 0. Prefers per-commit stats when enriched; falls back to branch/PR
  // stats when commit SHAs are invalid (RTK strips them). The gate is
  // "has_created_commits" — a session must have at least one 'created'
  // commit link to qualify, even if the commits themselves aren't enriched.
  const gitLocRows = await selectRowsByIds<SqliteGitLocRow>(
    reader,
    `
      WITH authored_sessions AS (
        SELECT DISTINCT session_id
        FROM session_artifact_links
        WHERE session_id IN (__IDS__)
          AND relation = 'created'
          AND artifact_id IN (SELECT id FROM artifacts WHERE kind = 'commit')
      )
      SELECT session_id, total_added, total_removed, total_files, loc_basis
      FROM (
        SELECT session_id, total_added, total_removed, total_files, loc_basis,
          ROW_NUMBER() OVER (
            PARTITION BY session_id ORDER BY priority
          ) AS rn
        FROM (
          SELECT
            sal.session_id AS session_id,
            COALESCE(SUM(a.lines_added), 0) AS total_added,
            COALESCE(SUM(a.lines_removed), 0) AS total_removed,
            COALESCE(SUM(a.files_changed), 0) AS total_files,
            -- FEA-3633: authored-commit sums are genuinely per-session.
            'commit' AS loc_basis,
            1 AS priority
          FROM session_artifact_links sal
          JOIN artifacts a ON sal.artifact_id = a.id
          WHERE sal.session_id IN (__IDS__)
            AND sal.relation = 'created'
            AND a.kind = 'commit'
            AND a.lines_added IS NOT NULL
          GROUP BY sal.session_id
          HAVING SUM(a.lines_added) > 0 OR SUM(a.lines_removed) > 0
          UNION ALL
          SELECT
            sal.session_id,
            COALESCE(a.lines_added, 0),
            COALESCE(a.lines_removed, 0),
            COALESCE(a.files_changed, 0),
            -- FEA-3633: the branch/PR-total fallback is the SAME total shared by
            -- every authoring session on the branch — tag it so the cloud can
            -- dedup it per branch instead of summing it once per session.
            'branch_fallback' AS loc_basis,
            CASE a.kind WHEN 'branch' THEN 2 ELSE 3 END AS priority
          FROM session_artifact_links sal
          JOIN artifacts a ON sal.artifact_id = a.id
          JOIN authored_sessions auth ON auth.session_id = sal.session_id
          WHERE sal.session_id IN (__IDS__)
            AND a.kind IN ('branch', 'pull_request')
            AND sal.relation IN ('created', 'workspace')
            AND a.lines_added IS NOT NULL
        ) sources
      ) ranked
      WHERE rn = 1
      ORDER BY session_id
    `,
    ids
  );
  // Branch/PR LOC for all sessions on the branch (ungated — review sessions
  // see the branch total for context, even though their authored LOC is 0).
  const branchLocRows = await selectRowsByIds<SqliteGitLocRow>(
    reader,
    `
      SELECT session_id, total_added, total_removed, total_files
      FROM (
        SELECT
          sal.session_id AS session_id,
          COALESCE(a.lines_added, 0) AS total_added,
          COALESCE(a.lines_removed, 0) AS total_removed,
          COALESCE(a.files_changed, 0) AS total_files,
          ROW_NUMBER() OVER (
            PARTITION BY sal.session_id
            ORDER BY CASE a.kind WHEN 'branch' THEN 1 ELSE 2 END
          ) AS rn
        FROM session_artifact_links sal
        JOIN artifacts a ON sal.artifact_id = a.id
        WHERE sal.session_id IN (__IDS__)
          AND a.kind IN ('branch', 'pull_request')
          AND sal.relation IN ('created', 'workspace')
          AND a.lines_added IS NOT NULL
      ) ranked
      WHERE rn = 1
      ORDER BY session_id
    `,
    ids
  );
  // T-8.6: per-session component usage — additive on the cloud-sync payload.
  // FEA-2718 decoupled this from `omitEventData`: the sync payload builder now
  // sets `omitEventData: true` (it no longer ships event `data`) yet STILL needs
  // components, so it passes `includeComponentUsage: true` explicitly. The flag
  // defaults to `!omitEventData`, preserving every prior caller — the
  // list/analytics full-corpus reads (omitEventData, no components) and the
  // detail/branch reads (full data, components) are unchanged.
  const includeComponentUsage =
    options?.includeComponentUsage ?? !options?.omitEventData;
  const componentUsageBySessionId = includeComponentUsage
    ? await selectComponentUsageRows(reader, ids)
    : new Map<string, SqliteComponentUsageRow[]>();
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
    segmentRows,
    sessionAnalyticsRows,
    artifactLinkRows,
    pullRequestRows,
    pullRequestLifecycleRows,
    gitLocRows,
    branchLocRows,
    componentUsageBySessionId,
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
  return { sessions, repoFullNameWriteBacks: writeBacks };
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
  const { sessionRows, tokenRows } = await prisma.read(async (reader) => ({
    sessionRows: await selectSessionRows(reader, ids),
    tokenRows: await selectTokenUsageRows(reader, ids),
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
    tokenEventRows: [],
    segmentRows: [],
    sessionAnalyticsRows: [],
    artifactLinkRows: [],
    pullRequestRows: [],
    pullRequestLifecycleRows: [],
    gitLocRows: [],
    branchLocRows: [],
    resolveAttribution: (sessionId) => {
      const repositoryFullName = repoFullNameById.get(sessionId) ?? null;
      if (repositoryFullName === null) {
        return undefined;
      }
      return {
        repositoryFullName,
        worktreePath: null,
        sourceArtifactId: null,
        sourceLoopId: null,
        baseBranch: null,
      };
    },
  });
}

const ARTIFACT_REF_RELATION_VALUES = new Set<string>(
  Object.values(ArtifactRefRelation)
);

/** Narrow the stored link relation to a known `ArtifactRefRelation`, else undefined. */
function toArtifactRefRelation(
  value: string | null
): ArtifactRefRelation | undefined {
  return value !== null && ARTIFACT_REF_RELATION_VALUES.has(value)
    ? (value as ArtifactRefRelation)
    : undefined;
}

/**
 * Per-link event time (FEA-2729): the tool-use timestamp FEA-2531 Phase B
 * stamps on the link, falling back to the artifact's scan-time observations.
 */
function resolveLinkObservedAt(
  link: SqliteArtifactLinkRow
): string | undefined {
  return (
    link.link_observed_at ??
    link.artifact_observed_at ??
    link.artifact_last_seen_at ??
    undefined
  );
}

function buildBranchLifecycleEventsForBranchLink(
  link: SqliteArtifactLinkRow,
  relation: ArtifactRefRelation,
  observedAt: string | undefined
) {
  return branchLifecycleEventsForBranchLink({
    linkId: link.link_id,
    observedAt,
    relation,
  });
}

/**
 * The observed-at a PR link's lifecycle event (PrRaised) should be stamped with.
 * A `commit_sha_correlation` link (FEA-4379) was minted by the post-boot
 * maintenance pass, so its `observed_at` is Desktop wall-clock time, NOT a real
 * PR-raised instant — stamping it would drop an out-of-band PR onto the timeline
 * at whatever moment the pass happened to run. For that link the canonical
 * GitHub open time (`pull_requests.opened_at`, surfaced as `pr_opened_at`) is the
 * only trustworthy raise instant; when it is unknown (PR not yet enriched) we
 * emit NO instant rather than a fabricated one. Genuine transcript-derived PR
 * links (`gh_pr_create` etc.) keep their real tool-use `observed_at`.
 */
function prLifecycleObservedAt(
  link: SqliteArtifactLinkRow,
  observedAt: string | undefined
): string | undefined {
  if (link.method === COMMIT_SHA_CORRELATION_METHOD) {
    return link.pr_opened_at ?? undefined;
  }
  return observedAt;
}

function buildBranchLifecycleEventsForPrLink(
  link: SqliteArtifactLinkRow,
  relation: ArtifactRefRelation,
  observedAt: string | undefined
) {
  return branchLifecycleEventsForPrLink({
    linkId: link.link_id,
    method: link.method,
    observedAt: prLifecycleObservedAt(link, observedAt),
    relation,
  });
}

/**
 * Map a stored PR-link `relation` to the wire `SessionPrRelationType` carried on
 * `prRefs` (FEA-3585). `created`→CREATED (authored), `reviewed`→REVIEWED (the
 * session ran a `gh pr` review command on this PR), everything else→REFERENCED
 * (a passive mention). Keeping REFERENCED as the default preserves the prior
 * behaviour for every non-review relation.
 */
function toSessionPrRelationType(
  relation: string | null
): SessionPrRelationType {
  if (relation === ArtifactRefRelation.Created) {
    return SessionPrRelationType.Created;
  }
  if (relation === ArtifactRefRelation.Reviewed) {
    return SessionPrRelationType.Reviewed;
  }
  return SessionPrRelationType.Referenced;
}

/**
 * Normalize a stored commit timestamp for the wire: emit the trimmed value only
 * when it is a parseable ISO-8601 date, else `undefined`. The cloud's
 * `isoTimestampSchema` rejects unparseable timestamps, and the whole batch is
 * validated in one parse — so a single malformed `committed_at` must be dropped
 * here rather than stall sync for every session in the batch (FEA-2731).
 */
function toSyncedCommitTimestamp(value: string | null): string | undefined {
  return validIso(value?.trim()) ?? undefined;
}

/**
 * Normalize a locally-stored commit sha for the wire: lowercase + trim, emit only
 * when it is 7–40 hex (COMMIT_SHA_PATTERN), else `undefined`. `commit` is a KNOWN
 * ref kind, so the cloud STRICTLY validates the sha (it is the ref's identity and
 * cannot be forward-compat-dropped like an unknown kind) — a malformed local sha
 * would fail the single batch parse and stall sync for every session in the tick.
 * A commit ref with no valid sha is useless, so callers omit the whole ref rather
 * than emit a field-less one (FEA-2731).
 */
function toSyncedCommitSha(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * T-8.6: Maximum `SyncedComponentUsage` entries per session payload. References
 * the shared `MAX_SYNCED_COMPONENT_USAGE` cap (FEA-3322) so the desktop slice and
 * the cloud wire schema can never diverge — if they did, a session whose usage
 * exceeds the cloud cap would fail validation and never sync at all. Links are
 * oldest-first so this keeps the earliest N.
 */
const MAX_SESSION_COMPONENT_USAGE = MAX_SYNCED_COMPONENT_USAGE;

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
    sessionAnalyticsRows: SqliteSessionAnalyticsRow[];
    artifactLinkRows: SqliteArtifactLinkRow[];
    pullRequestRows: SqlitePullRequestRow[];
    pullRequestLifecycleRows: SqlitePullRequestLifecycleRow[];
    gitLocRows: SqliteGitLocRow[];
    branchLocRows: SqliteGitLocRow[];
    /** T-8.6: per-session component usage rows, grouped by session_id. */
    componentUsageBySessionId?: Map<string, SqliteComponentUsageRow[]>;
    // When true, skip parsing/retaining each event's `data` JSON blob (the
    // dominant per-event memory cost). Callers that never read `event.data`
    // (full-corpus list/analytics reads) set this to bound peak memory; callers
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
     * the retention/window anchor) must not move for it. That is the distinction
     * `session-timeline-axis-window.spec.ts` seeds a divergent column to hold.
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
  // FEA-2732: PR lifecycle facts (merged/closed/draft) grouped by session, keyed
  // per session by `${repo}#${number}` to enrich the `pull_request` artifactRef.
  const pullRequestLifecycleBySessionId = groupRowsBySessionId(
    rows.pullRequestLifecycleRows
  );
  const gitLocBySessionId = new Map(
    rows.gitLocRows.map((r) => [r.session_id, r])
  );
  const branchLocBySessionId = new Map(
    rows.branchLocRows.map((r) => [r.session_id, r])
  );

  const sessionsById = new Map(rows.sessionRows.map((row) => [row.id, row]));
  const agentsBySessionId = groupRowsBySessionId(rows.agentRows);
  const eventsBySessionId = groupRowsBySessionId(rows.eventRows);
  const tokenUsageBySessionId = groupRowsBySessionId(rows.tokenRows);
  const tokenEventsBySessionId = groupRowsBySessionId(rows.tokenEventRows);
  // FEA-3568: group segment rows by session id manually — the Prisma read
  // delegate returns camelCase `sessionId`, not the snake_case `session_id` that
  // `groupRowsBySessionId` keys on.
  const segmentsBySessionId = new Map<string, SyncedSegmentQueryRow[]>();
  for (const segment of rows.segmentRows) {
    const existing = segmentsBySessionId.get(segment.sessionId);
    if (existing) {
      existing.push(segment);
    } else {
      segmentsBySessionId.set(segment.sessionId, [segment]);
    }
  }
  const sessionAnalyticsBySessionId = new Map(
    rows.sessionAnalyticsRows.map((row) => [row.session_id, row])
  );
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
        link.repo_full_name &&
        link.branch_name
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
        const branchLifecycleEvents = buildBranchLifecycleEventsForBranchLink(
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
          repositoryFullName: link.repo_full_name,
          branchName: link.branch_name,
          method: link.method,
          relation,
          ...(branchParticipation ? { branchParticipation } : {}),
          ...(observedAt ? { observedAt } : {}),
          ...(branchLifecycleEvents.length > 0
            ? { branchLifecycleEvents }
            : {}),
          ...(monitoredSessionActivity ? { monitoredSessionActivity } : {}),
        });
      } else if (
        link.target_kind === "pull_request" &&
        link.repo_full_name &&
        link.pr_number != null
      ) {
        const observedAt = resolveLinkObservedAt(link);
        const relation =
          toArtifactRefRelation(link.relation) ??
          ArtifactRefRelation.Referenced;
        const branchLifecycleEvents = buildBranchLifecycleEventsForPrLink(
          link,
          relation,
          observedAt
        );
        const lifecycle = prLifecycleByKey.get(
          `${link.repo_full_name}#${link.pr_number}`
        );
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
          repositoryFullName: link.repo_full_name,
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
        // The session↔PR association carrier (prRefs): derived PR purpose plus
        // old-cloud compat; facts ride the artifactRef above. FEA-3585: no URL
        // guard (a bare-number `reviewed` link has none). ISS-5764: prose
        // MENTIONS are NOT carried — every non-CREATED entry ADJUDICATES its PR number and would delete a real authored PR (see PROSE_MENTION_REF_METHODS).
        if (!PROSE_MENTION_REF_METHODS.has(link.method)) {
          prRefs.push({
            repositoryFullName: link.repo_full_name,
            prNumber: link.pr_number,
            ...(link.url ? { prUrl: link.url } : {}),
            relationType: toSessionPrRelationType(link.relation),
            ...(branchLifecycleEvents.length > 0
              ? { branchLifecycleEvents }
              : {}),
          });
        }
      } else if (link.target_kind === "commit") {
        // FEA-2731 / PRD-510 D7: sync commit observations so the cloud
        // CommitDetail SSOT can render branch commit history with NO GitHub App
        // installed. Carries the ABBREVIATED sha parsed from the git-commit
        // summary line plus the observing branch, subject, timestamp, and
        // desktop-parsed LOC; the cloud reconciles it with the push webhook's
        // full sha by git-style prefix match. Same deploy-ordering caveat as the
        // branch ref above (the cloud is deployed ahead of desktop releases).
        // A malformed local sha omits the whole ref (see toSyncedCommitSha) — it
        // must never reach the cloud's strict, batch-failing parse.
        const sha = toSyncedCommitSha(link.sha);
        if (link.repo_full_name && link.branch_name && sha) {
          const committedAt = toSyncedCommitTimestamp(
            link.artifact_committed_at
          );
          // Route LOC through the int4 bound so a
          // 64-bit SQLite value above int4 is dropped here rather than
          // overflowing the cloud `commit_detail` INTEGER write and aborting
          // the whole batch — matching the PR-ref path
          // (buildPullRequestArtifactRefFacts, FEA-3206).
          const linesAdded = boundedNonNegativeInt(link.lines_added);
          const linesRemoved = boundedNonNegativeInt(link.lines_removed);
          const filesChanged = boundedNonNegativeInt(link.files_changed);
          artifactRefs.push({
            kind: ArtifactRefTargetKind.Commit,
            repositoryFullName: link.repo_full_name,
            branchName: link.branch_name,
            sha,
            method: link.method,
            relation:
              toArtifactRefRelation(link.relation) ??
              ArtifactRefRelation.Created,
            ...(link.title
              ? {
                  message: link.title.slice(
                    0,
                    MAX_SYNCED_COMMIT_MESSAGE_LENGTH
                  ),
                }
              : {}),
            ...(committedAt ? { committedAt } : {}),
            ...(linesAdded === undefined ? {} : { linesAdded }),
            ...(linesRemoved === undefined ? {} : { linesRemoved }),
            ...(filesChanged === undefined ? {} : { filesChanged }),
          });
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
    // ISS-4445: slice to the desktop PRODUCER cap (still 100), NOT the raised
    // cloud validator cap (500). A new desktop must never emit >100 PR refs or an
    // old (`.max(100)`) cloud rejects the whole batch during a staged rollout —
    // the validator raise is receive-side + deploy-order-safe. A later PLN-1536
    // PR lifts this producer bound once the raised-cap cloud is universally
    // deployed (and adds the chunked PR-ref sync those higher counts need).
    const boundedPrRefs = prRefs.slice(0, MAX_SYNCED_SESSION_PR_REFS_PRODUCER);

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
    const sessionAnalytics = mapSyncedSessionAnalytics(
      sessionAnalyticsBySessionId.get(id)
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
    // install whose backfill has not run). Track the running max as a cached
    // epoch so each row's created_at is parsed exactly once (N+1 parses total),
    // instead of re-parsing the accumulator on every iteration (~2N parses).
    let lastActivityAt: string | null = row.started_at ?? null;
    let lastActivityEpoch =
      lastActivityAt === null ? null : new Date(lastActivityAt).getTime();
    for (const eventRow of sessionEventRows) {
      if (!eventRow.created_at) {
        continue;
      }
      const eventEpoch = new Date(eventRow.created_at).getTime();
      if (lastActivityEpoch === null || eventEpoch > lastActivityEpoch) {
        lastActivityAt = eventRow.created_at;
        lastActivityEpoch = eventEpoch;
      }
    }
    // ISS-5407: this session's rows REACHED the read's per-session limit, so what
    // the loop above just derived is the max over a PREFIX. See the
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

    // ISS-4541: the per-session activity tiling for cloud upsync, mapped to the
    // wire shape IN FULL — no transport-cap truncation. An oversized tiling is
    // CHUNKED across multiple sync parts (chunkOversizedSession paginates
    // `activitySegmentRows` as its own stream when the server advertised
    // `agentSessionSyncActivityChunking`) or, against an older cloud that can't
    // merge multi-part tilings, dead-letters the WHOLE session for a
    // larger-payload retry — never a silent partial. The transport byte cap is a
    // per-request limit the chunker honors, not a data-model limit that drops
    // rows here.
    const sessionSegments = segmentsBySessionId.get(id) ?? [];
    const mappedSegmentRows = sessionSegments.map(mapSyncedActivitySegment);
    // ISS-4578 (wongk P1): the per-session load is bounded at the db-host
    // memory-safety ceiling + 1. When the true tiling EXCEEDS that ceiling the
    // loaded set is a PREFIX, not the whole tiling. Uploading that prefix would
    // let the cloud store a partial tiling with no truncation signal and then ack
    // + clear the outbox — silent tail loss (the exact failure this ticket
    // fixes). Since omitting `activitySegmentRows` entirely is a cloud NO-OP
    // (never clears the previously stored tiling — see persistSessionActivitySegments),
    // DROP the tiling from this payload rather than ship a lossy prefix: the rest
    // of the session syncs now and the tiling stays whatever the cloud already
    // has, deferred until it is re-derived to a materializable size. This ceiling
    // is a memory backstop set far above any realistic tiling (p99 ~1051
    // segments), so this path is extraordinarily pathological; it is logged so the
    // omission is visible, never a silent undercount.
    const activityTilingOverflowed =
      mappedSegmentRows.length > ACTIVITY_SEGMENT_SYNC_MAX_ROWS;
    const activitySegmentRows = activityTilingOverflowed
      ? []
      : mappedSegmentRows;
    if (activityTilingOverflowed) {
      rows.log?.(
        `sync-source: session ${id} activity tiling exceeds the db-host load ceiling (${ACTIVITY_SEGMENT_SYNC_MAX_ROWS} rows); OMITTING the tiling from this payload (a prefix would be a silent partial) — it defers until re-derived to a materializable size`
      );
    }

    return [
      {
        externalSessionId: row.id,
        name: row.name,
        status: row.status,
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
        // FEA-4022: the raw frustration signal + scorer version. Always emitted
        // by this build; the cloud persists them only when the org opted into
        // `calculateSessionFrustration`, else drops them at ingest.
        frustrationRaw,
        frustrationScoreVersion: FRUSTRATION_SCORE_VERSION,
        ...(attribution ? { attribution } : {}),
        ...traceFieldsWithoutMarkers,
        ...(markers.length > 0 ? { markers } : {}),
        ...buildDiffStats(gitLocBySessionId.get(id), "gitDiffStats"),
        ...buildDiffStats(branchLocBySessionId.get(id), "branchDiffStats"),
        ...(boundedArtifactRefs.length > 0
          ? { artifactRefs: boundedArtifactRefs }
          : {}),
        prRefs: boundedPrRefs,
        agents: (agentsBySessionId.get(id) ?? []).map((agentRow) => ({
          externalAgentId: agentRow.id,
          name: agentRow.name,
          type: agentRow.type,
          subagentType: agentRow.subagent_type,
          status: agentRow.status,
          task: agentRow.task,
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
        ...(activitySegmentRows.length > 0 ? { activitySegmentRows } : {}),
        ...(sessionAnalytics ? { sessionAnalytics } : {}),
        // T-8.6: additive per-session component usage. Bounded to
        // MAX_SESSION_COMPONENT_USAGE to prevent oversized payloads (mirrors
        // the boundedArtifactRefs pattern). Omitted when empty so a session
        // with no component rows sends nothing (never clears cloud rows).
        ...buildBoundedComponentUsage(componentUsageBySessionId.get(id) ?? []),
      },
    ];
  });
}

/**
 * FEA-3029: apply the MAX_SESSION_COMPONENT_USAGE cap by WHOLE (kind,key) groups
 * rather than a blind row prefix. `selectComponentUsageRows` orders rows by
 * (session, kind, key, git_branch), so every (kind,key) group's per-branch rows
 * are contiguous. A raw `slice(0, cap)` can cut through a group at the boundary,
 * sending the cloud a present-but-partial group; `persistSessionComponentUsage`
 * then treats the payload's branch set for that group as authoritative and
 * `deleteMany`s every branch bucket `notIn` it — silently dropping the
 * truncated-off branch's already-synced invocations from component detail and
 * the token-trend. Keeping each group whole (a group is taken in full when it
 * fits the remaining budget, else skipped in full — later smaller groups still
 * get a chance to fit) preserves the "a group absent from the payload is left
 * untouched" invariant the cloud prune relies on.
 *
 * The result never exceeds MAX_SESSION_COMPONENT_USAGE: the cloud wire schema
 * caps `components` at the same limit and rejects the WHOLE batch (up to 200
 * sessions) on overflow, so a single (kind,key) group larger than the cap is
 * dropped in full rather than emitted oversized — its rows are simply not synced
 * this cycle (an absent group leaves any previously synced cloud rows untouched).
 */
function boundWholeComponentGroups(
  usageRows: SqliteComponentUsageRow[]
): SqliteComponentUsageRow[] {
  const bounded: SqliteComponentUsageRow[] = [];
  let index = 0;
  while (index < usageRows.length) {
    const groupStart = index;
    const head = usageRows[groupStart];
    while (
      index < usageRows.length &&
      usageRows[index].component_kind === head.component_kind &&
      usageRows[index].component_key === head.component_key
    ) {
      index++;
    }
    const groupSize = index - groupStart;
    if (bounded.length + groupSize > MAX_SESSION_COMPONENT_USAGE) {
      // Skip a group that doesn't fit and keep scanning: a later, smaller
      // (kind,key) group may still fit within the remaining budget. Breaking
      // here would permanently starve every group ordered after the first
      // over-budget one — the row order is deterministic, so the same later
      // groups would be dropped every cycle even when they'd sync safely.
      continue;
    }
    for (let cursor = groupStart; cursor < index; cursor++) {
      bounded.push(usageRows[cursor]);
    }
  }
  return bounded;
}

/**
 * T-8.6: Map per-session component usage rows to the SyncedComponentUsage wire
 * shape and apply the MAX_SESSION_COMPONENT_USAGE cap. Returns an empty spread
 * object when there are no usage rows (so the `components` key is omitted from
 * the payload entirely — an absent array never clears previously synced rows).
 */
function buildBoundedComponentUsage(
  usageRows: SqliteComponentUsageRow[]
): { components: SyncedComponentUsage[] } | Record<string, never> {
  if (usageRows.length === 0) {
    return {};
  }
  const bounded = boundWholeComponentGroups(usageRows);
  // Possible only when every (kind,key) group individually exceeds the cap: emit
  // nothing (omit the key) so the cloud leaves previously synced rows untouched,
  // rather than an empty `components: []`.
  if (bounded.length === 0) {
    return {};
  }
  const components: SyncedComponentUsage[] = bounded.map((row) => ({
    componentKind: row.component_kind,
    componentKey: row.component_key,
    externalComponentId: row.agent_component_id ?? null,
    harness: row.harness ?? null,
    invocations: row.invocations,
    errorCount: row.error_count,
    firstInvokedAt: row.first_invoked_at ?? null,
    lastInvokedAt: row.last_invoked_at ?? null,
    // FEA-2990: carry the per-event branch attribution additively. Map the ''
    // no-branch sentinel back to null so the cloud reads it as "no per-event
    // branch" and applies the session-level fallback.
    gitBranch: row.git_branch === "" ? null : row.git_branch,
    // FEA-2923: hash-at-invocation attribution (null when uncollected).
    componentVersionHash: row.component_version_hash ?? null,
  }));
  return { components };
}

/** Map one persisted activity-segment row to its additive sync shape. */
function mapSyncedActivitySegment(
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
 * FEA-2730 (G10): map the desktop `session_analytics` rollup row to the synced
 * shape. Returns undefined when the session has no rollup so the payload omits
 * the section (and the cloud preserves any previously synced rollup). Token
 * counts go through `tokenCountValue` for BigInt-safe carry; `is_human` (0/1)
 * becomes a boolean.
 */
function mapSyncedSessionAnalytics(
  row: SqliteSessionAnalyticsRow | undefined
): SyncedAgentSessionAnalytics | undefined {
  if (!row) {
    return undefined;
  }
  const estimatedCostUsd = row.est_cost ?? undefined;
  return {
    startedAt: row.started_at,
    startedDay: row.started_day,
    status: row.status,
    harness: row.harness,
    isHuman: row.is_human !== 0,
    humanTurns: row.human_turns,
    agentTurns: row.agent_turns,
    eventCount: row.event_count,
    toolInvocations: row.tool_invocations,
    errorEvents: row.error_events,
    inputTokens: tokenCountValue(row.input_tokens, "analytics.input"),
    outputTokens: tokenCountValue(row.output_tokens, "analytics.output"),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "analytics.cacheRead"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "analytics.cacheWrite"
    ),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    runtimeMs: row.runtime_ms,
    updatedAt: row.updated_at,
  };
}

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
