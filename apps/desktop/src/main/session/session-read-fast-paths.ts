import { isExhaustiveCostFilter } from "@repo/api/src/agent-session-filters";
import type { SharedAgentSessionsListRequest } from "../../shared/shared-agent-sessions-contract.js";
import {
  type RepositoryScopedSessionIdsOptions,
  SessionListCursorSortKey,
} from "../agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { isDisplayedStatusParityEnabled } from "./displayed-status-parity-gate.js";
import { canPageRepositoryFilterBeforeHydration } from "./session-repository-facet.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";

/**
 * Fast-path admission predicates for the shared-agent-sessions reads: which
 * query shapes may skip the capped full-corpus hydration fallback.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * file) by ISS-4558, which changed `canPageBeforeLoading` to admit a Repository
 * selection. These are pure predicates over the sanitized query plus the
 * source's capabilities — no hydration, no I/O — so they test standalone.
 */

/**
 * True when none of the in-memory-only facet filters (harness/model multi-select
 * and autonomy-tier / cost-bucket thresholds) are active. These are evaluated by
 * `matchesQuery`, so any fast path that bypasses it must fall back when one is
 * set — otherwise the filter would be silently ignored.
 */
export function hasNoLocalFacetFilters(query: SanitizedQuery): boolean {
  return (
    query.harnesses.length === 0 &&
    query.models.length === 0 &&
    query.autonomyTiers.length === 0 &&
    // shafty thread (ISS-4481): an EXHAUSTIVE cost selection (every numeric
    // bucket AND Unknown) excludes no row, so it is a no-op — treat it as "no
    // cost facet" so the cheap unbounded cursor page is used instead of the
    // 5,000-capped fallback that would drop older sessions for a filter that
    // filters nothing. `matchesLocalCostBucketFilter` is likewise skipped for it.
    (query.costBuckets.length === 0 ||
      isExhaustiveCostFilter(query.costBuckets)) &&
    query.changePresence.length === 0 &&
    query.prAssociation.length === 0
  );
}

/**
 * True when the sessions LIST read may be served by the source's SQL cursor
 * page (`listSessionCursorPage`) — the window, search, sort, and (goal stage 1)
 * Status facet all render into that page's SQL, so only the visible page is
 * hydrated. A Status selection no longer forces the hydration fallback:
 * `loadCursorPageBeforeHydration` passes it through, and the sqlite page SQL
 * renders it via `buildUsageStatusPredicate` — the exact twin of the hydrated
 * `matchesStatusFilter` (the same equivalence the FEA-4142 count-only fast
 * path already relies on), so the paged rows and total partition the cohort
 * identically to the fallback they replace. Moved here from
 * `shared-agent-sessions-api.ts` (shrink-only grandfathered) beside its sibling
 * admission predicates.
 *
 * EXCEPT while the displayed-status parity gate is ON — see
 * {@link statusSelectionIsSqlExpressible}.
 */
export function canUseListCursorPage(
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): boolean {
  return (
    !Object.hasOwn(request, "ids") &&
    query.harness === null &&
    statusSelectionIsSqlExpressible(query) &&
    query.userId === null &&
    query.userIds.length === 0 &&
    query.repositories.length === 0 &&
    // FEA-3009: the completion bound is in-memory only (the cursor page has no
    // endedAt predicate); fall back to the matcher when it's set.
    query.completedAfter === null &&
    hasNoLocalFacetFilters(query) &&
    // FEA-3284: the substantive default is not SQL-expressible (see
    // canPageBeforeLoading); fall back to the in-memory matcher when it's active.
    query.quality === "all" &&
    listCursorSortFromQuery(query) !== null
  );
}

/**
 * Goal stage 1b: the `{ sortBy, sortDir }` this list read should page by, or
 * `null` when its sort is one only the hydrated `sortSyncedSessions` can honor.
 *
 * The three cases, and why the third is not a behavior change:
 *
 * - a real cursor column (`lastActivity` / `started`) pages by it in the read's
 *   own direction, exactly as before;
 * - an UNSORTED read (`sortBy` absent — what `agentSessionsApi.pageData({quality:
 *   "all"})` and every caller that omits a sort sends) pages by
 *   {@link SessionListCursorSortKey.Updated} DESC. `sortSyncedSessions` returns
 *   its input untouched when `sortBy` is unset, so the rows such a read was
 *   already being served are `listAllSessionCursorRows`' own
 *   `updated_at DESC, id DESC` sequence — the identical ordering this key pages
 *   by. `sortDir` is deliberately NOT read here: the hydrated path ignores it
 *   too when there is no sort column, so honoring it would be the change;
 * - any other `sortBy` (a table column with no cursor equivalent — cost, owner,
 *   duration…) returns `null` and keeps the hydrated fallback.
 *
 * Before this, the unsorted read failed the cursor-page admission on its sort
 * alone and fell to the capped full-corpus hydration — measured at +447 MB peak
 * JS heap for ONE call against a 2.1 GB real snapshot (2,962 sessions), which is
 * the allocation goal stage 1 exists to remove.
 */
export function listCursorSortFromQuery(
  query: SanitizedQuery
): { sortBy: SessionListCursorSortKey; sortDir: "asc" | "desc" } | null {
  const cursorSort = cursorSortKeyFromQuery(query);
  if (cursorSort) {
    return { sortBy: cursorSort, sortDir: query.sortDir };
  }
  if (query.sortBy === null) {
    return { sortBy: SessionListCursorSortKey.Updated, sortDir: "desc" };
  }
  return null;
}

/**
 * True when the read's whole predicate is resolvable BEFORE hydration, so the
 * caller can slice one page out of the ordered id list instead of hydrating a
 * capped working set. This branch runs NO in-memory matcher, so every filter it
 * admits must already be applied by the id resolution.
 */
export function canPageBeforeLoading(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): boolean {
  return (
    !Object.hasOwn(request, "ids") &&
    // ISS-4558 (wongk, PR #4751): the date window and sort the REAL Sessions
    // request carries. Rejecting both outright sent every production
    // repo-filtered read back to the capped fallback, which is the contradiction
    // this ticket exists to remove — see `canPageWindowAndSortBeforeHydration`.
    canPageWindowAndSortBeforeHydration(source, query) &&
    // FEA-3009: the `endedAt >= completedAfter` completion bound is evaluated by
    // `matchesQuery` in memory (the cursor-page SQL carries only the
    // `startDate`/`endDate` window, never a completion timestamp), so a
    // completedAfter filter must fall through to the full-hydration path where
    // `matchesQuery` applies it.
    query.completedAfter === null &&
    query.harness === null &&
    query.status === null &&
    query.statuses.length === 0 &&
    query.userId === null &&
    query.userIds.length === 0 &&
    // ISS-4558: a Repository selection resolves PRE-hydration, so it pages here
    // (uncapped `total`, one page hydrated) instead of falling to the capped
    // fallback, which advertised a facet count the table could not reach. The
    // rule and its source gate live in `canPageRepositoryFilterBeforeHydration`.
    canPageRepositoryFilterBeforeHydration(source, query.repositories) &&
    hasNoLocalFacetFilters(query) &&
    // FEA-3284/FEA-4145: both the `substantive` and `idle` segments derive from
    // turn/token/tool signals the `sessions` table does not store as columns, so
    // neither can be pushed into the cursor-page SQL. Only `all` (no quality
    // narrowing) may take the fast path; a narrowed segment falls back to the
    // full-hydration path where `matchesListQuery` applies it — mirroring how the
    // change-presence/cost-bucket facets are handled.
    query.quality === "all" &&
    query.search === null
  );
}

/**
 * ISS-4558 (wongk, PR #4751): may this read's date window and sort be resolved
 * PRE-hydration, or must they fall to the in-memory matcher?
 *
 * The branch this gates runs no matcher at all, so a window or sort it admits
 * without a resolver that applies them is a filter silently dropped on screen —
 * which is why the two were simply rejected before. But rejecting them outright
 * meant NO production Sessions read ever reached the branch: `SessionsView`
 * sends a bounded window (90d default) and `sortBy: lastActivity` from its first
 * render, so a repository selection went straight back to the 5,000-capped
 * fallback and kept advertising a facet count the table could not reach.
 *
 * The narrow truth is that exactly ONE pre-hydration resolver pushes a window
 * and a sort into its own SQL: the repository-scoped read
 * (`listRepositoryScopedSessionIds`, given `RepositoryScopedSessionIdsOptions`).
 * The unfiltered path resolves ids from `listAllSessionCursorRows`, which is
 * whole-corpus and fixed-order, so a window or sort there still must fall
 * through — those requests are already served by `loadCursorPageBeforeHydration`
 * upstream, which has its own SQL window and sort.
 */
export function canPageWindowAndSortBeforeHydration(
  source: AgentSessionSyncSource,
  query: SanitizedQuery
): boolean {
  const windowed = query.startDate !== null || query.endDate !== null;
  const sorted = query.sortBy !== null;
  if (!(windowed || sorted)) {
    return true;
  }
  if (
    query.repositories.length === 0 ||
    source.listRepositoryScopedSessionIds === undefined
  ) {
    return false;
  }
  // A sort the cursor SQL has no column for (anything but last-activity /
  // started) cannot be pushed down, so it keeps the hydrated path where
  // `sortWorkingSet` applies it.
  return !sorted || cursorSortKeyFromQuery(query) !== null;
}

/**
 * ISS-4558: the sanitized `sortBy` narrowed to a key the cursor SQL can order
 * by, or `null` when the read carries no sort (or one only the hydrated
 * `sortWorkingSet` can honor). `SanitizedQuery.sortBy` is a bare `string` — this
 * is the one place that string is validated against the cursor's key set.
 */
export function cursorSortKeyFromQuery(
  query: SanitizedQuery
): SessionListCursorSortKey | null {
  if (
    query.sortBy === SessionListCursorSortKey.LastActivity ||
    query.sortBy === SessionListCursorSortKey.Started
  ) {
    return query.sortBy;
  }
  return null;
}

/**
 * ISS-4558: the window/sort a repository-scoped id resolution should push into
 * its SQL for this read. Built ONLY for a read
 * `canPageWindowAndSortBeforeHydration` has admitted; the capped fallback passes
 * nothing and keeps applying both from the hydrated rows.
 */
export function repositoryScopeOptionsFromQuery(
  query: SanitizedQuery
): RepositoryScopedSessionIdsOptions {
  const sortBy = cursorSortKeyFromQuery(query);
  return {
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    ...(sortBy ? { sortBy, sortDir: query.sortDir } : {}),
  };
}

/**
 * Whether this read's Status selection (if any) can be pushed into the cursor
 * page's SQL and still select the SAME rows the hydrated matcher would.
 *
 * Goal stage 1 pushed the Status facet into `buildUsageStatusPredicate`, the SQL
 * twin of the hydrated `matchesStatusFilter`. The two are twins only when they
 * resolve the `sessions-displayed-status-parity` gate the same way — and they
 * CANNOT while it is on, because they run in different processes:
 *
 *   - the hydrated matcher and `mapListItem` run in Electron MAIN, where the
 *     composition root registers the store-backed resolver
 *     (`setDisplayedStatusParityResolver`) and the IPC read boundary pins one
 *     decision per read (`withDisplayedStatusParityScope`);
 *   - `listSessionCursorPage` is a `syncSource.*` op FORWARDED to the DB-host
 *     CHILD (FEA-2038), which has no composition root and never registers a
 *     resolver — so `isDisplayedStatusParityEnabled()` there reads the
 *     fail-closed default `false`, whatever the user's Labs flag says.
 *
 * Concretely, with the gate ON, an ENDED row still carrying `awaitingInputSince`
 * displays as Active (parity: a terminal row is not "waiting"), so the hydrated
 * fallback lists it under Active — but the child builds the predicate with
 * parity OFF, where the Active branch excludes EVERY awaiting-input row
 * regardless of `ended_at`, and the row silently vanishes from the page. The row
 * count above the table would still claim it.
 *
 * So while the gate is on, a status-filtered list read keeps taking the hydrated
 * fallback, which is exactly today's behavior. The gate is read HERE, in main,
 * where the answer is the real one. Passing the pinned decision down with the
 * cursor request is the better end state, but it has to move the usage/KPI
 * aggregate and the FEA-4142 count read in the same step — those are `prisma`
 * reads in the same child and already resolve the gate to `false` today — or the
 * list and the cards above it would start disagreeing in the other direction.
 * Tracked as stage-2 work, not smuggled in here.
 */
function statusSelectionIsSqlExpressible(query: SanitizedQuery): boolean {
  const hasStatusSelection = query.statuses.length > 0 || query.status !== null;
  return !(hasStatusSelection && isDisplayedStatusParityEnabled());
}

/**
 * The Status facet this read actually selects: the multi-select `statuses` set,
 * else the single back-compat `status` as a one-element set — the precedence
 * `matchesQuery` applies. Empty means "no Status selection".
 *
 * One helper because TWO call sites must agree on it byte-for-byte: the cursor
 * request that pushes the facet into SQL, and the post-hydration recheck that
 * re-applies it to the rows that came back. Resolving it twice is how the
 * selection and the recheck would drift apart.
 */
export function selectedStatusesFromQuery(
  query: SanitizedQuery
): readonly string[] {
  if (query.statuses.length > 0) {
    return query.statuses;
  }
  return query.status ? [query.status] : [];
}

/**
 * The source's SQL cursor page for this list read, or `null` when the read is
 * not admissible to it and must take the hydrated fallback.
 *
 * Moved here from `shared-agent-sessions-api.ts` (shrink-only grandfathered) by
 * goal stage 1b: it is the ONE consumer of every predicate in this file —
 * {@link canUseListCursorPage}, {@link listCursorSortFromQuery},
 * {@link selectedStatusesFromQuery} — and building the request a file away from
 * the rules that admit it is how a facet comes to be admitted and then silently
 * not sent.
 *
 * Goal stage 1: the Status facet rides this page; before it, ANY status
 * selection fell to the capped full-corpus hydration on every list poll. Goal
 * stage 1b: so does an UNSORTED read, via the natural `updated_at` order it was
 * already served in. The sort comes from {@link listCursorSortFromQuery}, never
 * from `query.sortBy`/`query.sortDir` directly — an absent sort has no cursor
 * key of its own to name.
 */
export function loadCursorPageBeforeHydration(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): SessionListCursorPageResult | Promise<SessionListCursorPageResult> | null {
  const cursorSort = listCursorSortFromQuery(query);
  if (
    !(
      source.listSessionCursorPage &&
      cursorSort &&
      canUseListCursorPage(request, query)
    )
  ) {
    return null;
  }
  const statuses = selectedStatusesFromQuery(query);
  return source.listSessionCursorPage({
    limit: query.limit,
    offset: query.offset,
    sortBy: cursorSort.sortBy,
    sortDir: cursorSort.sortDir,
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
  });
}

/** The cursor page's shape as this module's consumers read it — ids plus the
 * selection-time total. Moved here with {@link loadCursorPageBeforeHydration}. */
type SessionListCursorPageResult = {
  rows: { id: string }[];
  total: number;
};

/**
 * FEA-1834 / ISS-5626: may the usage read take the source's LIGHTWEIGHT load
 * (`loadUsageSessions` — session metadata + `tokenUsageByModel`, no
 * agents/events/links) instead of the fully-hydrated `loadWorkingSessions`
 * fallback?
 *
 * A facet whose predicate reads a field those rows do NOT carry has to fall
 * through, or the usage cards would filter differently from the list they
 * summarize: free-text search (the lightweight rows carry no `baseBranch`), the
 * autonomy tier (`session.autonomy` derives from the session-trace
 * events/analytics presentation), and change-presence / PR-association (no
 * git/branch diff-stat rows, no PR rows). Harness, model and cost stay here —
 * the lightweight rows carry those values. (The cost facet's numeric-vs-Unknown
 * boundary also consults `localSubstantiveCounts`, which reads the `events`
 * those rows omit. That pre-dates ISS-5626 and is untouched by it; it belongs
 * with the exclusions above the day someone measures it.)
 *
 * ISS-5626: the REPOSITORY facet was excluded for that same missing-field
 * reason and no longer is. ISS-5271 taught the lightweight load to resolve each
 * row's `repositoryFullName` stored-first — the SAME identity
 * `sessionMatchesRepositoryFilter` reads — so the predicate is honest on these
 * rows, while `resolveOrderedIds` still scopes the id set pre-hydration exactly
 * as the fallback does. Keeping the exclusion after that made every
 * repo-filtered Sessions view pay the FULL `loadSyncedSessions` hydrate
 * (agents, events, artifact links, PRs, LOC — for up to
 * `MAX_WORKING_SET_SESSIONS` rows) on each of its 2-second page-data polls, on
 * the heap-capped db-host worker.
 *
 * The source's capability (`source.loadUsageSessions`) is deliberately NOT
 * tested here: the caller tests it so TypeScript narrows the optional method at
 * the call site.
 */
export function lightweightUsageLoadFitsQuery(query: SanitizedQuery): boolean {
  return (
    query.search === null &&
    query.autonomyTiers.length === 0 &&
    query.changePresence.length === 0 &&
    query.prAssociation.length === 0
  );
}
