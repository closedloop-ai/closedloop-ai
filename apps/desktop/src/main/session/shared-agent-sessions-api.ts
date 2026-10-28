import { formatCurrency } from "@closedloop-ai/loops-api/currency";
import { isSessionVisibleForQuality } from "@repo/api/src/agent-session-filters";
import type { CanonicalAgentSessionListItem } from "@repo/api/src/types/agent-session-list-contract";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import {
  SessionStatusOrderingName,
  sessionStatusRootRankOrNull,
} from "@repo/api/src/types/session-status-root-order";
import type { BasicUser } from "@repo/api/src/types/user";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../../shared/session-date-window-contract.js";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsUsageSummary,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionListItem,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionsListRequest,
  type SharedAgentSessionsQuery,
  type SharedAgentSessionUsageSummary,
} from "../../shared/shared-agent-sessions-contract.js";
import { createSessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { RepositoryScopedSessionIdsOptions } from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { sessionDateWindowValue } from "../agent-sync/session-date-window.js";
import { resolveDesktopMachineName } from "../machine-name.js";
import { foldAnalyticsAggregate } from "./analytics-aggregate-fold.js";
import { localSessionPullRequests } from "./local-session-pull-requests.js";
import { buildLocalSessionIdentity } from "./local-shared-session-identity.js";
import {
  buildLocalCloudSyncDisclosure,
  EMPTY_TRANSCRIPT_VERDICTS,
  loadLocalTranscriptVerdicts,
  type TranscriptVerdictLookup,
} from "./local-transcript-cloud-sync.js";
import { getOrgDirectorySnapshot } from "./org-directory-cache.js";
import {
  DEFAULT_PENDING_OUTBOX_LOOKUP,
  loadPendingOutboxIdSet,
  type PendingOutboxLookup,
  resolveOutboxDisclosureInput,
} from "./pending-outbox-lookup.js";
import { servedSessionActivityAt } from "./session-activity-anchor.js";
import {
  addSessionToAnalyticsFold,
  createAnalyticsFold,
  finishAnalyticsFold,
} from "./session-analytics-fold.js";
import { supportsSessionCompactFilter } from "./session-compact-filter-capability.js";
import {
  createOrderedPageIdWindow,
  sessionHydrationWindows,
} from "./session-hydration-window.js";
import {
  parseNullableSessionDate,
  parseSessionDate,
} from "./session-instant.js";
import {
  beginSessionListQuery,
  observeSessionListQueryPopulation,
  observeSessionListWorkingSet,
} from "./session-list-query-execution.js";
import {
  type SharedAgentSessionLocCost,
  sessionLocCost,
} from "./session-loc-cost.js";
import {
  matchesLocalFacetFilters,
  matchesLocalSessionSearch,
} from "./session-local-facet-filters.js";
import {
  canPageBeforeLoading,
  lightweightUsageLoadFitsQuery,
  loadCursorPageBeforeHydration,
  repositoryScopeOptionsFromQuery,
  stillMatchesCursorSelection,
} from "./session-read-fast-paths.js";
import {
  resolveRepositoryScopedSessionIds,
  sessionMatchesRepositoryFilter,
} from "./session-repository-facet.js";
import { matchesStatusFilter } from "./session-status-filter-match.js";
import {
  buildLocalSessionTimingAndUsage,
  type SessionTotals,
  sessionIsSubstantive,
  sessionToolUseCount,
  sumTokenUsage,
} from "./session-usage-totals.js";
import {
  type SessionSortKey,
  sessionSortKeyComparator,
  sessionSortKeyForQuery,
} from "./session-working-set-sort.js";
import { buildLocalSessionPeople } from "./shared-agent-session-people.js";
import { servedSharedSessionStatus } from "./shared-agent-session-status.js";
import {
  buildAggregateFilters,
  buildCountFilters,
  canUseAggregateSessionFilters,
  needsVersionedCompactFilters,
} from "./shared-agent-sessions-aggregate-query.js";
import {
  explicitIdsFromRequest,
  resolveComponentSessionQuery,
  withComponentScope,
} from "./shared-agent-sessions-component-scope.js";
import { LIST_LOAD } from "./shared-agent-sessions-load-shapes.js";
import type {
  GetSharedAgentSessionsOptions,
  WorkingSetOptions,
} from "./shared-agent-sessions-options.js";
import { sessionListPageEcho } from "./shared-agent-sessions-page-echo.js";
import {
  coerceNonEmptyString,
  type SanitizedQuery,
  sanitizeIds,
  sanitizeQuery,
} from "./shared-agent-sessions-query.js";
import {
  addSessionToUsageSummaryFold,
  buildUsageSummary,
  createUsageSummaryFold,
  finishUsageSummaryFold,
  foldUsageAggregate,
} from "./shared-agent-sessions-usage-summary.js";
import { indexSessionsById } from "./synced-agent-session-index.js";

export type { GetSharedAgentSessionsOptions } from "./shared-agent-sessions-options.js";

const LOCAL_COMPUTE_TARGET_ID = "local-desktop";
const LOCAL_DESKTOP_NAME = "Local Desktop";
const DEFAULT_TRANSCRIPT_LOOKUP: TranscriptVerdictLookup = {
  available: true,
  byId: EMPTY_TRANSCRIPT_VERDICTS,
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

  const query = await resolveComponentSessionQuery(
    source,
    sanitizeQuery(request, SESSIONS_SURFACE_DATE_WINDOW_FIELD)
  );
  const execution = await beginSessionListQuery(
    options,
    source,
    request,
    query
  );
  if (execution === ListQueryExecution.Unsupported) {
    // FEA-4304: `scopeUnsatisfiable` = the scoped `userId` was excluded by the
    // Owner facet, so the AND-intersection is empty. Return no rows before any
    // SQL fast path (count/aggregate), which would otherwise ignore the empty
    // set and leak the wider facet's owners under the scoped-user label.
    return withComponentScope(emptySharedAgentSessionsListResponse(), query);
  }

  const statusRootRank =
    query.sortBy === "status" &&
    options.statusOrdering === SessionStatusOrderingName.RootFirst
      ? sessionStatusRootRankOrNull
      : undefined;

  // FEA-4142: the sidebar needs only a count; its query previously hydrated the
  // full corpus every five minutes (FEA-2038). Use one SQL COUNT for expressible
  // predicates, but hydrate for search, local facets, or a substantive gate.
  if (
    execution === ListQueryExecution.Count &&
    source.countSessions &&
    (query.quality === "all" ||
      (await supportsSessionCompactFilter(source, "count")))
  ) {
    const total = await source.countSessions(buildCountFilters(query));
    observeSessionListQueryPopulation(options, total);
    return {
      ...(query.componentSlug ? { componentScope: query.componentSlug } : {}),
      items: [],
      total,
      idleCount: 0,
      viewerScope: "self",
      // ISS-9555: a count-only read IS a read, so it echoes. Omission is the
      // wire signal for "no read happened" (`emptySharedAgentSessionsListResponse`).
      pageInfo: sessionListPageEcho(query),
    };
  }

  const workingSet = await loadWorkingSessions(source, request, query, {
    statusRootRank,
    computeTargetId: options.computeTargetId,
    // The same matcher gates the list and narrowed usage/analytics reads.
    matcher: matchesListQuery,
    // FEA-3450: bucket the hidden-idle rows during the SAME filter pass instead
    // of re-scanning the full hydrated corpus a second time.
    countIdle: true,
  });
  observeSessionListWorkingSet(options, workingSet);

  // PRD-536 E6: resolve the per-row local-vs-cloud disclosure once for the whole
  // page. A row still in the outbox reads `pending`; one proven absent from it
  // reads `synced`; a lane that could not be read at all — a failed lookup, or
  // (ISS-9004) a null target that never keyed one — publishes no disclosure.
  // `pending-outbox-lookup.ts` owns which input is which, and why.
  const pendingOutboxLookup = await loadPendingOutboxIdSet(
    source,
    options.computeTargetId ?? null,
    options.readSessionDeadLetterState
  );
  options.onPendingOutboxAvailability?.(pendingOutboxLookup.available);
  // ISS-4647: the transcript-blob lane, resolved for THIS page only. The outbox
  // covers the metadata lane alone, so without this a session whose metadata was
  // acked while its raw transcript was still queued reported `synced`.
  const transcriptLookup = await loadLocalTranscriptVerdicts(
    options.computeTargetId ?? null,
    options.loadTranscriptBlobStates,
    workingSet.page.map((session) => session.externalSessionId)
  );
  const orgDirectory = options.orgDirectory ?? getOrgDirectorySnapshot();

  return {
    ...(query.componentSlug ? { componentScope: query.componentSlug } : {}),
    items: workingSet.page.map((session) =>
      mapListItem(session, pendingOutboxLookup, transcriptLookup, orgDirectory)
    ),
    total: workingSet.total,
    // FEA-3284: how many idle rows a `substantive` view hides, within the current
    // filter scope. SQLite cursor paging counts the complementary idle cohort;
    // the hydrated fallback folds it during its scan. All-quality shows idle
    // rows already, so nothing is hidden.
    idleCount: workingSet.idleCount,
    viewerScope: "self",
    pageInfo: sessionListPageEcho(query),
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
 * - `cost` = the session's whole-session estimated cost, carried with the
 *   verdict that says whether it was MEASURED (ISS-11226). `sessionLocCost`
 *   resolves it: the session's own authoritative figure
 *   (`sessionAnalytics.estimatedCostUsd`, the same number the cloud persists to
 *   `SessionDetail.estimatedCost`) when it has one, and the `sumTokenUsage`
 *   per-model sum plus its cost-coverage counters when it does not.
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
      sessionLocCost(session, sumTokenUsage(session))
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
      sessionLocCost(session, sumTokenUsage(session))
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

  const query = await resolveComponentSessionQuery(
    source,
    sanitizeQuery(request, SESSIONS_SURFACE_DATE_WINDOW_FIELD)
  );
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    // FEA-4304: empty owner AND-intersection (Owner facet excludes the scoped
    // user) → no usage before the SQL aggregate ignores the empty set.
    return emptySharedAgentSessionsUsageSummary();
  }

  // Prefer grouped SQLite reads for quality and supported facets. Explicit ids,
  // free-text search, and evidence-derived facets still use the bounded fold.
  if (
    source.aggregateUsage &&
    canUseAggregateSessionFilters(request, query) &&
    (!needsVersionedCompactFilters(query) ||
      (await supportsSessionCompactFilter(source, "usage")))
  ) {
    const aggregate = await source.aggregateUsage(buildAggregateFilters(query));
    return withComponentScope(foldUsageAggregate(aggregate), query);
  }

  // FEA-1834: prefer the lightweight usage load (session metadata +
  // tokenUsageByModel only) when the source supports it. Mirrors the
  // non-paginated `loadWorkingSessions` path exactly — same ordered ids, same
  // re-index/rebuild from `orderedIds`, same `matchesQuery` filter, same
  // `buildUsageSummary` fold — but skips the agents/events hydration when the
  // query needs none of their signals. Rebuilding from `orderedIds`
  // (rather than trusting the source's return order) keeps the result identical
  // to the full path even if a source returns DB-natural order or extra rows.
  // Which query shapes are admitted — and why each excluded facet is excluded —
  // is `lightweightUsageLoadFitsQuery`, beside its sibling fast-path predicates.
  if (source.loadUsageSessions && lightweightUsageLoadFitsQuery(query)) {
    // ISS-6895: hydrate the MATCHED id set one SESSION_HYDRATION_WINDOW at a
    // time and fold each window into the accumulator, instead of truncating the
    // id set to that window and folding once.
    //
    // The bound this path needs is real: "lightweight per row" (metadata +
    // tokenUsageByModel, no agents/events) is not "bounded in total", and this
    // fires on the Sessions page's 2 s background page-data poll
    // (`DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS`) — a single unbounded
    // full-corpus hydrate here starved the desktop main process and wedged the
    // renderer (FEA-4286). But bounding it by TRUNCATION (the FEA-4286 fix) made
    // `totalSessions` and every cost card describe only the newest window while
    // the list header — which pages before hydrating and never truncates —
    // reported the whole matched population. Windowing keeps peak residency at
    // exactly the same ceiling and makes the summary count every matched row, so
    // the two reconcile.
    //
    // ISS-5626: an active Repository selection is still scoped PRE-hydration, so
    // the windows walk the MATCHED set rather than a corpus prefix the repo
    // predicate then thins out.
    const orderedIds = await resolveOrderedIds(source, request, {
      componentSessionIds: query.componentSessionIds,
      repositories: query.repositories,
    });
    if (orderedIds.length === 0) {
      // Fold the empty set rather than returning the canned empty summary: the
      // two differ (the fold emits `modelFilterOptions: []`, the canned shape
      // omits it), and a selection resolving to no rows is an ANSWER — it must
      // read identically whichever path answered it. The canned shape stays for
      // the two refusals above, which answer nothing.
      return withComponentScope(buildUsageSummary([]), query);
    }
    const fold = createUsageSummaryFold();
    for (const windowIds of sessionHydrationWindows(orderedIds)) {
      const loaded = await source.loadUsageSessions(windowIds);
      const loadedById = indexSessionsById(loaded);
      // Rebuild from `windowIds` (rather than trusting the source's return
      // order) so the fold is identical to the full path even if a source
      // returns DB-natural order or extra rows.
      for (const id of windowIds) {
        const session = loadedById.get(id);
        if (session && matchesListQuery(session, query)) {
          addSessionToUsageSummaryFold(fold, session);
        }
      }
    }
    return withComponentScope(finishUsageSummaryFold(fold), query);
  }

  const fold = createUsageSummaryFold();
  await streamWorkingSessions(
    source,
    request,
    query,
    { matcher: matchesListQuery },
    (matched) => {
      for (const session of matched) {
        addSessionToUsageSummaryFold(fold, session);
      }
    }
  );
  return withComponentScope(finishUsageSummaryFold(fold), query);
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

  const query = await resolveComponentSessionQuery(
    source,
    sanitizeQuery(request, SESSIONS_SURFACE_DATE_WINDOW_FIELD)
  );
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    // FEA-4304: empty owner AND-intersection (Owner facet excludes the scoped
    // user) → no analytics before the SQL aggregate ignores the empty set.
    return emptySharedAgentSessionsAnalytics();
  }

  // Prefer grouped SQLite reads for quality and supported facets. Explicit ids,
  // free-text search, and evidence-derived facets still use the bounded fold.
  if (
    source.aggregateAnalytics &&
    canUseAggregateSessionFilters(request, query) &&
    (!needsVersionedCompactFilters(query) ||
      (await supportsSessionCompactFilter(source, "analytics")))
  ) {
    const cache = createSessionAttributionResolverCache();
    const aggregate = await source.aggregateAnalytics(
      buildAggregateFilters(query),
      cache
    );
    return foldAnalyticsAggregate(aggregate);
  }

  const fold = createAnalyticsFold();
  await streamWorkingSessions(
    source,
    request,
    query,
    { matcher: matchesListQuery },
    (matched) => {
      for (const session of matched) {
        addSessionToAnalyticsFold(fold, session);
      }
    }
  );
  return finishAnalyticsFold(fold);
}

async function loadWorkingSessions(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery,
  options: WorkingSetOptions
): Promise<{
  page: SyncedAgentSession[];
  total: number;
  // FEA-3450: idle rows hidden by the substantive default, within the current
  // filter scope. The quality-aware cursor path counts that complement in SQL;
  // the hydrated fallback folds it when `countIdle` is set.
  idleCount: number;
  /** Rows actually inspected in memory; omitted for SQL paths. */
  scannedCount?: number;
}> {
  const cursorPage = await loadCursorPageBeforeHydration(
    source,
    request,
    query
  );
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
    // its NEW status — a row now storing `inactive` in an Active list. Dropping
    // it makes the page shorter than `limit`; keeping it would make the row lie,
    // which is the worse of the two. `total` stays the selection-time count: it
    // is a snapshot of the cohort, and recounting it here would need a second
    // round trip that could itself be stale.
    const page = hydrated.filter((session) =>
      stillMatchesCursorSelection(session, query)
    );
    return {
      page,
      total: cursorPage.total,
      idleCount: cursorPage.idleCount ?? 0,
    };
  }

  // The cursor-only paging branch slices `orderedIds` and hydrates a single page
  // — it never holds the working set in memory, so it reads `total` straight off
  // the resolved id list.
  if (canPageBeforeLoading(source, request, query)) {
    const orderedIds = await resolveOrderedIds(source, request, {
      componentSessionIds: query.componentSessionIds,
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
      return { page: [], total: 0, idleCount: 0 };
    }
    const pageIds = orderedIds.slice(query.offset, query.offset + query.limit);
    const page = await loadOrderedPage(source, pageIds);
    return {
      page,
      total: orderedIds.length,
      idleCount: 0,
    };
  }
  // ISS-4535 (PR #3996, @whitlockk): an active Repository selection is resolved from
  // the pre-hydration `(cwd, repo_full_name)` identity the facet options use, so
  // a repo represented only by older sessions still resolves instead of
  // returning zero rows.
  //
  // ISS-4558: a repo-filtered LIST without hydrated-only predicates pages
  // above, so its `total` matches the facet. That holds for the shape
  // the Sessions view actually sends: whitlockk's #4751 review caught that the first
  // cut admitted only an unwindowed, unsorted read, while `SessionsView` sends a
  // 90d window and `sortBy: lastActivity` from its first render — so every real
  // repo-filtered read still landed here and the 5,050-vs-5,000 contradiction
  // survived the fix. The window and sort are pushed into the repository-scoped
  // SQL instead (`RepositoryScopedSessionIdsOptions`).
  //
  // What still lands here is a filter combination requiring hydrated evidence
  // (cost bucket, a non-cursor sort column…), or an
  // older DB host without the versioned compact-filter capability.
  //
  // ISS-6895: the matched set is walked one hydration window at a time. `total`
  // counts every matched row rather than a truncated prefix, and the page is
  // decided in an `{ id, sort key }` buffer — never a buffer of hydrated rows —
  // so a list past the old 5,000 ceiling neither reports a short total nor
  // returns an empty page, and no hydrated session outlives its window.
  const pageWindow = createOrderedPageIdWindow<SessionSortKey | null>(
    query.offset + query.limit,
    sessionSortKeyComparator(query)
  );
  const { matchedCount, idleCount, scannedCount } = await streamWorkingSessions(
    source,
    request,
    query,
    options,
    (matched) =>
      pageWindow.merge(
        matched.map((session) => ({
          id: session.externalSessionId,
          key: sessionSortKeyForQuery(
            session,
            query,
            options.statusRootRank,
            options.computeTargetId ?? null
          ),
        }))
      )
  );
  const pageIds = pageWindow.pageIds(query.offset, query.limit);
  if (pageIds.length === 0) {
    return {
      page: [],
      total: matchedCount,
      idleCount,
      scannedCount,
    };
  }
  // Selection (the windowed scan) and this page hydration are SEPARATE db-host
  // invokes, so re-apply the read's own matcher for the same reason the cursor
  // page above does: a row whose status transitioned in between must not be
  // rendered inside a facet it no longer belongs to. `total` stays the
  // selection-time count — a snapshot of the cohort, not a recount.
  const matcher = options.matcher ?? matchesListQuery;
  const hydrated = await loadOrderedPage(source, pageIds);
  return {
    page: hydrated.filter((session) => matcher(session, query)),
    total: matchedCount,
    idleCount,
    scannedCount,
  };
}

/**
 * ISS-6895: hydrate the FULL matched id set one {@link SESSION_HYDRATION_WINDOW}
 * at a time, handing each window's matched rows to `onMatched` and releasing the
 * window before the next one loads.
 *
 * This is the shared engine behind every read that cannot push its filter into
 * SQL — the list fallback, the usage fold, the analytics fold — so those three
 * cannot drift in which rows they consider. It replaces "truncate the matched
 * ids to a ceiling, then hydrate once": the ceiling still bounds how many
 * sessions are resident at a time (the FEA-2038 / FEA-4286 protection), but it
 * no longer decides how many are COUNTED, which is what made the summary
 * disagree with the list above 5,000 matches.
 */
async function streamWorkingSessions(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery,
  options: WorkingSetOptions,
  onMatched: (matched: SyncedAgentSession[]) => void
): Promise<{
  matchedCount: number;
  idleCount: number;
  scannedCount: number;
}> {
  const orderedIds = await resolveOrderedIds(source, request, {
    componentSessionIds: query.componentSessionIds,
    repositories: query.repositories,
  });
  let matchedCount = 0;
  let idleCount = 0;
  let scannedCount = 0;
  if (orderedIds.length === 0) {
    return { matchedCount, idleCount, scannedCount };
  }
  for (const windowIds of sessionHydrationWindows(orderedIds)) {
    // ISS-6895: one cache PER WINDOW. Keying by cwd is not a bound — a corpus of
    // N sessions can hold N distinct cwds (a worktree per task), so a
    // read-lifetime cache accumulates entries from externally derived input with
    // no cap, growing with the population the windowing exists to stop
    // retaining. Per-window puts peak residency back at the former 5,000-row
    // ceiling; the only cost is re-resolving a boundary-spanning cwd per window.
    const cache = createSessionAttributionResolverCache();
    // FEA-2038: this hydration feeds only the event-data-free folds
    // (list/analytics/usage), so omit `event.data` to keep peak memory flat.
    const loaded = await source.loadSyncedSessions(windowIds, cache, LIST_LOAD);
    const loadedById = indexSessionsById(loaded);
    const ordered = windowIds.flatMap((id) => {
      const session = loadedById.get(id);
      return session ? [session] : [];
    });
    scannedCount += ordered.length;
    const partition = partitionWorkingSet(ordered, query, options);
    idleCount += partition.idleCount;
    matchedCount += partition.matched.length;
    onMatched(partition.matched);
  }
  return { matchedCount, idleCount, scannedCount };
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
  const matcher = options.matcher ?? matchesListQuery;
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
 * rows, `all` shows both). Narrowed usage/analytics must use this hydrated
 * matcher too when their remaining filters require the hydrated fallback.
 */
function matchesListQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  if (!matchesQuery(session, query)) {
    return false;
  }
  if (query.quality === "all") {
    return true;
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

/**
 * Resolve the ordered ids of every session matching this read, in
 * `updated_at DESC, id DESC` order.
 *
 * ISS-6895: this list is no longer truncated. It used to be capped at the
 * hydration ceiling on every path that hydrated in one shot, which meant the
 * ceiling silently decided how many rows a usage/analytics total described — the
 * summary reported the newest 5,000 while the list, which resolves the same ids
 * uncapped, reported the whole matched population. The ceiling now bounds how
 * many sessions are RESIDENT AT ONCE (`sessionHydrationWindows`), so it can
 * bound memory without shortening an answer.
 */
async function resolveOrderedIds(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  options: ResolveOrderedIdsOptions = {}
): Promise<string[]> {
  const explicitIds = explicitIdsFromRequest(request);
  if (options.componentSessionIds !== undefined) {
    return explicitIds === null
      ? [...options.componentSessionIds]
      : explicitIds.filter((id) => options.componentSessionIds?.includes(id));
  }
  if (explicitIds !== null) {
    return explicitIds;
  }
  // ISS-4535 (@whitlockk): when a Repository filter is active, resolve the matching
  // ids PRE-hydration from `(cwd, repo_full_name)` — the same persisted-aware
  // identity the facet options use — so the predicate runs against every
  // session's metadata instead of a corpus prefix the predicate then thins out.
  const orderedIds =
    options.repositories && options.repositories.length > 0
      ? await resolveRepositoryScopedSessionIds(
          source,
          options.repositories,
          createSessionAttributionResolverCache(),
          { ...options.repositoryScope }
        )
      : (await source.listAllSessionCursorRows()).map((row) => row.id);
  return sanitizeIds(orderedIds, { limit: null });
}

type ResolveOrderedIdsOptions = {
  componentSessionIds?: readonly string[];
  /**
   * ISS-4535: when set, the active Repository facet selection. The ordered id
   * list is resolved from the pre-hydration repository-scoped source method so
   * the predicate runs against the whole corpus's metadata.
   */
  repositories?: readonly string[];
  /**
   * ISS-4558: the date window and sort to push into that repository-scoped read.
   * Set ONLY by the pre-hydration paging branch, which runs no in-memory matcher
   * and so needs the ids to come back already windowed and already ordered. The
   * hydrating fallback omits it and keeps applying both from the hydrated rows.
   */
  repositoryScope?: RepositoryScopedSessionIdsOptions;
};

function matchesQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  if (
    query.componentSessionIds !== undefined &&
    !query.componentSessionIds.includes(session.externalSessionId)
  ) {
    return false;
  }
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
  if (query.search && !matchesLocalSessionSearch(session, query.search)) {
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

export function mapListItem(
  session: SyncedAgentSession,
  pendingOutbox: PendingOutboxLookup = DEFAULT_PENDING_OUTBOX_LOOKUP,
  transcripts: TranscriptVerdictLookup = DEFAULT_TRANSCRIPT_LOOKUP,
  orgDirectory: ReadonlyMap<string, BasicUser> = getOrgDirectorySnapshot()
): CanonicalAgentSessionListItem {
  const totals = sumTokenUsage(session);
  const attribution = session.attribution ?? null;
  const updatedAt = parseSessionDate(session.updatedAt);
  // Serve the canonical three-value display status; the raw lifecycle evidence
  // remains separate, and the Status facet/sort still read that raw value.
  const status = servedSharedSessionStatus(session);
  const prs = localSessionPullRequests(session);
  const primaryModel = session.model ?? null;
  const toolUseCount = sessionToolUseCount(session);

  return {
    ...buildLocalSessionIdentity(
      session,
      attribution,
      status,
      primaryModel,
      prs
    ),
    ...buildLocalSessionTraceFields(session, totals, prs, toolUseCount),
    ...buildLocalSessionPeople(session.userId, orgDirectory),
    ...buildLocalSessionTimingAndUsage(
      session,
      totals,
      updatedAt,
      toolUseCount
    ),
    ...buildLocalSessionRelations(attribution, updatedAt),
    // PLN-1034: genuine activity, floored at the start for event-less sessions.
    // ISS-6270: through the SHARED anchor, so the main-process mirror of this
    // row's displayed status folds against the instant actually served here.
    lastActivityAt: servedSessionActivityAt(session),
    // PRD-536 E6 + ISS-4647: per-row local-vs-cloud disclosure across BOTH cloud
    // lanes. The outbox is the metadata lane (enqueued, not yet server-acked);
    // the transcript verdict is the raw-blob lane. Either one being behind makes
    // the cloud copy behind. A lane left at its never-consulted default (both on
    // the by-id path, the outbox on the detail path) reads `synced` — the
    // honest default when that lane was not consulted. #4150: a
    // lane whose lookup FAILED (`available: false`) is passed through as unknown
    // and yields NO disclosure, so a read that never completed cannot masquerade
    // as proof the row is synced.
    ...buildLocalCloudSyncDisclosure(
      resolveOutboxDisclosureInput(pendingOutbox, session.externalSessionId),
      transcripts.available
        ? {
            available: true,
            verdict: transcripts.byId.get(session.externalSessionId),
          }
        : { available: false }
    ),
  };
}

function buildLocalSessionTraceFields(
  session: SyncedAgentSession,
  totals: SessionTotals,
  prs: NonNullable<SyncedAgentSession["prs"]>,
  toolUseCount: number
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
    // ISS-9964 / ISS-9980 (RULED 2026-09-11): ONE derivation, not a desktop copy
    // of it. The retired `sessionLocPerDollarNumeratorLoc` computed a second,
    // desktop-only `max(localDiff, branchDiff)` numerator here; two derivations
    // reconcile only until someone edits one.
    //
    // The shared numerator is lines landed in MERGED authored PRs, and the local
    // `SyncedAgentSession` carries no per-PR LOC at all — neither
    // `mergedAuthoredPrLinesChanged` nor the legacy alias is in the desktop sync
    // contract. The count is therefore NOT KNOWABLE before a cloud sync, which
    // the operator ruled acceptable: "it's fine if it's not available until we
    // connect to cloud". Falling back to the working-tree or branch diff would
    // report a different population under the same label.
    //
    // The unknowable numerator is still DIVIDED by the shared helper rather than
    // short-circuited to a local `null`: this file is an enumerated LOC/$ surface
    // in `no-local-loc-per-dollar-denominator`, and the gate's point is that no
    // per-dollar surface decides the ratio itself.
    kloc: null,
    locPerDollar: locPerDollarFromLines(null, totals.estimatedCost),
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
    activityBuckets: session.activityBuckets ?? [],
    span: session.span ?? null,
    markers: session.markers ?? [],
    throttles: session.throttles ?? [],
    phases: session.phases ?? [],
    phaseIterations: session.phaseIterations ?? {},
    phaseLoopbacks: session.phaseLoopbacks ?? [],
  };
}

function buildLocalSessionRelations(
  attribution: SyncedAgentSession["attribution"] | null,
  updatedAt: Date
): Pick<
  SharedAgentSessionListItem,
  | "baseBranch"
  | "computeTarget"
  | "sourceArtifact"
  | "sourceArtifactId"
  | "sourceLoopId"
> {
  return {
    baseBranch: attribution?.baseBranch ?? null,
    sourceArtifactId: attribution?.sourceArtifactId ?? null,
    sourceArtifact: null,
    sourceLoopId: null,
    computeTarget: {
      id: LOCAL_COMPUTE_TARGET_ID,
      machineName: resolveDesktopMachineName() || LOCAL_DESKTOP_NAME,
      isOnline: true,
      lastSeenAt: updatedAt,
      // FEA-3479 (PRD-536 G1): per-target cloud sync freshness is a cloud-only
      // concept; the local SQLite producer has no such timestamp, so null.
      lastAgentSessionSyncAt: null,
    },
  };
}

// Write-derived branch only — no baseBranch fallback.
function countMergedPullRequests(
  prs: NonNullable<SyncedAgentSession["prs"]>
): number {
  return prs.filter(
    (pr) => pr.status.toLowerCase() === SessionPrLifecycleStatus.Merged
  ).length;
}
