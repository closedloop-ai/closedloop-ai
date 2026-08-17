import os from "node:os";
import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  isExhaustiveCostFilter,
  isSessionVisibleForQuality,
  matchesChangePresence,
  matchesPrAssociation,
  sessionHasChanges,
} from "@repo/api/src/agent-session-filters";
import {
  AGENT_FAILED_STATUS_PATTERN as FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN as SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import { buildUserColor } from "@repo/api/src/agent-session-user-color";
import { matchesAutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import type { BasicUser } from "@repo/api/src/types/user";
import { klocFromLines } from "@repo/api/src/utils/kloc";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { deriveAgentSessionFallbackState } from "@repo/lib/sessions/agent-session-detail-projection";
import { formatCurrency } from "@closedloop-ai/loops-api/currency";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsUsageSummary,
  type SharedAgentSessionAgentTypeBreakdown,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionListItem,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionRepositoryBreakdown,
  type SharedAgentSessionsListRequest,
  type SharedAgentSessionsQuery,
  type SharedAgentSessionToolBreakdown,
  type SharedAgentSessionUsageSummary,
} from "../../shared/shared-agent-sessions-contract.js";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type {
  AgentSessionCountFilters,
  AgentSessionUsageAggregateFilters,
  RepositoryScopedSessionIdsOptions,
} from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
} from "../agent-sync/agent-session-sync-source.js";
import {
  SESSIONS_ANALYTICS_DATE_WINDOW_FIELD,
  SESSIONS_SURFACE_DATE_WINDOW_FIELD,
  sessionDateWindowValue,
} from "../agent-sync/session-date-window.js";
import { foldAnalyticsAggregate } from "./analytics-aggregate-fold.js";
import { isDisplayedStatusParityEnabled } from "./displayed-status-parity-gate.js";
import { matchesLocalCostBucketFilter } from "./local-cost-bucket-filter.js";
import {
  localSessionHasPr,
  localSessionPullRequests,
  resolveLocalSessionBranch,
} from "./local-session-pull-requests.js";
import {
  buildLocalCloudSyncDisclosure,
  EMPTY_TRANSCRIPT_DISPOSITIONS,
  type LoadTranscriptBlobStates,
  loadLocalTranscriptDispositions,
  type TranscriptDispositionLookup,
} from "./local-transcript-cloud-sync.js";
import {
  getOrgDirectorySnapshot,
  resolveOwner,
} from "./org-directory-cache.js";
import { servedSessionActivityAt } from "./session-activity-anchor.js";
import {
  parseNullableSessionDate,
  parseSessionDate,
} from "./session-instant.js";
import {
  type SharedAgentSessionLocCost,
  sessionLocCost,
  sessionLocPerDollarNumeratorLoc,
} from "./session-loc-cost.js";
import {
  canPageBeforeLoading,
  hasNoLocalFacetFilters,
  lightweightUsageLoadFitsQuery,
  loadCursorPageBeforeHydration,
  repositoryScopeOptionsFromQuery,
  selectedStatusesFromQuery,
} from "./session-read-fast-paths.js";
import {
  resolveRepositoryScopedSessionIds,
  sessionMatchesRepositoryFilter,
  sessionRepositoryName,
} from "./session-repository-facet.js";
import {
  canonicalSharedStatus,
  matchesStatusFilter as matchesSharedStatusFilter,
} from "./session-status-filter-match.js";
import {
  countToolUseEvents,
  localSubstantiveCounts,
  type SessionTotals,
  sessionIsSubstantive,
  stripSessionIds,
  sumTokenUsage,
} from "./session-usage-totals.js";
import { sortSyncedSessions } from "./session-working-set-sort.js";
import { servedSharedSessionStatus } from "./shared-agent-session-status.js";
import { MAX_LIST_LIMIT } from "./shared-agent-sessions-list-bounds.js";
import { LIST_LOAD } from "./shared-agent-sessions-load-shapes.js";
import {
  coerceNonEmptyString,
  type SanitizedQuery,
  sanitizeIds,
  sanitizeQuery,
} from "./shared-agent-sessions-query.js";
import {
  buildUsageSummary,
  foldUsageAggregate,
} from "./shared-agent-sessions-usage-summary.js";

const LOCAL_COMPUTE_TARGET_ID = "local-desktop";
const LOCAL_COMPUTE_TARGET_NAME = os.hostname() || "Local Desktop";
const LOCAL_AGENT_SESSION_ORIGIN = "DESKTOP_SYNC" satisfies NonNullable<
  SharedAgentSessionListItem["origin"]
>;

type WorkingSetOptions = {
  applyPagination: boolean;
  // FEA-3284: which matcher gates the full-hydration fallback. The list passes
  // `matchesListQuery` (facets PLUS the substantive quality gate); the
  // usage/analytics folds pass `matchesQuery` (facets only) so their totals stay
  // byte-for-byte in step with the all-quality SQL `aggregateUsage`/
  // `aggregateAnalytics` paths (FEA-1834 §4) and the substantive gate never
  // leaks into cost/usage accounting. Defaults to `matchesQuery` when omitted.
  matcher?: (session: SyncedAgentSession, query: SanitizedQuery) => boolean;
  // FEA-3450: when set, the full-corpus filter pass also buckets the rows that
  // match every facet but are idle (the rows the substantive default hides) into
  // the returned `idleCount`, folding what used to be a second full-corpus scan
  // (`computeIdleCount`, which re-ran `sumTokenUsage` + `countToolUseEvents` per
  // row) into the single filter loop. Only the list read sets it; usage/analytics
  // never need the count. Ignored when `quality=all` (nothing is hidden → 0).
  countIdle?: boolean;
};

/**
 * Creates the per-request attribution cache used by local shared-session API
 * reads. `attributionByCwd` is not shared with the sync service, so a renderer
 * read cannot mutate it; ISS-5272 memoizes `repoFullNameByPath` process-wide.
 */
export function createSessionAttributionResolverCache(): SessionAttributionResolverCache {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/**
 * Options for the local list projection. `computeTargetId` is the ONLINE-AWARE
 * compute-target id (null when offline/unauthenticated, matching the sync
 * service's `getSyncComputeTargetId`); it keys `loadPendingOutboxIds` under the
 * SAME source key the write side enqueues under, so the per-row `cloudSyncState`
 * disclosure (PRD-536 E6) reads the outbox for the current identity. Omitted (or
 * null) → no pending set → every local row projects `synced`.
 */
export type GetSharedAgentSessionsOptions = {
  computeTargetId?: string | null;
  /**
   * ISS-4647: bounded lookup of the page's `main` transcript blob states, so the
   * local list discloses a transcript lane that is still behind (parity with the
   * cloud list). Injected rather than read here because the transcript store
   * lives behind the db-host proxy; omitted (legacy/fake callers, or no store) ⇒
   * no transcript verdict ⇒ today's outbox-only behavior.
   */
  loadTranscriptBlobStates?: LoadTranscriptBlobStates;
};

/**
 * PRD-536 E6: load the still-`pending` outbox id set for the current identity —
 * the sessions enqueued for cloud sync but not yet server-acked. Best-effort and
 * never throwing into the list read.
 *
 * #4150 (shafty023 review): the result is discriminated so a FAILED read is not
 * confused with a proven-empty one. A null/empty compute target or a source with
 * no `loadPendingOutboxIds` delegate (fake/legacy sources) means the lane was
 * never consulted — `available: true` with an empty set, so a row degrades to the
 * honest `synced` default. A lookup that was attempted and THREW returns
 * `available: false`: the metadata lane's state is unknown, and `.has(...)` on an
 * empty set would otherwise misread that as "proven absent → synced", stamping an
 * outbox-acked-unknown row `synced` (the exact false state ISS-4647 fixes).
 */
async function loadPendingOutboxIdSet(
  source: AgentSessionSyncSource,
  computeTargetId: string | null
): Promise<PendingOutboxLookup> {
  if (!(computeTargetId && source.loadPendingOutboxIds)) {
    return { available: true, ids: EMPTY_PENDING_OUTBOX_IDS };
  }
  try {
    const sourceKey = buildAgentSessionSyncSourceKey(computeTargetId);
    const ids = await source.loadPendingOutboxIds(sourceKey);
    return {
      available: true,
      ids: ids.length > 0 ? new Set(ids) : EMPTY_PENDING_OUTBOX_IDS,
    };
  } catch {
    return { available: false };
  }
}

const EMPTY_PENDING_OUTBOX_IDS: ReadonlySet<string> = new Set<string>();

/**
 * #4150: the outcome of the page's pending-outbox lookup, discriminated so a
 * failed read (`available: false`) is distinguishable from a never-consulted /
 * proven-empty one (`available: true`, empty `ids`).
 */
type PendingOutboxLookup =
  | { available: true; ids: ReadonlySet<string> }
  | { available: false };

/**
 * #4150: the never-consulted lookups the by-id / detail reads pass — an
 * `available` result with an empty set/map, so those rows keep the honest
 * `synced` default (no lane failed; no lane was consulted).
 */
const DEFAULT_PENDING_OUTBOX_LOOKUP: PendingOutboxLookup = {
  available: true,
  ids: EMPTY_PENDING_OUTBOX_IDS,
};
const DEFAULT_TRANSCRIPT_LOOKUP: TranscriptDispositionLookup = {
  available: true,
  byId: EMPTY_TRANSCRIPT_DISPOSITIONS,
};

/**
 * Project local SQLite-backed sessions into the canonical shared API list
 * response. Cursor rows own ordering for no-ID reads; loaded rows own every
 * payload field and are reassembled by cursor or explicit caller order before
 * filters, totals, or pagination run.
 */
export async function getSharedAgentSessions(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsListRequest = {},
  options: GetSharedAgentSessionsOptions = {}
): Promise<SharedAgentSessionListResponse> {
  if (!source) {
    return emptySharedAgentSessionsListResponse();
  }

  const query = sanitizeQuery(request, SESSIONS_SURFACE_DATE_WINDOW_FIELD);
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    // FEA-4304: `scopeUnsatisfiable` = the scoped `userId` was excluded by the
    // Owner facet, so the AND-intersection is empty. Return no rows before any
    // SQL fast path (count/aggregate), which would otherwise ignore the empty
    // set and leak the wider facet's owners under the scoped-user label.
    return emptySharedAgentSessionsListResponse();
  }

  // FEA-4142: a count-only reader (the Agents sidebar activity badge) needs only
  // `total`. Its `completedAfter` + `statuses:["completed"]` query disables both
  // SQL list fast paths, so without this it falls to the full-corpus hydration
  // fallback (`listAllSessionCursorRows` + `loadSyncedSessions` of up to
  // MAX_WORKING_SET_SESSIONS full sessions) just to compute `total =
  // filtered.length` — the FEA-2038 db-host OOM path, fired every 5 minutes from
  // the global sidebar. When the query reduces to a metadata-only SQL predicate,
  // answer it with a single `COUNT(*)` and no rows. Any non-count-expressible
  // query (search, a repository/local facet, a substantive gate, …) falls
  // through to the hydrated path below.
  if (source.countSessions && canAnswerWithCount(request, query)) {
    const total = await source.countSessions(buildCountFilters(query));
    return {
      items: [],
      total,
      idleCount: 0,
      viewerScope: "self",
    };
  }

  const workingSet = await loadWorkingSessions(source, request, query, {
    applyPagination: true,
    // Only the list applies the substantive quality gate (hide idle rows when an
    // explicit `substantive` is sent). Usage/analytics omit the matcher and fall
    // back to `matchesQuery` so their totals cover the same all-quality set the
    // SQL aggregate does.
    matcher: matchesListQuery,
    // FEA-3450: bucket the hidden-idle rows during the SAME filter pass instead
    // of re-scanning the full hydrated corpus a second time.
    countIdle: true,
  });

  // PRD-536 E6: resolve the per-row local-vs-cloud disclosure once for the whole
  // page. `loadPendingOutboxIds(sourceKey)` is the authoritative "still enqueued,
  // not yet server-acked" set; a row whose id is in it reads `pending`, else
  // `synced`. Best-effort: no source-key/delegate → a never-consulted lookup →
  // every local row is `synced` (the pre-E6 behavior), never a false "pending".
  // #4150: a lookup that FAILED reads `available: false` and yields NO disclosure
  // rather than a false `synced` (mapListItem folds the availability).
  const pendingOutboxLookup = await loadPendingOutboxIdSet(
    source,
    options.computeTargetId ?? null
  );
  // ISS-4647: the transcript-blob lane, resolved for THIS page only. The outbox
  // covers the metadata lane alone, so without this a session whose metadata was
  // acked while its raw transcript was still queued reported `synced`.
  const transcriptLookup = await loadLocalTranscriptDispositions(
    options.computeTargetId ?? null,
    options.loadTranscriptBlobStates,
    workingSet.page.map((session) => session.externalSessionId)
  );

  return {
    items: workingSet.page.map((session) =>
      mapListItem(session, pendingOutboxLookup, transcriptLookup)
    ),
    total: workingSet.total,
    // FEA-3284: how many idle rows a `substantive` view hides, within the current
    // filter scope. Only computable on the full-hydration path (which an explicit
    // `substantive` forces); an absent/`all` quality (FEA-3345: `all` is the
    // fail-open default) is already showing idle rows, so nothing is hidden and
    // the count is 0. FEA-3450: folded into the single filter loop in
    // `loadWorkingSessions` (see `countIdle`).
    idleCount: workingSet.idleCount,
    viewerScope: "self",
  };
}

/**
 * Project a specific set of local session ids into shared list-item summaries,
 * preserving the caller's id order and silently dropping ids that resolve to no
 * local session. Used by the agent-components detail reader to populate its
 * `sessionsTab` from the session ids that invoked the component (FEA-2923 MEDIUM
 * soul review) — the same `SharedAgentSessionListItem` (≡ `AgentSessionListItem`)
 * projection the sessions list produces, so the desktop Sessions tab matches the
 * cloud instead of hardcoding `[]`.
 */
export async function getSharedAgentSessionsByIds(
  source: AgentSessionSyncSource | null | undefined,
  ids: readonly string[]
): Promise<SharedAgentSessionListItem[]> {
  if (!source || ids.length === 0) {
    return [];
  }
  const orderedIds = ids
    .map((id) => coerceNonEmptyString(id))
    .filter((id): id is string => id !== null);
  if (orderedIds.length === 0) {
    return [];
  }
  const cache = createSessionAttributionResolverCache();
  const loaded = await source.loadSyncedSessions(orderedIds, cache);
  const loadedById = indexSessionsById(loaded);
  return orderedIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [mapListItem(session)] : [];
  });
}

/**
 * Load the local-git LOC + estimated cost for a set of session ids, keyed by
 * session id. Backs the desktop agent-components "LOC/$" column (FEA-3090): it
 * derives the SAME per-session scalars the cloud persists on `SessionDetail` and
 * divides by in `computeLocPerDollar`
 * (apps/api/app/agent-components/service.ts), so the metric agrees across
 * surfaces instead of the desktop hardcoding `null`.
 *
 * - `loc` = authored local-git lines changed (added + removed), taking the
 *   source-tagged `gitDiffStats` first and falling back to the loose top-level
 *   scalars — the exact `gitDiffStats?.linesAdded ?? linesAdded` precedence the
 *   cloud applies when it writes `SessionDetail.linesAdded/linesRemoved` from
 *   this desktop's sync payload (apps/api/app/agent-sessions).
 * - `cost` = summed per-model estimated cost (`sumTokenUsage`), the identical
 *   value the cloud sums into `SessionDetail.estimatedCost` at ingest.
 *
 * Ids that resolve to no local session are silently dropped (they contribute no
 * loc/cost), matching the cloud's LOC lookup, which only maps rows it found.
 */
export async function getSharedAgentSessionLocCostByIds(
  source: AgentSessionSyncSource | null | undefined,
  ids: readonly string[]
): Promise<Map<string, SharedAgentSessionLocCost>> {
  const byId = new Map<string, SharedAgentSessionLocCost>();
  if (!source || ids.length === 0) {
    return byId;
  }
  const orderedIds = ids
    .map((id) => coerceNonEmptyString(id))
    .filter((id): id is string => id !== null);
  if (orderedIds.length === 0) {
    return byId;
  }
  const cache = createSessionAttributionResolverCache();
  // `omitEventData` skips the heavy per-event `data` blob; the loader still
  // populates `gitDiffStats` and the per-model token usage this reads.
  const loaded = await source.loadSyncedSessions(orderedIds, cache, {
    omitEventData: true,
  });
  for (const session of loaded) {
    byId.set(
      session.externalSessionId,
      sessionLocCost(session, sumTokenUsage(session).estimatedCost)
    );
  }
  return byId;
}

/** Both the projected list items AND the per-session LOC/cost, from one load. */
export type SharedAgentSessionsWithLocCost = {
  items: SharedAgentSessionListItem[];
  locCost: Map<string, SharedAgentSessionLocCost>;
};

/**
 * Project a set of session ids into BOTH the shared list-item summaries (for the
 * agent-components `sessionsTab`) AND their per-session LOC/cost (for the LOC/$
 * metric, FEA-3090), from a SINGLE `loadSyncedSessions` call. The detail reader
 * needs both, so this keeps it to one load instead of fanning the same ids into
 * the sessions source twice. Item order preserves the caller's id order and
 * silently drops ids that resolve to no local session (matching
 * {@link getSharedAgentSessionsByIds}).
 */
export async function getSharedAgentSessionsWithLocCostByIds(
  source: AgentSessionSyncSource | null | undefined,
  ids: readonly string[]
): Promise<SharedAgentSessionsWithLocCost> {
  const locCost = new Map<string, SharedAgentSessionLocCost>();
  if (!source || ids.length === 0) {
    return { items: [], locCost };
  }
  const orderedIds = ids
    .map((id) => coerceNonEmptyString(id))
    .filter((id): id is string => id !== null);
  if (orderedIds.length === 0) {
    return { items: [], locCost };
  }
  const cache = createSessionAttributionResolverCache();
  // `omitEventData` skips the heavy per-event `data` blob; events keep the
  // `toolName`/`eventType` that `mapListItem` reads, matching how the sessions
  // list itself loads its page.
  const loaded = await source.loadSyncedSessions(orderedIds, cache, {
    omitEventData: true,
  });
  const loadedById = indexSessionsById(loaded);
  for (const session of loaded) {
    locCost.set(
      session.externalSessionId,
      sessionLocCost(session, sumTokenUsage(session).estimatedCost)
    );
  }
  const items = orderedIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [mapListItem(session)] : [];
  });
  return { items, locCost };
}

/**
 * Aggregate local sessions into the canonical usage summary. Unsupported
 * cloud-only filters fail closed with an empty response; supported filters use
 * the same deterministic working set as list reads without list pagination.
 */
export async function getSharedAgentSessionUsage(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsQuery = {}
): Promise<SharedAgentSessionUsageSummary> {
  if (!source) {
    return emptySharedAgentSessionsUsageSummary();
  }

  const query = sanitizeQuery(request, SESSIONS_SURFACE_DATE_WINDOW_FIELD);
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    // FEA-4304: empty owner AND-intersection (Owner facet excludes the scoped
    // user) → no usage before the SQL aggregate ignores the empty set.
    return emptySharedAgentSessionsUsageSummary();
  }

  // FEA-1834 / PLN-941 §4: prefer the O(grouped) SQL aggregation — the summary
  // never hydrates the corpus on the live cadence. Skipped for explicit-id
  // requests (the aggregation cannot represent explicit id sets) and for
  // free-text search (the aggregation cannot match the hydrated
  // repositoryFullName/baseBranch fields), both of which fall through to the
  // hydrate path below so usage filtering stays identical to list filtering.
  if (source.aggregateUsage && canUseAggregateSessionFilters(request, query)) {
    const aggregate = await source.aggregateUsage(buildAggregateFilters(query));
    return foldUsageAggregate(aggregate);
  }

  // FEA-1834: prefer the lightweight usage load (session metadata +
  // tokenUsageByModel only) when the source supports it. Mirrors the
  // non-paginated `loadWorkingSessions` path exactly — same ordered ids, same
  // re-index/rebuild from `orderedIds`, same `matchesQuery` filter, same
  // `buildUsageSummary` fold — but skips the agents/events hydration so the
  // summary stays cheap on the live cadence. Rebuilding from `orderedIds`
  // (rather than trusting the source's return order) keeps the result identical
  // to the full path even if a source returns DB-natural order or extra rows.
  // Which query shapes are admitted — and why each excluded facet is excluded —
  // is `lightweightUsageLoadFitsQuery`, beside its sibling fast-path predicates.
  if (source.loadUsageSessions && lightweightUsageLoadFitsQuery(query)) {
    // FEA-4286: cap the id set at MAX_WORKING_SET_SESSIONS (the FEA-3132 A5b
    // ceiling). This path still materializes EVERY resolved session into JS via
    // `loadUsageSessions` + the `buildUsageSummary` fold — "lightweight per row"
    // (metadata + tokenUsageByModel, no agents/events) is not "bounded in total":
    // uncapped it is O(corpus), and it fires on the Sessions page's 2 s
    // background page-data poll (`DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS`). On
    // a very large local corpus that steady-cadence full-corpus hydrate starved
    // the desktop main process, wedging the renderer (it stopped answering the
    // Vite HMR ping → "server connection lost. Polling for restart"). Capping
    // here mirrors the "can't push to SQL" fallback below and every other
    // hydration path, all of which resolve with `cap: true`.
    //
    // Trade-off (was FEA-3207): on a corpus > MAX_WORKING_SET_SESSIONS the usage
    // cards now aggregate over the MOST-RECENT MAX_WORKING_SET_SESSIONS (the rows
    // the UI renders first, ordered `updated_at DESC`) rather than the whole set,
    // so their total can trail the list header past the ceiling — the same
    // bounded-hydration trade-off the fallback path already accepts. Bounding the
    // read is the reliability priority; the exact-parity fast path belongs on the
    // SQL `aggregateUsage` aggregate (tried first above), which never hydrates.
    //
    // ISS-5626: an active Repository selection is scoped PRE-hydration here for
    // the same reason the fallback below scopes it — the cap must bound the
    // MATCHED id set, not a corpus prefix the repo predicate then thins out.
    const orderedIds = await resolveOrderedIds(source, request, {
      cap: true,
      repositories: query.repositories,
    });
    if (orderedIds.length === 0) {
      // Fold the empty set rather than returning the canned empty summary: the
      // two differ (the fold emits `modelFilterOptions: []`, the canned shape
      // omits it), and a selection resolving to no rows is an ANSWER — it must
      // read identically whichever path answered it. The canned shape stays for
      // the two refusals above, which answer nothing.
      return buildUsageSummary([]);
    }
    const loaded = await source.loadUsageSessions(orderedIds);
    const loadedById = indexSessionsById(loaded);
    const ordered = orderedIds.flatMap((id) => {
      const session = loadedById.get(id);
      return session ? [session] : [];
    });
    const filtered = ordered.filter((session) => matchesQuery(session, query));
    return buildUsageSummary(filtered);
  }

  const { filtered } = await loadWorkingSessions(source, request, query, {
    applyPagination: false,
  });
  return buildUsageSummary(filtered);
}

/**
 * Aggregate local sessions into the canonical analytics response. Local
 * desktop cannot resolve cloud projects, so `byProject` is intentionally empty
 * while tools, agent types, and repository/worktree buckets derive from loaded
 * rows.
 *
 * Takes the LIST request shape: an explicit `ids` set is a supported input here
 * (`canUseAggregateSessionFilters` checks for it and `resolveOrderedIds` honors
 * it on the hydrate path), so the narrower query-only type understated what this
 * read accepts.
 */
export async function getSharedAgentSessionAnalytics(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsListRequest = {}
): Promise<SharedAgentSessionAnalytics> {
  if (!source) {
    return emptySharedAgentSessionsAnalytics();
  }

  const query = sanitizeQuery(request, SESSIONS_ANALYTICS_DATE_WINDOW_FIELD);
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    // FEA-4304: empty owner AND-intersection (Owner facet excludes the scoped
    // user) → no analytics before the SQL aggregate ignores the empty set.
    return emptySharedAgentSessionsAnalytics();
  }

  // FEA-2038: prefer the O(grouped) SQL aggregation — analytics never hydrates
  // the whole filtered session/event/agent/token corpus into JS (the db-host
  // OOM, exit code 5). Skipped for explicit-id requests (the aggregation cannot
  // represent explicit id sets) and for free-text search (the aggregation cannot
  // match the hydrated repositoryFullName/baseBranch fields); both fall through
  // to the hydrate path below so analytics filtering stays identical to list
  // filtering.
  if (
    source.aggregateAnalytics &&
    canUseAggregateSessionFilters(request, query)
  ) {
    const cache = createSessionAttributionResolverCache();
    const aggregate = await source.aggregateAnalytics(
      buildAggregateFilters(query),
      cache
    );
    return foldAnalyticsAggregate(aggregate);
  }

  const { filtered } = await loadWorkingSessions(source, request, query, {
    applyPagination: false,
  });
  return buildAnalytics(filtered);
}

async function loadWorkingSessions(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery,
  options: WorkingSetOptions
): Promise<{
  ordered: SyncedAgentSession[];
  filtered: SyncedAgentSession[];
  page: SyncedAgentSession[];
  total: number;
  // FEA-3450: idle rows hidden by the substantive default, within the current
  // filter scope. Non-zero only on the full-corpus hydration path with
  // `countIdle` set (the substantive list read); every SQL fast path and
  // `quality=all` request reports 0 (nothing is hidden).
  idleCount: number;
}> {
  const cursorPage =
    options.applyPagination &&
    (await loadCursorPageBeforeHydration(source, request, query));
  if (cursorPage) {
    const hydrated = await loadOrderedPage(
      source,
      cursorPage.rows.map((row) => row.id)
    );
    // Selection (`listSessionCursorPage`) and hydration (`loadSyncedSessions`)
    // are SEPARATE db-host invokes, so a row's status can transition between
    // them — and status is the one selected dimension that changes on its own
    // while the user is looking at the list (a live session ends every few
    // minutes; a start date or a search term does not). Re-apply the SAME
    // selection to the hydrated row: without it the page carries a row that no
    // longer belongs to the requested facet, and `mapListItem` renders it with
    // its NEW status — an "Inactive" row inside an Active-filtered list. Dropping
    // it makes the page shorter than `limit`; keeping it would make the row lie,
    // which is the worse of the two. `total` stays the selection-time count: it
    // is a snapshot of the cohort, and recounting it here would need a second
    // round trip that could itself be stale.
    const statuses = selectedStatusesFromQuery(query);
    const page = hydrated.filter(
      (session) =>
        statuses.length === 0 ||
        statuses.some((status) => matchesStatusFilter(session, status))
    );
    return {
      ordered: page,
      filtered: page,
      page,
      total: cursorPage.total,
      idleCount: 0,
    };
  }

  // FEA-3132 (A5b): the cursor-only paging branch below slices `orderedIds` and
  // hydrates a single page — it never holds the full working set in memory, so
  // the MAX_WORKING_SET_SESSIONS ceiling must NOT apply here (it would cap
  // `total` at 5000 and return an empty page for `offset >= 5000`). Resolve the
  // full id list uncapped for this path; the cap belongs only to the
  // full-corpus hydration fallback further down.
  if (options.applyPagination && canPageBeforeLoading(source, request, query)) {
    const orderedIds = await resolveOrderedIds(source, request, {
      cap: false,
      // ISS-4558: an empty selection takes the plain cursor list; a non-empty
      // one was admitted above only if the source can resolve it pre-hydration.
      repositories: query.repositories,
      // ISS-4558: this branch runs NO in-memory matcher, so the window/sort the
      // request carries has to be applied by the id resolution itself.
      // `canPageWindowAndSortBeforeHydration` only admits a windowed or sorted
      // read on the repository-scoped path, which pushes both into its SQL — so
      // for every other read here this is empty and nothing changes.
      repositoryScope: repositoryScopeOptionsFromQuery(query),
    });
    if (orderedIds.length === 0) {
      return { ordered: [], filtered: [], page: [], total: 0, idleCount: 0 };
    }
    const pageIds = orderedIds.slice(query.offset, query.offset + query.limit);
    const page = await loadOrderedPage(source, pageIds);
    return {
      ordered: page,
      filtered: page,
      page,
      total: orderedIds.length,
      idleCount: 0,
    };
  }
  // ISS-4535 (PR #3996, @wongk): resolve an active Repository selection from the
  // pre-hydration `(cwd, repo_full_name)` identity the facet options use, so a
  // repo represented only by sessions older than the newest window still
  // resolves instead of returning zero rows — while the cap still bounds the
  // MATCHED id set, keeping the FEA-4286 hydration ceiling intact here too.
  //
  // ISS-4558: a repo-filtered LIST read no longer reaches this fallback — it
  // pages above, so its `total` matches the facet. That now holds for the shape
  // the Sessions view actually sends: wongk's #4751 review caught that the first
  // cut admitted only an unwindowed, unsorted read, while `SessionsView` sends a
  // 90d window and `sortBy: lastActivity` from its first render — so every real
  // repo-filtered read still landed here and the 5,050-vs-5,000 contradiction
  // survived the fix. The window and sort are pushed into the repository-scoped
  // SQL instead (`RepositoryScopedSessionIdsOptions`).
  //
  // What still lands here is the repo filter COMBINED with a predicate needing
  // the hydrated row (harness, quality segment, cost bucket, a non-cursor sort
  // column…), plus the non-paginated ANALYTICS fold, which must hydrate every
  // match to sum tokens. ISS-5626 took the repo-filtered USAGE fold off this
  // path — its lightweight rows carry the repo identity — so usage reaches here
  // only for a source without `loadUsageSessions`. Past the ceiling those totals
  // stay the MOST-RECENT MAX_WORKING_SET_SESSIONS — the same bounded-read
  // trade-off every other fallback read accepts, not a repo-specific one. Making
  // them exact needs the windowed/streaming hydration that removes the ceiling
  // outright, tracked on FEA-4163.
  const orderedIds = await resolveOrderedIds(source, request, {
    cap: true,
    repositories: query.repositories,
  });
  if (orderedIds.length === 0) {
    return { ordered: [], filtered: [], page: [], total: 0, idleCount: 0 };
  }
  const cache = createSessionAttributionResolverCache();
  // FEA-2038: same as the paged branch above — this full-corpus hydration feeds
  // only the event-data-free folds (list/analytics/usage), so omit `event.data`
  // to keep peak memory flat as the corpus grows.
  const loaded = await source.loadSyncedSessions(orderedIds, cache, LIST_LOAD);
  const loadedById = indexSessionsById(loaded);
  const ordered = orderedIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [session] : [];
  });
  const { matched, idleCount } = partitionWorkingSet(ordered, query, options);
  const filtered = sortSyncedSessions(matched, query);
  const total = filtered.length;
  const page = options.applyPagination
    ? filtered.slice(query.offset, query.offset + query.limit)
    : filtered;

  return { ordered, filtered, page, total, idleCount };
}

/**
 * FEA-3450/FEA-4145: filter the hydrated corpus and, on the substantive list
 * read (`countIdle` set + the `substantive` segment active), bucket the
 * idle-but-in-scope rows the segment hides into `idleCount` in the SAME pass —
 * folding what used to be a second full-corpus `computeIdleCount` scan
 * (`sumTokenUsage` + `countToolUseEvents` per row) into this one loop.
 * `matchesListQuery` decomposes exactly to `matchesQuery` +
 * `isSessionVisibleForQuality`, so under the `substantive` segment the bucketed
 * `matched` set is byte-identical to `ordered.filter(matcher)` while the
 * hidden-idle count comes for free. Under `idle`/`all` and every other
 * caller/path, keep the plain matcher and report 0.
 */
function partitionWorkingSet(
  ordered: SyncedAgentSession[],
  query: SanitizedQuery,
  options: WorkingSetOptions
): { matched: SyncedAgentSession[]; idleCount: number } {
  const matcher = options.matcher ?? matchesQuery;
  const bucketIdle =
    options.countIdle === true && query.quality === "substantive";
  const matched: SyncedAgentSession[] = [];
  let idleCount = 0;
  for (const session of ordered) {
    if (!bucketIdle) {
      if (matcher(session, query)) {
        matched.push(session);
      }
      continue;
    }
    if (!matchesQuery(session, query)) {
      continue;
    }
    if (sessionIsSubstantive(session)) {
      matched.push(session);
    } else {
      idleCount += 1;
    }
  }
  return { matched, idleCount };
}

/**
 * FEA-3284/FEA-4145: the list matcher — every `matchesQuery` facet PLUS the
 * `quality` segment gate (`substantive` hides idle rows, `idle` shows only idle
 * rows, `all` shows both). Kept separate from `matchesQuery` so the
 * usage/analytics folds — which must stay byte-for-byte in step with the SQL
 * `aggregateUsage`/`aggregateAnalytics` paths (FEA-1834 §4), and the desktop
 * `sessions` table has no turn/token/tool columns to push the substantive
 * predicate into SQL — do NOT apply the gate. The quality segment therefore
 * shapes the LIST + its `idleCount`; usage totals cover the same all-quality set
 * the SQL aggregate does. The visibility rule is the shared @repo/api SSOT so
 * the desktop and cloud segments can never disagree.
 */
function matchesListQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  if (!matchesQuery(session, query)) {
    return false;
  }
  return isSessionVisibleForQuality(
    sessionIsSubstantive(session),
    query.quality
  );
}

async function loadOrderedPage(
  source: AgentSessionSyncSource,
  pageIds: string[]
): Promise<SyncedAgentSession[]> {
  const cache = createSessionAttributionResolverCache();
  // FEA-2038: the list/analytics/usage working set is folded by mapListItem /
  // matchesQuery / buildUsageSummary / buildAnalytics, none of which read
  // `event.data`. Drop the heavy event `data` blob so loading a page never
  // retains every event payload at once (the db-host OOM). The detail path
  // hydrates with full data via its own loadSyncedSessions call.
  const loaded = await source.loadSyncedSessions(pageIds, cache, LIST_LOAD);
  const loadedById = indexSessionsById(loaded);
  return pageIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [session] : [];
  });
}

// FEA-3132 (A5b): hard ceiling on the full-corpus working set. When a search or
// facet filter can't be pushed into SQL, the list/usage/analytics reads fall
// through `resolveOrderedIds` → `loadSyncedSessions(orderedIds, …)` and hydrate
// EVERY matching session (agents/events/links/tokenUsage; `omitEventData` only
// drops the `data` blob) — unbounded to corpus size and a direct co-peaker with
// backfill in the db-host OOM. `listAllSessionCursorRows` returns rows ordered
// `updated_at DESC, id DESC`, so capping here keeps the MOST RECENT N sessions
// (the ones the UI actually renders first) and bounds peak read memory regardless
// of corpus growth. The P1 streaming fold (hydrate in windows, fold, release)
// removes the ceiling; until then this trades exhaustive search over a very large
// corpus for a bounded footprint. Explicit-id requests are already request-bounded
// and are NOT capped.
//
// ISS-4535: this ceiling is corpus-wide for EVERY fallback read, the Repository
// filter included. That path resolves its match set pre-hydration from
// `(cwd, repo_full_name)` (`listRepositoryScopedSessionIds`) so an older-than-the-
// window repo still resolves, but the resolved MATCHED ids are then capped here
// too — so the hydration footprint stays bounded and this comment's promise holds.
//
// Exported so the read surface (and its tests) can reference the same ceiling —
// e.g. to assert the fallback hydrates at most this many ids, and so the UI can
// surface "showing first N" without duplicating the literal.
export const MAX_WORKING_SET_SESSIONS = 5000;

async function resolveOrderedIds(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  options: ResolveOrderedIdsOptions = { cap: true }
): Promise<string[]> {
  const explicitIds = explicitIdsFromRequest(request);
  if (explicitIds !== null) {
    return explicitIds;
  }
  // ISS-4535 (@wongk): when a Repository filter is active, resolve the matching
  // ids PRE-hydration from `(cwd, repo_full_name)` — the same persisted-aware
  // identity the facet options use — so the predicate runs against every
  // session's metadata (not just the newest window) instead of hydrating the
  // full corpus uncapped. The cap still applies to the MATCHED id set below, so
  // the FEA-4286 hydration bound stays intact even for the repo-filter path.
  //
  // ISS-5625: the cap is ALSO handed to that read as `limit`, so a source able
  // to bound its own id selection stops producing the tail this function is
  // about to discard. `sanitizeIds` still applies it — a source that ignores
  // `limit` (the degraded full-cursor-list fallback below, a fake) is bounded
  // exactly as before.
  const orderedIds =
    options.repositories && options.repositories.length > 0
      ? await resolveRepositoryScopedSessionIds(
          source,
          options.repositories,
          createSessionAttributionResolverCache(),
          {
            ...options.repositoryScope,
            ...(options.cap ? { limit: MAX_WORKING_SET_SESSIONS } : {}),
          }
        )
      : (await source.listAllSessionCursorRows()).map((row) => row.id);
  // The cap bounds peak read memory only on the full-corpus HYDRATION paths
  // (usage summary + the fallback below). The cursor-only paging path hydrates
  // a single page from a slice, so it opts out (`cap: false`) to keep pagination
  // and `total` correct past 5000 sessions.
  return sanitizeIds(orderedIds, {
    limit: options.cap ? MAX_WORKING_SET_SESSIONS : null,
  });
}

type ResolveOrderedIdsOptions = {
  cap: boolean;
  /**
   * ISS-4535: when set, the active Repository facet selection. The ordered id
   * list is resolved from the pre-hydration repository-scoped source method so
   * the predicate runs against the whole corpus's metadata while the cap still
   * bounds the hydrated match set.
   */
  repositories?: readonly string[];
  /**
   * ISS-4558: the date window and sort to push into that repository-scoped read.
   * Set ONLY by the pre-hydration paging branch, which runs no in-memory matcher
   * and so needs the ids to come back already windowed and already ordered. The
   * capped fallback omits it and keeps applying both from the hydrated rows.
   */
  repositoryScope?: RepositoryScopedSessionIdsOptions;
};

function explicitIdsFromRequest(
  request: SharedAgentSessionsListRequest
): string[] | null {
  if (!Object.hasOwn(request, "ids")) {
    return null;
  }
  const ids = (request as { ids?: unknown }).ids;
  return Array.isArray(ids) ? sanitizeIds(ids, { limit: MAX_LIST_LIMIT }) : [];
}

/**
 * Harness/model multi-select and autonomy-tier / cost-bucket threshold facets —
 * the in-memory-only filters (no cursor-page equivalent), split out of
 * `matchesQuery` to keep its complexity bounded. Each dimension matches when the
 * session falls in ANY selected value (OR within a dimension); the dimensions
 * compose with AND. Uses the shared @repo/api SSOT so the desktop classification
 * is identical to the cloud query builder.
 */
function matchesLocalFacetFilters(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  // Normalize a null harness/model to "unknown" so the facet selection matches
  // the option keys the usage breakdown emits (byHarness/byModel key null under
  // "unknown"); otherwise selecting "unknown" would hide the very rows it counts.
  if (
    query.harnesses.length > 0 &&
    !query.harnesses.includes(session.harness ?? "unknown")
  ) {
    return false;
  }
  // FEA-4303: match on the single PRIMARY displayed model (`session.model`), NOT
  // the per-token-usage set — the Model facet options are now sourced from the
  // primary-model rollup (`modelFilterOptions`) and the Sessions table paints the
  // primary model, so options, predicate, and column share one vocabulary. This
  // mirrors the cloud predicate in `query-builder.ts`, which filters on
  // `SessionDetail.model`. A null primary model normalizes to "unknown" (the
  // facet drops it, but a restored/deep-linked "unknown" selection still matches
  // rather than hiding the rows it would count).
  if (
    query.models.length > 0 &&
    !query.models.includes(session.model ?? "unknown")
  ) {
    return false;
  }
  if (
    query.autonomyTiers.length > 0 &&
    !query.autonomyTiers.some((tier) =>
      matchesAutonomyTier(session.autonomy ?? null, tier)
    )
  ) {
    return false;
  }
  if (
    query.costBuckets.length > 0 &&
    // shafty thread (ISS-4481): an exhaustive selection excludes no row — skip
    // the matcher entirely so it composes as a no-op (and matches the
    // `hasNoLocalFacetFilters` fast-path decision).
    !isExhaustiveCostFilter(query.costBuckets) &&
    !matchesLocalCostBucketFilter(
      sumTokenUsage(session).estimatedCost,
      session.billingMode ?? null,
      // ISS-4481: the numeric-vs-unknown boundary gates on measurable work (a
      // no-work subscription session renders "—"), so pass the SAME substantive
      // counts the Idle badge derives.
      localSubstantiveCounts(session),
      query.costBuckets
    )
  ) {
    return false;
  }
  // Change presence / PR association use the same signals the local Sessions row
  // is built from (mapListItem → buildLocalSessionTraceFields), which the
  // assembler may populate as either the top-level scalar LOC fields or the
  // dedicated git/branch diff-stat objects, and PRs as either `prs` (trace) or
  // `prRefs` (artifact-link) — so consider all of them to stay in step with the
  // row and with the cloud query (which likewise checks both PR sources).
  if (query.changePresence.length > 0) {
    const hasChanges = localSessionHasChanges(session);
    if (
      !query.changePresence.some((option) =>
        matchesChangePresence(hasChanges, option)
      )
    ) {
      return false;
    }
  }
  if (query.prAssociation.length > 0) {
    const hasPr = localSessionHasPr(session);
    if (
      !query.prAssociation.some((option) => matchesPrAssociation(hasPr, option))
    ) {
      return false;
    }
  }
  return true;
}

/** True when any local diff signal (top-level LOC or git/branch stats) is non-empty. */
function localSessionHasChanges(session: SyncedAgentSession): boolean {
  return (
    sessionHasChanges(session) ||
    sessionHasChanges(session.gitDiffStats ?? {}) ||
    sessionHasChanges(session.branchDiffStats ?? {})
  );
}

/**
 * ISS-4556 / ISS-4559: the Status facet, behind the
 * `sessions-displayed-status-parity` Labs flag. ON, membership is decided against
 * the status the row DISPLAYS, so it agrees with the Status cell and the Status
 * sort and no row falls between the Active and Waiting facets. OFF (the
 * closed-by-default rollout state), the pre-ISS-4556 parallel branches apply
 * unchanged.
 */
function matchesStatusFilter(
  session: SyncedAgentSession,
  requestedStatus: string
): boolean {
  return matchesSharedStatusFilter(
    session,
    requestedStatus,
    isDisplayedStatusParityEnabled()
  );
}

function matchesQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  // The multi-select `harnesses` facet takes precedence over the single-value
  // back-compat `harness` param (matches the cloud service precedence).
  if (
    query.harnesses.length === 0 &&
    query.harness &&
    session.harness !== query.harness
  ) {
    return false;
  }
  // Multi-select status: match if ANY selected status matches (single `status`
  // stays as a back-compat fallback when no multi-select set is present).
  if (
    query.statuses.length > 0 &&
    !query.statuses.some((status) => matchesStatusFilter(session, status))
  ) {
    return false;
  }
  if (
    query.statuses.length === 0 &&
    query.status &&
    !matchesStatusFilter(session, query.status)
  ) {
    return false;
  }
  if (!sessionMatchesRepositoryFilter(session, query.repositories)) {
    return false;
  }
  if (!matchesLocalFacetFilters(session, query)) {
    return false;
  }
  if (
    query.userIds.length > 0 &&
    !query.userIds.includes(session.userId ?? "")
  ) {
    return false;
  }
  if (
    query.userIds.length === 0 &&
    query.userId &&
    session.userId !== query.userId
  ) {
    return false;
  }
  if (query.search && !matchesSearch(session, query.search)) {
    return false;
  }
  return matchesDateBounds(session, query);
}

/**
 * The date-window + completion-boundary predicate, split out of `matchesQuery`
 * to keep its cognitive complexity bounded.
 *
 * ISS-5443: the `startDate`/`endDate` window is measured against
 * `query.dateWindowField` — the SAME field the read's SQL fast path bounds on,
 * because both come from the one constant the read entrypoint declared. It used
 * to be hardcoded to `startedAt` here while the Sessions list's SQL clause bound
 * on `last_activity_at`, so whether a session was "in the window" depended on
 * which path answered: the cheap cursor page and the hydrated fallback (a status
 * or facet filter is enough to switch between them) disagreed about the same
 * row.
 *
 * The FEA-3009 `completedAfter` bound is unchanged and independent: it filters
 * on the terminal `endedAt` timestamp — NOT the window field — so a session that
 * started before the boundary but COMPLETED after it is kept (the parity the
 * cloud `applyCompletionFilter` enforces via `sessionEndedAt >= completedAfter`).
 * A session with no `endedAt` (still running / never completed) is excluded from
 * the completion bound, matching the cloud `gte` on the nullable column (which
 * never matches NULL).
 */
function matchesDateBounds(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  const windowAt = parseSessionDate(
    sessionDateWindowValue(session, query.dateWindowField)
  );
  if (query.startDate && windowAt < query.startDate) {
    return false;
  }
  if (query.endDate && windowAt > query.endDate) {
    return false;
  }
  if (query.completedAfter) {
    const endedAt = parseNullableSessionDate(session.endedAt);
    if (endedAt === null || endedAt < query.completedAfter) {
      return false;
    }
  }
  return true;
}

function canUseAggregateSessionFilters(
  request: SharedAgentSessionsQuery,
  query: SanitizedQuery
): boolean {
  return (
    !Object.hasOwn(request, "ids") &&
    query.search === null &&
    query.repositories.length === 0 &&
    // FEA-3009: the completion bound (`endedAt >= completedAfter`) is not part of
    // the desktop usage/analytics SQL aggregate, so fall back to the hydrated
    // `matchesQuery` fold when it's set (the badge count read never hits usage
    // anyway, but keep the guard so an aggregate caller can't drop the filter).
    query.completedAfter === null &&
    hasNoLocalFacetFilters(query)
  );
  // FEA-3284 note: the substantive predicate is NOT threaded into the desktop
  // usage/analytics SQL aggregate — the local `sessions` table stores no
  // turn/token/tool columns, so it isn't SQL-expressible without joins, and
  // forcing the JS fold here would regress the FEA-3207 uncapped aggregate-parity
  // contract. The substantive default applies to the LIST read (the FEA-3284
  // requirement + idleCount); the cloud API applies it to usage/analytics too.
}

/**
 * FEA-4142: whether a count-only list read reduces to a metadata-only SQL
 * `COUNT(*)`. The count SQL (`source.countSessions`) covers status/statuses (via
 * the shared `buildUsageStatusPredicate`, identical to `matchesStatusFilter`),
 * ownership, the `startDate`/`endDate` window (on the read's
 * `dateWindowField`, threaded through `buildCountFilters`), and the `completedAfter`
 * completion bound — so those may be present. It CANNOT express a free-text
 * search, the repository facet, the in-memory-only local facets, an explicit-id
 * set, or the substantive/idle quality gate (the local `sessions` table stores
 * no turn/token/tool columns), so any of those forces the hydrated fold below.
 * `quality === "all"` is required because the COUNT reproduces the all-quality
 * `matchesQuery` total the hydrated path yields under the fail-open default; a
 * narrowed segment hides idle rows the COUNT can't.
 */
function canAnswerWithCount(
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): boolean {
  return (
    query.countOnly &&
    !Object.hasOwn(request, "ids") &&
    query.search === null &&
    query.repositories.length === 0 &&
    hasNoLocalFacetFilters(query) &&
    query.quality === "all"
  );
}

/**
 * FEA-4142: the count filters for a count-only read — the shared aggregate
 * filters (status/ownership/started-window) plus the FEA-3009 completion bound
 * (`ended_at >= completedAfter`) serialized to the ISO string the SQL compares.
 */
function buildCountFilters(query: SanitizedQuery): AgentSessionCountFilters {
  return {
    ...buildAggregateFilters(query),
    ...(query.completedAfter
      ? { completedAfter: query.completedAfter.toISOString() }
      : {}),
  };
}

function buildAggregateFilters(
  query: SanitizedQuery
): AgentSessionUsageAggregateFilters {
  return {
    ...(query.harness ? { harness: query.harness } : {}),
    ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
    ...(query.statuses.length === 0 && query.status
      ? { status: query.status }
      : {}),
    ...(query.userIds.length > 0 ? { userIds: query.userIds } : {}),
    ...(query.userIds.length === 0 && query.userId
      ? { userId: query.userId }
      : {}),
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    // ISS-5443: carry the read's window basis into the SQL aggregate so the
    // fast path and the hydrated fold bound on the same timestamp. Always set —
    // `sanitizeQuery` requires it — so the aggregate never falls back to a
    // default the JS fold did not use.
    dateWindowField: query.dateWindowField,
  };
}

export function mapListItem(
  session: SyncedAgentSession,
  pendingOutbox: PendingOutboxLookup = DEFAULT_PENDING_OUTBOX_LOOKUP,
  transcripts: TranscriptDispositionLookup = DEFAULT_TRANSCRIPT_LOOKUP
): SharedAgentSessionListItem {
  const totals = sumTokenUsage(session);
  const attribution = session.attribution ?? null;
  const updatedAt = parseSessionDate(session.updatedAt);
  // ISS-4556: serve the DISPLAYED status, the SAME projection the Status SORT
  // (`session-working-set-sort.ts`) and the Status FACET (`matchesStatusFilter`)
  // key off, so the cell, the sort, and the filter cannot disagree — and so the
  // row carries the same value the cloud list projection serves (which has
  // applied the Waiting projection since FEA-4301 and the staleness /
  // unrecognized folds since ISS-5366). Ungated this reverts to the raw
  // canonical status, which is today's desktop behavior.
  const status = servedSharedSessionStatus(session);
  const prs = localSessionPullRequests(session);
  const primaryModel = session.model ?? null;
  const toolUseCount = countToolUseEvents(session.events);
  // Resolve the owner once against the cloud org directory so the Owner cell's
  // identity (`user`) and its dot color (`userColor`) derive from the SAME
  // snapshot read — and populate `userColor` via the shared `buildUserColor`
  // SSOT so Local mode matches Cloud instead of hardcoding null (FEA-3456).
  const owner = resolveOwner(session.userId ?? null, getOrgDirectorySnapshot());

  return {
    ...buildLocalSessionIdentity(
      session,
      attribution,
      status,
      primaryModel,
      prs
    ),
    ...buildLocalSessionTraceFields(session, totals, prs, toolUseCount, owner),
    ...buildLocalSessionTimingAndUsage(
      session,
      totals,
      updatedAt,
      toolUseCount
    ),
    ...buildLocalSessionRelations(attribution, updatedAt, owner),
    // PLN-1034: genuine activity, floored at the start for event-less sessions.
    // ISS-6270: through the SHARED anchor, so the main-process mirror of this
    // row's displayed status folds against the instant actually served here.
    lastActivityAt: servedSessionActivityAt(session),
    // PRD-536 E6 + ISS-4647: per-row local-vs-cloud disclosure across BOTH cloud
    // lanes. The outbox is the metadata lane (enqueued, not yet server-acked);
    // the transcript verdict is the raw-blob lane. Either one being behind makes
    // the cloud copy behind. Both lanes default to the never-consulted lookup on
    // the by-id / detail paths (they pass no lookups), so those rows read
    // `synced` — the honest default when neither lane was consulted. #4150: a
    // lane whose lookup FAILED (`available: false`) is passed through as unknown
    // and yields NO disclosure, so a read that never completed cannot masquerade
    // as proof the row is synced.
    ...buildLocalCloudSyncDisclosure(
      pendingOutbox.available
        ? {
            known: true,
            pending: pendingOutbox.ids.has(session.externalSessionId),
          }
        : { known: false },
      transcripts.available
        ? {
            available: true,
            disposition: transcripts.byId.get(session.externalSessionId),
          }
        : { available: false }
    ),
  };
}

function buildLocalSessionIdentity(
  session: SyncedAgentSession,
  attribution: SyncedAgentSession["attribution"] | null,
  status: string,
  primaryModel: string | null,
  prs: NonNullable<SyncedAgentSession["prs"]>
): Pick<
  SharedAgentSessionListItem,
  | "branch"
  | "cwd"
  | "externalSessionId"
  | "harness"
  | "id"
  | "model"
  | "models"
  | "name"
  | "origin"
  | "primaryModel"
  | "prs"
  | "repo"
  | "repositoryFullName"
  | "slug"
  | "state"
  | "status"
  | "worktreePath"
> {
  return {
    id: session.externalSessionId,
    slug: null,
    externalSessionId: session.externalSessionId,
    name: session.name ?? null,
    status,
    origin: LOCAL_AGENT_SESSION_ORIGIN,
    // ISS-4556: `state` keys off the RAW canonical status, never the displayed
    // projection. The classifier switches on the terminal status sets before it
    // reaches its own `awaitingInputSince && !endedAt` branch, so feeding it a
    // presentation value would let a future displayed status that collides with
    // one of those sets silently rewrite `state`. (`waiting` does not collide
    // today — both `active` and `waiting` fall through to the same
    // `PendingApproval` — so this keeps the current behavior while removing the
    // trap.) It is the same rule `foldLegacyTerminalStatus` states for the
    // Inactive fold: display folds belong to the status cell, not to `state`.
    state: deriveAgentSessionFallbackState({
      status: canonicalSharedStatus(session.status),
      awaitingInputSince: session.awaitingInputSince,
      endedAt: session.endedAt,
    }),
    harness: session.harness ?? "unknown",
    cwd: session.cwd ?? null,
    repositoryFullName: attribution?.repositoryFullName ?? null,
    repo: attribution?.repositoryFullName ?? null,
    worktreePath: attribution?.worktreePath ?? null,
    model: primaryModel,
    primaryModel,
    models: toSingleModelList(primaryModel),
    branch: resolveLocalSessionBranch(session),
    prs,
  };
}

function buildLocalSessionTraceFields(
  session: SyncedAgentSession,
  totals: SessionTotals,
  prs: NonNullable<SyncedAgentSession["prs"]>,
  toolUseCount: number,
  owner: BasicUser | null
): Pick<
  SharedAgentSessionListItem,
  | "activeAgent"
  | "activityBuckets"
  | "autonomy"
  | "cache"
  | "cacheWrite"
  | "cost"
  | "filesChanged"
  | "gitDiffStats"
  | "branchDiffStats"
  | "kloc"
  | "locPerDollar"
  | "linesAdded"
  | "linesRemoved"
  | "markers"
  | "phaseIterations"
  | "phaseLoopbacks"
  | "phases"
  | "prsMerged"
  | "span"
  | "steeringEpisodes"
  | "throttles"
  | "tokensIn"
  | "tokensOut"
  | "toolCallsTotal"
  | "turns"
  | "userColor"
  | "waitingUser"
  | "wallClock"
> {
  return {
    prsMerged: countMergedPullRequests(prs),
    cost: formatCurrency(totals.estimatedCost),
    wallClock: session.wallClock ?? null,
    activeAgent: session.activeAgent ?? null,
    waitingUser: session.waitingUser ?? null,
    linesAdded: session.linesAdded ?? null,
    linesRemoved: session.linesRemoved ?? null,
    filesChanged: session.filesChanged ?? null,
    // FEA-4250: project LOC/$ locally at parity with the cloud so the Local
    // surface carries the same read-contract fields. `sessionLocalGitLoc` is the
    // same `gitDiffStats ?? loose-scalar` LOC precedence the cloud persists, and
    // `totals.estimatedCost` is the summed token cost the cloud ingests — so the
    // two derive the value from the same basis via the shared @repo/api SSOT.
    //
    // FEA-4378: the CLOUD numerator additionally rolls up the authored-PR LOC
    // (`max(localDiff, branchDiff, authoredPrLinesChanged)`) so a multi-PR session
    // whose local working-tree diff is a tiny residual still reads its real
    // delivered code. The Local surface OMITS `authoredPrLinesChanged` (the local
    // `SessionPR` shape carries no per-PR LOC), so both this projection AND the
    // shared "Lines changed" display resolve to `max(localDiff, branchDiff)` —
    // ISS-4667 (wongk): the projected `locPerDollar` MUST divide cost into that
    // SAME reconciling numerator, not the bare local residual, or a merged
    // multi-PR session shows a 4,004-line "Lines changed" beside a ratio computed
    // over 56 lines. `sessionLocPerDollarNumeratorLoc` is that shared basis.
    kloc: klocFromLines(sessionLocPerDollarNumeratorLoc(session)),
    locPerDollar: locPerDollarFromLines(
      sessionLocPerDollarNumeratorLoc(session),
      totals.estimatedCost
    ),
    gitDiffStats: session.gitDiffStats ?? null,
    branchDiffStats: session.branchDiffStats ?? null,
    turns: session.turns ?? null,
    toolCallsTotal: toolUseCount,
    steeringEpisodes: session.steeringEpisodes ?? null,
    autonomy: session.autonomy ?? null,
    tokensIn: totals.inputTokens,
    tokensOut: totals.outputTokens,
    cache: totals.cacheReadTokens,
    cacheWrite: totals.cacheWriteTokens,
    // Owner dot color via the shared `buildUserColor` SSOT — null until the org
    // directory resolves the owner (rendered as the unattributed affordance,
    // matching Cloud's `buildUserColor(null)`).
    userColor: buildUserColor(owner),
    activityBuckets: session.activityBuckets ?? [],
    span: session.span ?? null,
    markers: session.markers ?? [],
    throttles: session.throttles ?? [],
    phases: session.phases ?? [],
    phaseIterations: session.phaseIterations ?? {},
    phaseLoopbacks: session.phaseLoopbacks ?? [],
  };
}

function buildLocalSessionTimingAndUsage(
  session: SyncedAgentSession,
  totals: SessionTotals,
  updatedAt: Date,
  toolUseCount: number
): Pick<
  SharedAgentSessionListItem,
  | "agentCount"
  | "awaitingInputSince"
  | "billingMode"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "endedAt"
  | "errorCount"
  | "estimatedCost"
  | "inputTokens"
  | "lastSyncedAt"
  | "outputTokens"
  | "recordUpdatedAt"
  | "startedAt"
  | "toolUseCount"
  | "updatedAt"
> {
  return {
    startedAt: parseSessionDate(session.startedAt),
    updatedAt,
    // ISS-6005: on the LOCAL producer the row's `sessions.updated_at` IS the
    // record-mutation clock — desktop writes bump it on every row mutation
    // (status, billing-mode heal, PR-link maintenance), which is the same claim
    // the cloud's GREATEST(detail.updated_at, artifacts.updated_at) makes
    // against its store. Serves the `Updated` column in Local mode.
    recordUpdatedAt: updatedAt,
    // FEA-3479 (PRD-536 G1): the local surface has no cloud upsert time; the
    // local record's own updatedAt is the freshest "synced" moment we can honor
    // for the local SQLite producer (there is no cloud round-trip here).
    lastSyncedAt: updatedAt,
    endedAt: parseNullableSessionDate(session.endedAt),
    awaitingInputSince: parseNullableSessionDate(session.awaitingInputSince),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    estimatedCost: totals.estimatedCost,
    billingMode: session.billingMode ?? null,
    agentCount: session.agents.length,
    toolUseCount,
    errorCount: countErrorEvents(session.events),
  };
}

function buildLocalSessionRelations(
  attribution: SyncedAgentSession["attribution"] | null,
  updatedAt: Date,
  owner: BasicUser | null
): Pick<
  SharedAgentSessionListItem,
  | "baseBranch"
  | "computeTarget"
  | "project"
  | "sourceArtifact"
  | "sourceArtifactId"
  | "sourceLoopId"
  | "user"
> {
  return {
    baseBranch: attribution?.baseBranch ?? null,
    sourceArtifactId: attribution?.sourceArtifactId ?? null,
    sourceArtifact: null,
    sourceLoopId: attribution?.sourceLoopId ?? null,
    // Multiplayer owner attribution: the opaque local user_id resolved against
    // the cloud org directory (canonical SoT) by the caller. Null when the
    // directory has not loaded yet or the id is unknown — rendered as the
    // unattributed affordance.
    user: owner,
    computeTarget: {
      id: LOCAL_COMPUTE_TARGET_ID,
      machineName: LOCAL_COMPUTE_TARGET_NAME,
      isOnline: true,
      lastSeenAt: updatedAt,
      // FEA-3479 (PRD-536 G1): per-target cloud sync freshness is a cloud-only
      // concept; the local SQLite producer has no such timestamp, so null.
      lastAgentSessionSyncAt: null,
    },
    project: null,
  };
}

function toSingleModelList(model: string | null): string[] {
  if (!model) {
    return [];
  }
  return [model];
}

// Write-derived branch only — no baseBranch fallback.
function countMergedPullRequests(
  prs: NonNullable<SyncedAgentSession["prs"]>
): number {
  return prs.filter(
    (pr) => pr.status.toLowerCase() === SessionPrLifecycleStatus.Merged
  ).length;
}

// Free-text match over the session's own identity plus its repo/branch, so the
// top-left search finds a session by name, repository, or branch (sessions/branches).
function matchesSearch(session: SyncedAgentSession, search: string): boolean {
  const needle = search.toLowerCase();
  const haystack = [
    session.name,
    session.externalSessionId,
    session.harness,
    session.cwd,
    session.branch,
    session.attribution?.repositoryFullName,
    session.attribution?.baseBranch,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

type ToolBreakdownGroup = SharedAgentSessionToolBreakdown & {
  sessionIds: Set<string>;
};

type AgentTypeBreakdownGroup = SharedAgentSessionAgentTypeBreakdown & {
  durationTotalMs: number;
  durationCount: number;
};

// FEA-3869: fold the per-tool, per-agent-type, and per-repository breakdowns in a
// single pass over the hydrated working set. Tool and repository error tallies
// share one inner `events` loop (each session's `events` array is scanned once,
// not twice), replacing the former three separate passes plus a second
// `countErrorEvents` scan on the largest-dimension corpus.
function buildAnalytics(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionAnalytics {
  const toolGroups = new Map<string, ToolBreakdownGroup>();
  const agentTypeGroups = new Map<string, AgentTypeBreakdownGroup>();
  const repositoryGroups = new Map<
    string,
    SharedAgentSessionRepositoryBreakdown
  >();
  for (const session of sessions) {
    const repositoryGroup = accumulateRepositoryTotals(
      repositoryGroups,
      session
    );
    accumulateSessionEvents(session, toolGroups, repositoryGroup);
    accumulateSessionAgents(session, agentTypeGroups);
  }
  return {
    viewerScope: "self",
    byTool: [...toolGroups.values()].map(stripSessionIds),
    byAgentType: [...agentTypeGroups.values()].map(
      stripAgentTypeDurationFields
    ),
    byRepository: [...repositoryGroups.values()],
    byProject: [],
  };
}

function accumulateRepositoryTotals(
  repositoryGroups: Map<string, SharedAgentSessionRepositoryBreakdown>,
  session: SyncedAgentSession
): SharedAgentSessionRepositoryBreakdown | null {
  // FEA-4299: skip a session with no facet repo identity (see
  // `sessionRepositoryName`); it renders "Unknown" and is not a facet option.
  const repositoryFullName = sessionRepositoryName(session);
  if (repositoryFullName === null) {
    return null;
  }
  const totals = sumTokenUsage(session);
  const group = repositoryGroups.get(repositoryFullName) ?? {
    repositoryFullName,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    errorCount: 0,
  };
  group.sessionCount += 1;
  group.inputTokens += totals.inputTokens;
  group.outputTokens += totals.outputTokens;
  group.estimatedCost += totals.estimatedCost;
  repositoryGroups.set(repositoryFullName, group);
  return group;
}

// Single scan of `session.events`: every error event feeds the repository error
// count, and tool-attributed events additionally feed the per-tool rollup — so
// the corpus is walked once for both dimensions.
function accumulateSessionEvents(
  session: SyncedAgentSession,
  toolGroups: Map<string, ToolBreakdownGroup>,
  repositoryGroup: SharedAgentSessionRepositoryBreakdown | null
): void {
  for (const event of session.events) {
    const isError = ERROR_EVENT_PATTERN.test(event.eventType);
    // `repositoryGroup` is null for a session with no facet repo identity
    // (FEA-4299); its errors are still counted per tool below, just not rolled
    // into a repository bucket the facet does not expose.
    if (isError && repositoryGroup) {
      repositoryGroup.errorCount += 1;
    }
    if (!event.toolName) {
      continue;
    }
    const group = toolGroups.get(event.toolName) ?? {
      toolName: event.toolName,
      invocationCount: 0,
      errorCount: 0,
      sessionCount: 0,
      sessionIds: new Set<string>(),
    };
    group.invocationCount += 1;
    if (isError) {
      group.errorCount += 1;
    }
    group.sessionIds.add(session.externalSessionId);
    group.sessionCount = group.sessionIds.size;
    toolGroups.set(event.toolName, group);
  }
}

function accumulateSessionAgents(
  session: SyncedAgentSession,
  agentTypeGroups: Map<string, AgentTypeBreakdownGroup>
): void {
  for (const agent of session.agents) {
    const agentType = agent.subagentType ?? agent.type ?? "unknown";
    const group = agentTypeGroups.get(agentType) ?? {
      agentType,
      count: 0,
      successCount: 0,
      failedCount: 0,
      avgDurationMs: null,
      durationTotalMs: 0,
      durationCount: 0,
    };
    group.count += 1;
    if (SUCCESS_STATUS_PATTERN.test(agent.status)) {
      group.successCount += 1;
    }
    if (FAILED_STATUS_PATTERN.test(agent.status)) {
      group.failedCount += 1;
    }
    const durationMs = durationBetween(agent.startedAt, agent.endedAt);
    if (durationMs !== null) {
      group.durationTotalMs += durationMs;
      group.durationCount += 1;
      group.avgDurationMs = group.durationTotalMs / group.durationCount;
    }
    agentTypeGroups.set(agentType, group);
  }
}

function stripAgentTypeDurationFields(
  group: AgentTypeBreakdownGroup
): SharedAgentSessionAgentTypeBreakdown {
  const {
    durationCount: _durationCount,
    durationTotalMs: _durationTotalMs,
    ...rest
  } = group;
  return rest;
}

export function indexSessionsById(
  sessions: readonly SyncedAgentSession[]
): Map<string, SyncedAgentSession> {
  return new Map(
    sessions.map((session) => [session.externalSessionId, session])
  );
}

function countErrorEvents(events: readonly { eventType: string }[]): number {
  return events.filter((event) => ERROR_EVENT_PATTERN.test(event.eventType))
    .length;
}

function durationBetween(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = parseSessionDate(startedAt);
  const end = parseSessionDate(endedAt);
  const durationMs = end.getTime() - start.getTime();
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}
