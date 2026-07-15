import { createHash } from "node:crypto";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/api/src/session-trace/derivation";
import type {
  SyncedComponent,
  SyncedComponentUsage,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import type {
  LocalArtifactSessionUsage,
  SessionPrRelationType,
  SyncedArtifactRef,
  SyncedPullRequestArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  COMMIT_SHA_PATTERN,
  MAX_SYNCED_ARTIFACT_REFS,
  MAX_SYNCED_COMMIT_MESSAGE_LENGTH,
  MAX_SYNCED_SESSION_PR_REFS,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import { isMeteredApi } from "../../shared/billing-mode.js";
import type {
  SyncedAgentSession,
  SyncedAgentSessionAnalytics,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
} from "../agent-session-sync-contract.js";
import {
  estimateSessionPayloadBytes,
  sanitizeSessionForSync,
} from "../agent-session-sync-payload.js";
import {
  type AgentSessionAnalyticsAgentTypeGroup,
  type AgentSessionAnalyticsAggregate,
  type AgentSessionAnalyticsRepositoryGroup,
  type AgentSessionAnalyticsToolGroup,
  type AgentSessionSyncSource,
  type AgentSessionUsageAggregate,
  type AgentSessionUsageAggregateFilters,
  type PersistedSyncState,
  parseJsonObjectText,
  parseJsonValueText,
  parsePersistedObservedIds,
  resolveBillingModeForRow,
  type resolveSessionAttribution,
  resolveSessionAttributionAsync,
  resolveTokenUsageCostUsd,
  type SessionAttributionResolverCache,
  type SessionCursorRow,
  type SessionListCursorPage,
  type SessionListCursorPageRequest,
  SessionListCursorSortKey,
} from "../agent-session-sync-service.js";
import { resolveBillingMode } from "../billing-mode-detector.js";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import type { MeteredUsageRow } from "../reconciliation-worker.js";
import {
  buildArtifactSessionMarkers,
  mergeSessionMarkers,
} from "../session-artifact-markers.js";
import { addStorageTokenCounts } from "../token-counts.js";
import { HIGH_CONFIDENCE_BRANCH_METHOD_VALUES } from "./db-constants.js";
import {
  escapeSqliteLikePattern,
  nullableNumber,
  tokenCountValue,
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
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "./prisma-client.js";

// ---------------------------------------------------------------------------
// T-8.6: Agent component inventory cursor row + usage row types
// ---------------------------------------------------------------------------

/**
 * Cursor row for the agent_components inventory sync lane (T-8.6).
 * Ordered by (last_seen_at, id) so new/updated rows are always discovered.
 * Tombstoned rows (uninstalled_at IS NOT NULL) are included so the cloud
 * receives uninstall signals.
 */
type SqliteAgentComponentCursorRow = {
  id: string;
  last_seen_at: string | null;
};

/** Full inventory row for `POST /desktop/components/sync`. */
type SqliteAgentComponentRow = {
  id: string;
  component_kind: string;
  external_id: string;
  component_key: string | null;
  name: string | null;
  version: string | null;
  harness: string | null;
  description: string | null;
  source_url: string | null;
  install_path: string | null;
  pack_id: string | null;
  scope: string | null;
  project_path: string | null;
  metadata: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  uninstalled_at: string | null;
};

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
  first_invoked_at: string | null;
  last_invoked_at: string | null;
};

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
  type SessionTraceSyncInput,
} from "./session-trace.js";
import { yieldDbHostLoop } from "./yield-db-host-loop.js";

/**
 * FEA-1459 Fix 6: Resolve the machine's IANA timezone for day-bucketing queries.
 * Falls back to "UTC" if Intl is unavailable.
 */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function createSqliteSessionSyncSource(
  prisma: DesktopPrisma
): AgentSessionSyncSource {
  return {
    async listAllSessionCursorRows(): Promise<SessionCursorRow[]> {
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(`
        SELECT id, updated_at
        FROM sessions
        ORDER BY updated_at DESC, id DESC
      `)
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
    async listUpdatedSessionCursorRows(
      sinceUpdatedAt: string
    ): Promise<SessionCursorRow[]> {
      return prisma.read((reader) =>
        reader.$queryRawUnsafe<SessionCursorRow[]>(
          `
          SELECT id, updated_at
          FROM sessions
          WHERE updated_at >= $1
          ORDER BY updated_at DESC, id DESC
        `,
          sinceUpdatedAt
        )
      );
    },
    async loadSyncedSessions(
      ids: string[],
      cache: SessionAttributionResolverCache,
      options?: { omitEventData?: boolean; includeComponentUsage?: boolean }
    ): Promise<SyncedAgentSession[]> {
      return loadSqliteSyncedSessions(prisma, ids, cache, options);
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
      return aggregateSqliteUsage(prisma, filters);
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
    /**
     * FEA-1962: load the durable cursor for `sourceKey` via the typed
     * `SyncState` delegate. The `Json` ids column comes back pre-parsed; a
     * malformed value degrades to `[]` (full
     * re-discovery) rather than throwing. Absent row → `null` (full backfill).
     * A cursor stamped under a DIFFERENT `DATA_REVISION` is also treated as
     * absent: the local rows have since been re-derived, so the cloud must
     * receive the rebuilt rows — one full re-backfill, then the new revision is
     * stamped. This preserves the pre-FEA-1962 behavior where a revision bump
     * pushed re-derived rows to the cloud (but once, not on every restart).
     */
    async loadSyncState(sourceKey: string): Promise<PersistedSyncState | null> {
      const row = await prisma.client.syncState.findUnique({
        where: { sourceKey },
      });
      if (!row || row.dataRevision !== DATA_REVISION) {
        return null;
      }
      return {
        observedTopUpdatedAt: row.observedTopUpdatedAt ?? null,
        observedIdsAtTopUpdatedAt: parsePersistedObservedIds(
          row.observedIdsAtTopUpdatedAt
        ),
      };
    },
    /**
     * FEA-1962: upsert the durable cursor via the typed `SyncState` delegate,
     * stamping the current DATA_REVISION. Routed through `prisma.write` so the
     * write serializes on the same single-connection queue as every other
     * SQLite write; the `Json` ids column takes the JS array directly — the
     * delegate serializes it.
     */
    async advanceSyncState(
      sourceKey: string,
      state: PersistedSyncState
    ): Promise<void> {
      const updatedAt = new Date().toISOString();
      await prisma.write((client) =>
        client.syncState.upsert({
          where: { sourceKey },
          create: {
            sourceKey,
            observedTopUpdatedAt: state.observedTopUpdatedAt,
            observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
            dataRevision: DATA_REVISION,
            updatedAt,
          },
          update: {
            observedTopUpdatedAt: state.observedTopUpdatedAt,
            observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
            dataRevision: DATA_REVISION,
            updatedAt,
          },
        })
      );
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
    async listComponentCursorRows(since: string) {
      return listAgentComponentCursorRows(prisma, since);
    },
    async loadComponentRows(ids: string[]): Promise<SyncedComponent[]> {
      const rows = await loadAgentComponents(prisma, ids);
      return rows.map(mapAgentComponentToSynced);
    },
  };
}

// ---------------------------------------------------------------------------
// T-8.6: Agent component inventory cursor queries
// ---------------------------------------------------------------------------

/**
 * T-8.6: Cursor rows for the component inventory sync lane, ordered by
 * (last_seen_at, id). Includes tombstoned rows (uninstalled_at IS NOT NULL)
 * so the cloud receives uninstall signals. `since` is an ISO timestamp; pass
 * the epoch string to get all rows (full backfill).
 */
async function listAgentComponentCursorRows(
  prisma: DesktopPrisma,
  since: string
): Promise<SqliteAgentComponentCursorRow[]> {
  return prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteAgentComponentCursorRow[]>(
      `
      SELECT id, last_seen_at
      FROM agent_components
      WHERE last_seen_at >= $1 OR last_seen_at IS NULL
      ORDER BY last_seen_at ASC, id ASC
      `,
      since
    )
  );
}

/**
 * T-8.6: Load full component rows by id for packing into the sync payload.
 * Includes tombstoned rows so uninstall signals are synced.
 */
async function loadAgentComponents(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<SqliteAgentComponentRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return prisma.read((reader) =>
    selectRowsByIds<SqliteAgentComponentRow>(
      reader,
      `
      SELECT
        id,
        component_kind,
        external_id,
        component_key,
        name,
        version,
        harness,
        description,
        source_url,
        install_path,
        pack_id,
        scope,
        project_path,
        metadata,
        first_seen_at,
        last_seen_at,
        uninstalled_at
      FROM agent_components
      WHERE id IN (__IDS__)
      ORDER BY last_seen_at ASC, id ASC
      `,
      ids
    )
  );
}

/**
 * T-8.6: Map a raw `agent_components` row to the `SyncedComponent` wire shape
 * for `POST /desktop/components/sync`.
 */
function mapAgentComponentToSynced(
  row: SqliteAgentComponentRow
): SyncedComponent {
  return {
    externalId: row.external_id,
    componentKind: row.component_kind,
    harness: row.harness ?? null,
    name: row.name ?? null,
    componentKey: row.component_key ?? null,
    version: row.version ?? null,
    description: row.description ?? null,
    sourceUrl: row.source_url ?? null,
    installPath: row.install_path ?? null,
    packId: row.pack_id ?? null,
    scope: row.scope ?? null,
    projectPath: row.project_path ?? null,
    metadata: row.metadata ? (parseJsonObjectText(row.metadata) ?? null) : null,
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    uninstalledAt: row.uninstalled_at ?? null,
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
  // The `Started` sort uses the inline started-at floor (sessions-only, no
  // events join either way).
  const sortExpression =
    request.sortBy === SessionListCursorSortKey.Started
      ? "sort_started_at"
      : "sort_last_activity_at";
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

/**
 * SQL-side mirror of the cheap Sessions-list filters. This keeps the default
 * 7-day view and sidebar search on the cursor-page path, so only visible rows
 * are hydrated after SQLite has found the matching IDs.
 *
 * FEA-2180: the date window filters on `last_activity_at` — the field the list
 * is ordered by — NOT `started_at`. Filtering by start time while sorting by
 * activity dropped recently-active sessions that started before the window,
 * so the dashboard's "Recent Sessions" and the Sessions page diverged. The
 * denormalized `last_activity_at` already folds in the started-at floor (see
 * `recomputeSessionLastActivityAt`), so it needs no separate null fallback.
 */
function buildListCursorFilterClause(request: SessionListCursorPageRequest): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;
  const lastActivityTs = SESSION_LAST_ACTIVITY_AT_TS_EXPR;

  if (request.startDate) {
    conditions.push(`${lastActivityTs} >= ${placeholder()}`);
    params.push(request.startDate.toISOString());
  }
  if (request.endDate) {
    conditions.push(`${lastActivityTs} <= ${placeholder()}`);
    params.push(request.endDate.toISOString());
  }
  if (request.search) {
    const searchPlaceholder = placeholder();
    params.push(`%${escapeSqliteLikePattern(request.search.toLowerCase())}%`);
    const branchMethodPlaceholders = HIGH_CONFIDENCE_BRANCH_METHOD_VALUES.map(
      (method) => {
        const methodPlaceholder = placeholder();
        params.push(method);
        return methodPlaceholder;
      }
    );

    conditions.push(`
      (
        LOWER(COALESCE(s.name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(s.id) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.harness, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.cwd, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(
          CASE
            WHEN s.metadata IS NOT NULL AND json_valid(s.metadata)
              THEN json_extract(s.metadata, '$.gitBranch')
            ELSE NULL
          END,
          ''
        )) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM session_artifact_links sal
          JOIN artifacts a ON a.id = sal.artifact_id
          WHERE sal.session_id = s.id
            AND (
              LOWER(COALESCE(a.repo_full_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              OR (
                a.kind = 'branch'
                AND sal.method IN (${branchMethodPlaceholders.join(", ")})
                AND LOWER(COALESCE(a.branch_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              )
            )
        )
      )
    `);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Build the shared `WHERE` clause for the usage aggregation, mirroring
 * `matchesQuery`/`matchesStatusFilter`/`canonicalSharedStatus` exactly so the
 * SQL-filtered corpus matches the JS hydrate path:
 * - `harness` — equality on the raw column.
 * - `startDate`/`endDate` — inclusive range on `started_at` (cast to timestamptz
 *   to match `parseSessionDate`'s `new Date(...)` ordering; `>=` / `<=` mirror
 *   the strict `<` / `>` exclusions in `matchesQuery`).
 * - `status` — canonicalize (`error→failed`, `running→active`, else lowercase),
 *   then `waiting` = awaiting-input, `active` = canonical active and not
 *   awaiting, anything else = canonical equality. "Awaiting" is a non-terminal
 *   canonical status with a non-null `awaiting_input_since` (mirrors the
 *   `Boolean(session.awaitingInputSince)` + `TERMINAL_SHARED_STATUSES` check).
 * The clause references `sessions s`, so it is reused verbatim by both queries.
 */
// Mirror `parseSessionDate`'s `new Date(value)` → epoch-on-NaN fallback: NULL,
// empty, and otherwise-unparseable `started_at` all coerce to 1970-01-01 here,
// exactly as the hydrate path treats them. A raw `::timestamptz` cast would
// instead drop NULL rows from an `endDate` bound (parity drift — the hydrate
// path keeps them at epoch, which is `<= endDate`) and, worse, THROW on an
// empty or malformed legacy value, failing the whole usage query. The app only
// ever persists `toISOString()`, so the date-prefix guard admits every real
// value and routes the rest to epoch. Used by the `WHERE` filter clause only.
const SESSION_STARTED_AT_TS_EXPR =
  "(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN s.started_at ELSE '1970-01-01T00:00:00.000Z' END)";
const SESSION_LAST_ACTIVITY_AT_TS_EXPR = "s.last_activity_at";
// FEA-2036: started-at floor expression for the cursor pagination sort. SQLite
// dialect — the GLOB date-prefix guard mirrors SESSION_STARTED_AT_TS_EXPR. The
// per-event MAX(created_at) that used to be computed here now lives denormalized
// in `sessions.last_activity_at` (see recomputeSessionLastActivityAt); this floor
// remains the `Started` sort key and the COALESCE fallback for un-ingested rows.
const SESSION_STARTED_AT_SORT_EXPRESSION = SESSION_STARTED_AT_TS_EXPR;

// Bounds variant: same date-prefix guard, but NULL (not epoch) for
// NULL/empty/malformed `started_at`. MIN/MAX ignore NULL, so a legacy row with
// no real start cannot drag earliestSessionAt back to 1970 — matching the API's
// Prisma `_min`/`_max` (a non-nullable column, so no such rows) and the
// hydrate fold's `parseBoundsStartMs` skip. Bounds must NOT use the epoch
// fallback above, or desktop would show "Jan 1, 1970 – …" where web does not.
const SESSION_STARTED_AT_BOUNDS_EXPR =
  "(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN s.started_at ELSE NULL END)";

function buildUsageFilterClause(filters: AgentSessionUsageAggregateFilters): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;

  const startedAtTs = SESSION_STARTED_AT_TS_EXPR;

  if (filters.harness) {
    conditions.push(`s.harness = ${placeholder()}`);
    params.push(filters.harness);
  }
  if (filters.userIds && filters.userIds.length > 0) {
    const userPlaceholders: string[] = [];
    for (const userId of filters.userIds) {
      userPlaceholders.push(placeholder());
      params.push(userId);
    }
    conditions.push(`s.user_id IN (${userPlaceholders.join(", ")})`);
  } else if (filters.userId) {
    conditions.push(`s.user_id = ${placeholder()}`);
    params.push(filters.userId);
  }
  if (filters.startDate) {
    conditions.push(`${startedAtTs} >= ${placeholder()}`);
    params.push(filters.startDate.toISOString());
  }
  if (filters.endDate) {
    conditions.push(`${startedAtTs} <= ${placeholder()}`);
    params.push(filters.endDate.toISOString());
  }
  const statuses =
    filters.statuses && filters.statuses.length > 0 ? filters.statuses : [];
  if (statuses.length === 0 && filters.status) {
    statuses.push(filters.status);
  }
  if (statuses.length > 0) {
    const statusPredicates = statuses.map((status) =>
      buildUsageStatusPredicate(status, placeholder, params)
    );
    conditions.push(`(${statusPredicates.join(" OR ")})`);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildUsageStatusPredicate(
  status: string,
  placeholder: () => string,
  params: unknown[]
): string {
  const canonical =
    "CASE WHEN lower(s.status) = 'error' THEN 'failed' WHEN lower(s.status) = 'running' THEN 'active' ELSE lower(s.status) END";
  const awaiting = `(${canonical} NOT IN ('abandoned', 'completed', 'failed') AND s.awaiting_input_since IS NOT NULL)`;
  const normalized = canonicalUsageStatus(status);
  if (normalized === "waiting") {
    // The `s.ended_at IS NULL` guard mirrors the cloud facet/projection
    // (FEA-3149): an ended row must not surface as Waiting even if its status is
    // not yet canonicalized to a terminal value. Kept out of the shared
    // `awaiting` expression so the `active` branch's `NOT ${awaiting}` exclusion
    // is unchanged (cloud's active facet does not reference ended_at).
    return `(${awaiting} AND s.ended_at IS NULL)`;
  }
  if (normalized === "active") {
    return `(${canonical} = 'active' AND NOT ${awaiting})`;
  }
  const nextPlaceholder = placeholder();
  params.push(normalized);
  return `${canonical} = ${nextPlaceholder}`;
}

function canonicalUsageStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "error") {
    return "failed";
  }
  if (normalized === "running") {
    return "active";
  }
  return normalized;
}

async function aggregateSqliteUsage(
  prisma: DesktopPrisma,
  filters: AgentSessionUsageAggregateFilters
): Promise<AgentSessionUsageAggregate> {
  const { clause, params } = buildUsageFilterClause(filters);

  // Run all reads inside one reader-pool snapshot transaction so a sync-cycle
  // write cannot interleave between them (the event loop yields at each await).
  // Without the shared snapshot, a session inserted in the gap would appear in
  // the harness count but not the token groups — or, on a delete, the inverse —
  // transiently miscounting totalSessions until the next refresh. The reader's
  // `deferred` (query_only) transaction pins one committed snapshot for all
  // reads, concurrent with the writer.
  const { tokenRows, harnessRows, boundsRow } = await prisma.read((reader) =>
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
        }[]
      >(
        `
        SELECT
          s.billing_mode AS billing_mode,
          s.harness AS harness,
          t.model AS model,
          SUM(COALESCE(t.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(t.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(t.cache_read_tokens, 0)) AS cache_read_tokens,
          SUM(COALESCE(t.cache_write_tokens, 0)) AS cache_write_tokens,
          COUNT(DISTINCT t.session_id) AS session_count,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
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
        cost_usd_estimated: null,
      }) ?? 0),
  }));

  const harnessSessionCounts = harnessRows.map((row) => ({
    harness: row.harness,
    sessionCount: Number(row.session_count ?? 0),
  }));

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
 * mirroring `buildToolBreakdowns` / `buildAgentTypeBreakdowns` /
 * `buildRepositoryBreakdowns` exactly. No session/event/agent/token rows are
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
        // byTool — events joined to filtered sessions, WHERE tool_name IS NOT NULL.
        const toolResult = await tx.$queryRawUnsafe<
          {
            tool_name: string;
            invocation_count: number | string | null;
            error_count: number | string | null;
            session_count: number | string | null;
          }[]
        >(
          `
        SELECT
          e.tool_name AS tool_name,
          COUNT(*) AS invocation_count,
          SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count,
          COUNT(DISTINCT e.session_id) AS session_count
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        ${clause}
        ${clause ? "AND" : "WHERE"} e.tool_name IS NOT NULL
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
        // count, mirroring how `aggregateSqliteUsage` sums tokens; the error count
        // is likewise a per-session sub-aggregate. Grouped by the RAW cwd; JS
        // resolves+merges to repositoryFullName below.
        const repoResult = await tx.$queryRawUnsafe<
          {
            cwd: string | null;
            session_count: number | string | null;
            input_tokens: string | null;
            output_tokens: string | null;
            error_count: number | string | null;
          }[]
        >(
          `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd
          FROM sessions s
          ${clause}
        ),
        per_session_tokens AS (
          SELECT t.session_id AS session_id,
            SUM(COALESCE(t.input_tokens, 0)) AS input_tokens,
            SUM(COALESCE(t.output_tokens, 0)) AS output_tokens
          FROM token_usage t
          JOIN filtered f ON f.id = t.session_id
          GROUP BY t.session_id
        ),
        per_session_errors AS (
          SELECT e.session_id AS session_id,
            SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count
          FROM events e
          JOIN filtered f ON f.id = e.session_id
          GROUP BY e.session_id
        )
        SELECT
          f.cwd AS cwd,
          COUNT(*) AS session_count,
          SUM(COALESCE(pt.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(pt.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(pe.error_count, 0)) AS error_count
        FROM filtered f
        LEFT JOIN per_session_tokens pt ON pt.session_id = f.id
        LEFT JOIN per_session_errors pe ON pe.session_id = f.id
        GROUP BY f.cwd
      `,
          ...params
        );

        await yieldDbHostLoop();

        // Per-(cwd, model) cost rollup. Mirrors `aggregateSqliteUsage`'s cost
        // handling EXACTLY: stored `cost_usd_estimated` sums for priced rows, and
        // the unpriced token sums per model so the JS fold can apply
        // `resolveTokenUsageCostUsd` once per (cwd, model) group — equal to pricing
        // each row then summing (linear in tokens) — matching the hydrate loader's
        // per-row `resolveTokenUsageCostUsd(...) ?? 0` accumulated by `sumTokenUsage`.
        const repoCostResult = await tx.$queryRawUnsafe<
          {
            cwd: string | null;
            model: string | null;
            estimated_cost_usd: number | null;
            unpriced_input_tokens: string | null;
            unpriced_output_tokens: string | null;
            unpriced_cache_read_tokens: string | null;
            unpriced_cache_write_tokens: string | null;
          }[]
        >(
          `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd
          FROM sessions s
          ${clause}
        )
        SELECT
          f.cwd AS cwd,
          t.model AS model,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
        FROM token_usage t
        JOIN filtered f ON f.id = t.session_id
        GROUP BY f.cwd, t.model
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

/**
 * FEA-2038: resolve a cwd to its repository identity using the SAME resolver the
 * hydrate/sync path uses (`resolveSessionAttributionAsync` over the shared
 * `cache`), applying the `attribution?.repositoryFullName ??
 * attribution?.worktreePath ?? cwd ?? "unknown"` chain from
 * `buildRepositoryBreakdowns`. Cached per cwd by the resolver cache.
 */
async function resolveCwdRepositoryFullName(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<string> {
  const attribution = await resolveSessionAttributionAsync(cwd, cache);
  return (
    attribution?.repositoryFullName ??
    attribution?.worktreePath ??
    cwd ??
    "unknown"
  );
}

/**
 * FEA-2038: resolve each per-cwd repository row to its `repositoryFullName`,
 * then merge cwds that resolve to one identity — summing the same fields the JS
 * `buildRepositoryBreakdowns` fold accumulates. Cost is folded from the
 * per-(cwd, model) cost rollup exactly as `aggregateSqliteUsage` does (stored
 * priced cost + `resolveTokenUsageCostUsd` over the unpriced token sums per
 * model), so a row with a null `cost_usd_estimated` is priced via model pricing
 * identically to the hydrate loader's per-row `resolveTokenUsageCostUsd`.
 */
async function resolveAnalyticsRepositoryGroups(
  repoRows: {
    cwd: string | null;
    session_count: number | string | null;
    input_tokens: string | null;
    output_tokens: string | null;
    error_count: number | string | null;
  }[],
  repoCostRows: {
    cwd: string | null;
    model: string | null;
    estimated_cost_usd: number | null;
    unpriced_input_tokens: string | null;
    unpriced_output_tokens: string | null;
    unpriced_cache_read_tokens: string | null;
    unpriced_cache_write_tokens: string | null;
  }[],
  cache: SessionAttributionResolverCache
): Promise<AgentSessionAnalyticsRepositoryGroup[]> {
  const groups = new Map<string, AgentSessionAnalyticsRepositoryGroup>();
  const ensureGroup = (
    repositoryFullName: string
  ): AgentSessionAnalyticsRepositoryGroup => {
    const existing = groups.get(repositoryFullName);
    if (existing) {
      return existing;
    }
    const created: AgentSessionAnalyticsRepositoryGroup = {
      repositoryFullName,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    };
    groups.set(repositoryFullName, created);
    return created;
  };

  for (const row of repoRows) {
    const repositoryFullName = await resolveCwdRepositoryFullName(
      row.cwd,
      cache
    );
    const group = ensureGroup(repositoryFullName);
    group.sessionCount += Number(row.session_count ?? 0);
    group.inputTokens += tokenCountValue(
      row.input_tokens,
      "analytics.repo.input"
    );
    group.outputTokens += tokenCountValue(
      row.output_tokens,
      "analytics.repo.output"
    );
    group.errorCount += Number(row.error_count ?? 0);
  }

  for (const row of repoCostRows) {
    const repositoryFullName = await resolveCwdRepositoryFullName(
      row.cwd,
      cache
    );
    const group = ensureGroup(repositoryFullName);
    group.estimatedCost +=
      (nullableNumber(row.estimated_cost_usd) ?? 0) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "analytics.repo.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "analytics.repo.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "analytics.repo.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "analytics.repo.unpriced_cache_write"
        ),
        cost_usd_estimated: null,
      }) ?? 0);
  }
  return [...groups.values()];
}

/** The two row sets both the full and usage loads need. */
function selectSessionRows(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<SqliteSessionRow[]> {
  return selectRowsByIds<SqliteSessionRow>(
    reader,
    `
      SELECT
        id,
        name,
        status,
        cwd,
        model,
        started_at,
        updated_at,
        ended_at,
        awaiting_input_since,
        metadata,
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
async function findSqliteLocallyOversizedSessions(
  prisma: DesktopPrisma,
  ids: string[],
  maxBytes: number
): Promise<{ id: string; payloadBytes: number }[]> {
  if (ids.length === 0) {
    return [];
  }

  const sessionRows = await prisma.read((reader) =>
    selectSessionRows(reader, ids)
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

// Max session ids hydrated per database round. The full load fetches EVERY
// event row (with its full `data` JSON) for the requested sessions at once, so
// an unbounded id list (e.g. the analytics / search-usage path passing the
// entire corpus) materializes the whole event table in memory inside a single
// libSQL `execute()` + its POJO copy — multi-GB on a large real dataset, which
// OOMs the db-host utilityProcess. Chunking caps peak memory at one batch's
// worth of rows regardless of corpus size; assembled sessions are per-id
// (`assembleSyncedSessions`'s `ids.flatMap`) so concatenating chunk results is
// identical to a single load, and each chunk's raw rows are freed between
// rounds. Sized to stay well under SQLite's bound-parameter ceiling (the git
// LOC query repeats the IN list 3x → ~3x ids placeholders per statement).
const SYNCED_SESSION_HYDRATE_CHUNK_SIZE = 200;

function chunkIds(ids: string[], size: number): string[][] {
  if (ids.length <= size) {
    return [ids];
  }
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Full load: session metadata plus every hydrated relation (agents, events,
 * token_events, artifact_links) and resolved attribution. Used by detail/list
 * reads. Shares the per-session assembly with the usage load via
 * `assembleSyncedSessions`, so the two can never project a session differently.
 *
 * Hydrates in bounded id chunks so peak memory stays flat as the corpus grows
 * (see `SYNCED_SESSION_HYDRATE_CHUNK_SIZE`). The attribution `cache` is shared
 * across chunks so cross-chunk cwd resolution is still de-duplicated.
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
 */
async function loadSqliteSyncedSessions(
  prisma: DesktopPrisma,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: { omitEventData?: boolean; includeComponentUsage?: boolean }
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  // Each chunk hydrates on a SINGLE pooled reader connection (one prisma.read),
  // so a chunk's ~10 relation reads share one connection; separate chunks
  // round-robin across the pool, letting a concurrent sync/dashboard read run on
  // the other reader.
  if (ids.length <= SYNCED_SESSION_HYDRATE_CHUNK_SIZE) {
    return prisma.read((reader) =>
      loadSqliteSyncedSessionsChunk(reader, ids, cache, options)
    );
  }
  const out: SyncedAgentSession[] = [];
  const chunks = chunkIds(ids, SYNCED_SESSION_HYDRATE_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    const loaded = await prisma.read((reader) =>
      loadSqliteSyncedSessionsChunk(reader, chunks[i], cache, options)
    );
    for (const session of loaded) {
      out.push(session);
    }
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

async function loadSqliteSyncedSessionsChunk(
  reader: DesktopPrismaReadClient,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: { omitEventData?: boolean; includeComponentUsage?: boolean }
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  const sessionRows = await selectSessionRows(reader, ids);
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
  const eventDataColumn = options?.omitEventData ? "NULL AS data" : "data";
  const eventRows = await selectRowsByIds<SqliteEventRow>(
    reader,
    `
      SELECT
        id,
        session_id,
        agent_id,
        event_type,
        tool_name,
        summary,
        ${eventDataColumn},
        created_at
      FROM events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, id ASC
    `,
    ids
  );
  const tokenEventRows = await selectRowsByIds<SqliteTokenEventRow>(
    reader,
    `
      SELECT
        session_id,
        model,
        created_at,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd_estimated,
        input_cost_usd_estimated,
        output_cost_usd_estimated,
        cache_read_cost_usd_estimated,
        cache_creation_cost_usd_estimated
      FROM token_events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, model ASC
    `,
    ids
  );
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
        sal.session_id,
        a.kind AS target_kind,
        a.slug,
        sal.is_primary,
        sal.method,
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
        a.last_seen_at AS artifact_last_seen_at
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
          AND sal.relation IN ('created', 'workspace')
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
      SELECT session_id, total_added, total_removed, total_files
      FROM (
        SELECT session_id, total_added, total_removed, total_files,
          ROW_NUMBER() OVER (
            PARTITION BY session_id ORDER BY priority
          ) AS rn
        FROM (
          SELECT
            sal.session_id AS session_id,
            COALESCE(SUM(a.lines_added), 0) AS total_added,
            COALESCE(SUM(a.lines_removed), 0) AS total_removed,
            COALESCE(SUM(a.files_changed), 0) AS total_files,
            1 AS priority
          FROM session_artifact_links sal
          JOIN artifacts a ON sal.artifact_id = a.id
          WHERE sal.session_id IN (__IDS__)
            AND sal.relation = 'created'
            AND a.kind = 'commit'
            AND a.enrichment_state IN ('provisional', 'final')
            AND a.lines_added IS NOT NULL
          GROUP BY sal.session_id
          HAVING SUM(a.lines_added) > 0 OR SUM(a.lines_removed) > 0
          UNION ALL
          SELECT
            sal.session_id,
            COALESCE(a.lines_added, 0),
            COALESCE(a.lines_removed, 0),
            COALESCE(a.files_changed, 0),
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
  const attributionByCwd = await resolveSyncAttributions(sessionRows, cache);
  return assembleSyncedSessions(ids, {
    sessionRows,
    agentRows,
    eventRows,
    tokenRows,
    tokenEventRows,
    sessionAnalyticsRows,
    artifactLinkRows,
    pullRequestRows,
    pullRequestLifecycleRows,
    gitLocRows,
    branchLocRows,
    componentUsageBySessionId,
    omitEventData: options?.omitEventData ?? false,
    resolveAttribution: (cwd) =>
      cwd ? (attributionByCwd.get(cwd) ?? undefined) : undefined,
  });
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
  return assembleSyncedSessions(ids, {
    sessionRows,
    agentRows: [],
    eventRows: [],
    tokenRows,
    tokenEventRows: [],
    sessionAnalyticsRows: [],
    artifactLinkRows: [],
    pullRequestRows: [],
    pullRequestLifecycleRows: [],
    gitLocRows: [],
    branchLocRows: [],
    resolveAttribution: () => undefined,
  });
}

async function resolveSyncAttributions(
  sessionRows: SqliteSessionRow[],
  cache: SessionAttributionResolverCache
): Promise<Map<string, ResolvedSyncAttribution | null>> {
  const uniqueCwds = [
    ...new Set(
      sessionRows.flatMap((row) => (row.cwd === null ? [] : [row.cwd]))
    ),
  ];
  const entries = await Promise.all(
    uniqueCwds.map(
      async (cwd): Promise<[string, ResolvedSyncAttribution | null]> => [
        cwd,
        (await resolveSessionAttributionAsync(cwd, cache)) ?? null,
      ]
    )
  );
  return new Map(entries);
}

type ResolvedSyncAttribution = NonNullable<
  ReturnType<typeof resolveSessionAttribution>
>;

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

// --- FEA-2732: PR fact projection for the `pull_request` artifactRef ---

/** Normalize a stored PR state to the canonical GitHubPRState, else undefined. */
function normalizePullRequestState(
  value: string | null
): GitHubPRState | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.trim().toUpperCase();
  return upper === GitHubPRState.Open ||
    upper === GitHubPRState.Merged ||
    upper === GitHubPRState.Closed
    ? (upper as GitHubPRState)
    : undefined;
}

/**
 * A non-negative integer within the wire schema's `PR_INT_MAX` (Postgres int4)
 * bound, else undefined. The cloud declares `.int().nonnegative().max(PR_INT_MAX)`
 * on these LOC fields, so an overflowed SQLite value (64-bit) that passed a
 * bare `>= 0` check would clear the desktop guard yet fail the cloud's single
 * batch parse — rejecting every session in the batch and stalling sync.
 */
function nonNegativeInt(value: number | null): number | undefined {
  return value != null &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= PR_INT_MAX
    ? value
    : undefined;
}

/** A non-empty string within `max` chars, else undefined (guards Zod .max()). */
function boundedString(value: string | null, max: number): string | undefined {
  return value != null && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/** A parseable ISO timestamp string, else undefined (guards the wire schema). */
function validTimestamp(value: string | null): string | undefined {
  return value != null && value.length > 0 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

type PullRequestArtifactRefFacts = Partial<
  Pick<
    SyncedPullRequestArtifactRef,
    | "title"
    | "state"
    | "isDraft"
    | "additions"
    | "deletions"
    | "changedFiles"
    | "mergedAt"
    | "closedAt"
  >
>;

/**
 * FEA-2732: assemble the optional PR-fact fields of a `pull_request` artifactRef
 * from the joined `artifacts` row (state / LOC / base / head / merge sha) plus
 * the `pull_requests` + observation lifecycle row (merged / closed / draft).
 * Every field is defensively bounded to the wire schema so one oversized or
 * malformed value cannot reject the whole (up to 200-session) sync batch
 * (FEA-2711). Absent facts are simply omitted — the cloud fills gaps only.
 */
function buildPullRequestArtifactRefFacts(
  link: SqliteArtifactLinkRow,
  lifecycle: SqlitePullRequestLifecycleRow | undefined
): PullRequestArtifactRefFacts {
  const facts: PullRequestArtifactRefFacts = {};
  const title = boundedString(link.title, 1024);
  if (title !== undefined) {
    facts.title = title;
  }
  const state = normalizePullRequestState(link.pr_state);
  if (state !== undefined) {
    facts.state = state;
  }
  // Raw SQLite booleans arrive as 0/1 integers, so coerce rather than checking
  // `typeof === "boolean"` (which would never match, silently dropping drafts).
  if (lifecycle?.is_draft != null) {
    facts.isDraft = lifecycle.is_draft === true || lifecycle.is_draft === 1;
  }
  const additions = nonNegativeInt(link.lines_added);
  if (additions !== undefined) {
    facts.additions = additions;
  }
  const deletions = nonNegativeInt(link.lines_removed);
  if (deletions !== undefined) {
    facts.deletions = deletions;
  }
  const changedFiles = nonNegativeInt(link.files_changed);
  if (changedFiles !== undefined) {
    facts.changedFiles = changedFiles;
  }
  const mergedAt = validTimestamp(lifecycle?.merged_at ?? null);
  if (mergedAt !== undefined) {
    facts.mergedAt = mergedAt;
  }
  const closedAt = validTimestamp(lifecycle?.closed_at ?? null);
  if (closedAt !== undefined) {
    facts.closedAt = closedAt;
  }
  return facts;
}

/**
 * Normalize a stored commit timestamp for the wire: emit the trimmed value only
 * when it is a parseable ISO-8601 date, else `undefined`. The cloud's
 * `isoTimestampSchema` rejects unparseable timestamps, and the whole batch is
 * validated in one parse — so a single malformed `committed_at` must be dropped
 * here rather than stall sync for every session in the batch (FEA-2731).
 */
function toSyncedCommitTimestamp(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Date.parse(trimmed))
    ? trimmed
    : undefined;
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
 * T-8.6: Maximum `SyncedComponentUsage` entries per session payload. Mirrors
 * `MAX_SYNCED_COMPONENT_USAGE` (500) from the API schema to prevent
 * oversized batches. Links are oldest-first so this keeps the earliest N.
 */
const MAX_SESSION_COMPONENT_USAGE = 500;

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
    resolveAttribution: (
      cwd: string | null
    ) => ReturnType<typeof resolveSessionAttribution>;
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
    const attribution = rows.resolveAttribution(row.cwd);
    const metadata = parseJsonObjectText(row.metadata);

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
        artifactRefs.push({
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: link.repo_full_name,
          branchName: link.branch_name,
          method: link.method,
          relation:
            toArtifactRefRelation(link.relation) ??
            ArtifactRefRelation.Workspace,
          ...(observedAt ? { observedAt } : {}),
        });
      } else if (
        link.target_kind === "pull_request" &&
        link.repo_full_name &&
        link.pr_number != null
      ) {
        const observedAt = resolveLinkObservedAt(link);
        const lifecycle = prLifecycleByKey.get(
          `${link.repo_full_name}#${link.pr_number}`
        );
        // FEA-2732: emit the PR as a fact-carrying `pull_request` artifactRef the
        // cloud syncs into PullRequestDetail. Same deploy-ordering note as branch
        // refs above: the enriched fields are optional, so a cloud that predates
        // FEA-2732 strips them (the ref kind has shipped since FEA-2729).
        const headBranch = boundedString(link.branch_name, 300);
        artifactRefs.push({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: link.repo_full_name,
          prNumber: link.pr_number,
          method: link.method,
          relation:
            toArtifactRefRelation(link.relation) ??
            ArtifactRefRelation.Referenced,
          ...(observedAt ? { observedAt } : {}),
          ...(headBranch ? { branchName: headBranch } : {}),
          ...buildPullRequestArtifactRefFacts(link, lifecycle),
        });
        // Retain the session↔PR association carrier (prRefs) for continuity of
        // the derived "Authored/Referenced PR" purpose and old-cloud
        // compatibility; the PR facts now ride the artifactRef above.
        if (link.url) {
          prRefs.push({
            repositoryFullName: link.repo_full_name,
            prNumber: link.pr_number,
            prUrl: link.url,
            relationType: (link.relation === "created"
              ? "CREATED"
              : "REFERENCED") satisfies SessionPrRelationType,
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
          // Route LOC through nonNegativeInt() (int4/PR_INT_MAX bound) so a
          // 64-bit SQLite value above int4 is dropped here rather than
          // overflowing the cloud `commit_detail` INTEGER write and aborting
          // the whole batch — matching the PR-ref path
          // (buildPullRequestArtifactRefFacts, FEA-3206).
          const linesAdded = nonNegativeInt(link.lines_added);
          const linesRemoved = nonNegativeInt(link.lines_removed);
          const filesChanged = nonNegativeInt(link.files_changed);
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
    // FEA-2711: bound both ref arrays to the shared per-session caps the cloud
    // enforces. Links are ordered oldest-first, so this keeps the earliest N.
    // Without this, a session over a cap fails cloud validation and — because
    // the whole batch is validated with one parse — rejects up to 200 sessions,
    // silently stalling sync (the sibling `markers` array is already sliced).
    //
    // FEA-2731: commit refs share this cap but are LOWEST priority — branch/PR/
    // closedloop refs are load-bearing (branch refs drive FR12 org visibility),
    // so keep all of them first and let commits fill only the remaining budget.
    // Otherwise a commit-heavy session could push a branch ref past the cap and
    // silently drop it.
    const nonCommitRefs = artifactRefs.filter(
      (ref) => ref.kind !== ArtifactRefTargetKind.Commit
    );
    const commitRefs = artifactRefs.filter(
      (ref) => ref.kind === ArtifactRefTargetKind.Commit
    );
    const boundedArtifactRefs = [
      ...nonCommitRefs.slice(0, MAX_SYNCED_ARTIFACT_REFS),
      ...commitRefs.slice(
        0,
        Math.max(0, MAX_SYNCED_ARTIFACT_REFS - nonCommitRefs.length)
      ),
    ];
    const boundedPrRefs = prRefs.slice(0, MAX_SYNCED_SESSION_PR_REFS);

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
      const estimatedCostUsd = resolveTokenUsageCostUsd({
        ...tokenRow,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
      });
      return {
        model: tokenRow.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      };
    });
    // FEA-2730 (G1): raw per-event token rows for cloud sync. The desktop
    // `token_events` table has no primary key, so synthesize a stable
    // `externalEventId` as a content hash of the row (the fragmentId /
    // SessionActivitySegment.id precedent). Two identical-content rows collapse
    // to one, which is the correct idempotent behavior on re-sync.
    const tokenEvents: SyncedAgentSessionTokenEvent[] = (
      tokenEventsBySessionId.get(id) ?? []
    ).map((eventRow) => mapSyncedTokenEvent(id, eventRow));
    const sessionAnalytics = mapSyncedSessionAnalytics(
      sessionAnalyticsBySessionId.get(id)
    );
    const sessionEventRows = eventsBySessionId.get(id) ?? [];
    const timelineRows = buildTraceTimelineRows(metadata, sessionEventRows);
    const traceFields = buildSessionTraceSyncFields({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      metadata,
      attribution,
      artifactLinkBranch: resolveArtifactLinkBranch(linkRows),
      events: sessionEventRows,
      timelineRows,
      tokenEvents: (tokenEventsBySessionId.get(id) ?? []).map(
        normalizeTraceTokenEvent
      ),
      localPullRequests: pullRequestsBySessionId.get(id) ?? [],
    });
    const { markers: traceMarkers, ...traceFieldsWithoutMarkers } = traceFields;

    const artifactMarkers = buildArtifactSessionMarkers({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
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
    // session start. Derived from the same local events the desktop syncs, so
    // the desktop list and the cloud-derived value agree. Deliberately NOT
    // row.updated_at (bumped by OTEL ingest / enrichment / sync writes).
    // Track the running max as a cached epoch so each row's created_at is
    // parsed exactly once (N+1 parses total), instead of re-parsing the
    // accumulator on every iteration (~2N parses).
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
        metadata,
        ...(row.user_id ? { userId: row.user_id } : {}),
        ...(row.organization_id ? { organizationId: row.organization_id } : {}),
        deviceTimeZone: localTimeZone(),
        dataRevision: row.data_revision,
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
  }));
  return { components };
}

/**
 * FEA-2730 (G1): map one desktop `token_events` row to a synced token event,
 * synthesizing a stable content-hash `externalEventId` (the source table has no
 * primary key). The hash spans the session id and every synced column so a
 * re-sync of an unchanged row produces the same id (idempotent no-op), while
 * genuinely distinct rows differ.
 */
function mapSyncedTokenEvent(
  sessionId: string,
  eventRow: SqliteTokenEventRow
): SyncedAgentSessionTokenEvent {
  const inputTokens = tokenCountValue(
    eventRow.input_tokens,
    "tokenEvent.input"
  );
  const outputTokens = tokenCountValue(
    eventRow.output_tokens,
    "tokenEvent.output"
  );
  const cacheReadTokens = tokenCountValue(
    eventRow.cache_read_tokens,
    "tokenEvent.cacheRead"
  );
  const cacheWriteTokens = tokenCountValue(
    eventRow.cache_write_tokens,
    "tokenEvent.cacheWrite"
  );
  const estimatedCostUsd = eventRow.cost_usd_estimated ?? undefined;
  // Hash only the row's IMMUTABLE identity. `cost_usd_estimated` is deliberately
  // excluded: it is re-written in place on the desktop when a pricing update
  // lands mid-session (updateTokenEventCost), and folding a mutable field into
  // the id would mint a fresh externalEventId for the re-priced row — the cloud
  // (which dedupes on (agentSessionId, externalEventId) with skipDuplicates)
  // would then insert a duplicate and double-count. Identity is the raw usage
  // fact: session + model + timestamp + token counts.
  const externalEventId = createHash("sha256")
    .update(
      stableStringify({
        sessionId,
        model: eventRow.model,
        createdAt: eventRow.created_at,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      })
    )
    .digest("hex");
  return {
    externalEventId,
    model: eventRow.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    createdAt: eventRow.created_at,
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
    }[]
  >(
    `
      SELECT
        a.slug,
        tu.model,
        COALESCE(SUM(tu.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tu.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(tu.cache_write_tokens), 0) AS cache_write_tokens,
        SUM(tu.cost_usd_estimated) AS cost_usd_estimated,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
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
        tu.cache_write_tokens AS cache_write_tokens
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
    out.push({
      sessionId: row.session_id,
      model: row.model,
      startedAt: row.started_at,
      billingMode,
      inputTokens: tokenCountValue(row.input_tokens, "metered.input"),
      outputTokens: tokenCountValue(row.output_tokens, "metered.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "metered.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "metered.cache_write"
      ),
    });
  }
  return out;
}

function normalizeTraceTokenEvent(
  row: SqliteTokenEventRow
): SessionTraceSyncInput["tokenEvents"][number] {
  return {
    model: row.model,
    created_at: row.created_at,
    input_tokens: tokenCountValue(row.input_tokens, "trace.input"),
    output_tokens: tokenCountValue(row.output_tokens, "trace.output"),
    cache_read_tokens: tokenCountValue(
      row.cache_read_tokens,
      "trace.cache_read"
    ),
    cache_write_tokens: tokenCountValue(
      row.cache_write_tokens,
      "trace.cache_write"
    ),
    cost_usd_estimated: row.cost_usd_estimated,
    input_cost_usd_estimated: row.input_cost_usd_estimated,
    output_cost_usd_estimated: row.output_cost_usd_estimated,
    cache_read_cost_usd_estimated: row.cache_read_cost_usd_estimated,
    cache_creation_cost_usd_estimated: row.cache_creation_cost_usd_estimated,
  };
}
