"use client";
import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { OnboardingAnalyticsPageName } from "@repo/api/src/types/onboarding-analytics";
import {
  resolveCappedTotalPages,
  resolveMaxPageIndex,
} from "@repo/api/src/utils/math";
import { resolveSessionsNonWindowFiltersActive } from "@repo/app/agents/components/sessions/sessions-list-surface-model";
import { SessionsRecoveryAction } from "@repo/app/agents/components/sessions/sessions-recovery-action";
import {
  useAgentSessions,
  useAgentSessionUsage,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { useHasConnectedAgent } from "@repo/app/agents/hooks/use-has-connected-agent";
import { useSessionsCustomDateWindow } from "@repo/app/agents/hooks/use-sessions-custom-date-window";
import { useSessionsReplacePage } from "@repo/app/agents/hooks/use-sessions-list-url-writers";
import { useSessionsOutsideWindow } from "@repo/app/agents/hooks/use-sessions-outside-window";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import { resolveSessionDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import {
  parseSessionFacetFilterParams,
  type SessionFacetFilters,
  writeSessionFacetFilterParams,
} from "@repo/app/agents/lib/session-filter-adapter";
import {
  clampSessionsPageIndex,
  writeSessionsPageParam,
} from "@repo/app/agents/lib/session-pagination";
import type { SessionSortDir } from "@repo/app/agents/lib/session-sort-group";
import {
  type SessionSortKey,
  toSessionSortRuleParams,
} from "@repo/app/agents/lib/session-sort-group";
import {
  SESSIONS_SEARCH_PARAM,
  SESSIONS_SELECTED_USER_PARAM,
} from "@repo/app/agents/lib/session-url-scope-params";
import { buildSessionSummaryUsageFilters } from "@repo/app/agents/lib/session-usage-filters";
import {
  resolveSessionsActiveRefetchInterval,
  SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS,
} from "@repo/app/agents/lib/sessions-active-refetch";
import { resolveSessionsListReadModel } from "@repo/app/agents/lib/sessions-list-read-state";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { useReplaceListParams } from "@repo/app/shared/hooks/use-replace-list-params";
import { useSharedTimezoneMode } from "@repo/app/shared/hooks/use-shared-timezone-mode";
import { useTablePageSizeOptions } from "@repo/app/shared/hooks/use-table-page-size-options";
import { initialFacetParamsSource } from "@repo/app/shared/lib/facet-filter-params";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
  SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY,
  SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { getStableDateWindowForRange } from "@repo/app/shared/lib/format-utils";
import { isSummaryMetricsLoading } from "@repo/app/shared/lib/summary-metrics-loading";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { gateRestoredRead } from "@repo/app/shared/query/gate-restored-read";
import { useQueryFreshnessGroup } from "@repo/app/shared/query/use-query-freshness-group";
import { Button } from "@repo/design-system/components/ui/button";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  useSessionsEffectiveDateRange,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  useSessionsUrlPageIndex,
} from "@/app/(authenticated)/sessions-route-state";
import { useOrgSlug } from "@/hooks/use-org-slug";
import {
  applyProjectFacetGate,
  readSessionsScopeUserId,
  resolveSessionsReadReady,
  resolveSessionsScopeState,
} from "./sessions-page-scope";
import { useSessionsGitHubConnectGate } from "./sessions-summary-cards-with-github-connect";
import type { SessionsSurfaceInput } from "./sessions-surface-input";
import { SessionsV2Page } from "./sessions-v2-page";
import { useSessionsListUrlWriters } from "./use-sessions-list-url-writers";

// Module-local e2e anchors. A Next.js App Router page module may only export the
// reserved page exports (`default`, `metadata`, …), so these stay non-exported;
// the specs that read them redeclare the same literals. ISS-4673 turned the
// scroll container from a `<main>` into a `<div>` (the shell's `SidebarInset`
// owns the page's single `<main>`), so `getByRole("main")` no longer resolves to
// it — `e2e/visual-regression.spec.ts` screenshots the scroll container by test
// id, and the list body is the sessions-list-back / cost-unknown anchor.

export default function SessionsPage() {
  // ISS-5574: name the tab for this surface. Off by default behind the shared
  // web+desktop flag; the desktop renderer titles the same route from the same key.
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? "Sessions" : null);
  usePageViewedEvent(OnboardingAnalyticsPageName.Sessions);
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const routePath = usePath();
  // Read ONCE, and normalised at the read — see `readSessionsScopeUserId` for
  // why a valueless `?userId=` must not survive this line.
  const selectedUserId = readSessionsScopeUserId(
    searchParams.get(SESSIONS_SELECTED_USER_PARAM)
  );
  // PRD-721: the toolbar's free-text term, owned by the `?search=` param the
  // desktop shell already reads. Trimmed at the read, as the desktop does.
  // ISS-13035: the term exists only under `gridview-adoption`; closed, a
  // `?search=` link narrows nothing, as before the shared toolbar.
  const searchEnabled = useFeatureFlagEnabled(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const search = searchEnabled
    ? (searchParams.get(SESSIONS_SEARCH_PARAM) ?? "").trim()
    : "";
  // FEA-3560: seeded from the list URL (the facet params are mirrored into the
  // URL on every change below), so navigating into a session detail and back —
  // or reloading / opening a shared link — restores the active facet filters
  // instead of showing `?page=N` of the unfiltered set.
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(() =>
    // `initialFacetParamsSource` falls back to the browser URL when the App
    // Router snapshot is still reconciling (empty) on a reload/deep link —
    // mirrors `readSessionsPageIndex`'s page-param fallback, which ISS-8187
    // scopes to this route the same way — so a sibling list's `?owner=`/`?page=`
    // still in the address bar cannot seed Sessions mid-transition.
    parseSessionFacetFilterParams(
      initialFacetParamsSource(searchParams, routePath)
    )
  );
  const projectFacetEnabled = useFeatureFlagEnabled(
    SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY
  );
  // ISS-7422: the same gate the summary strip reads for its honest-loading
  // treatment, resolved here because the suppression decision needs the READ
  // state, which only this host has.
  const honestLoadingEnabled = useFeatureFlagEnabled(
    SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  const activeRowRefetchEnabled = useFeatureFlagEnabled(
    SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY
  );
  // FEA-4210: the same resolver the session-detail linked-artifacts row uses, so
  // a `FEA-654` chip in the list and the identical chip on the detail page cannot
  // route two different ways. Null (an unrouteable or slug-less artifact) renders
  // an inert chip, never a dead link.
  //
  // `useCallback` on the stable `orgSlug` rather than an inline literal: the
  // shared adapter derives every row's chips in a `useMemo` keyed on this
  // reference, and a fresh closure per render would re-derive the whole page's
  // chips on every unrelated `SessionsPage` state change (sort, group, date
  // range, refetch poll) — defeating the memo its sibling `qualifiersByRowId`
  // relies on.
  // ISS-7866: resolved ONCE, for whichever branch renders. The v1 host swaps in
  // the wrapper component; the v2 strip lives inside the shared surface and
  // takes the same two props through its `summaryCards` passthrough.
  const githubConnectGate = useSessionsGitHubConnectGate();
  const buildIssueHref = useCallback(
    (artifact: SessionLinkedArtifact) =>
      withOrgSlug(
        orgSlug,
        getDocumentTypeRoute(artifact.documentType, artifact.slug)
      ),
    [orgSlug]
  );
  // Stable for the same reason as `buildIssueHref`: both surfaces hand this to
  // memoized row adapters, and a fresh closure per render would re-derive every
  // row on any unrelated page state change.
  const getSessionHref = useCallback(
    (item: AgentSessionListItem) => `/${orgSlug}/sessions/${item.id}`,
    [orgSlug]
  );
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  const urlPageIndex = useSessionsUrlPageIndex(searchParams, routePath);
  const { effectivePageIndex, markPageOverride, markPageReset } =
    useSessionsPageReset({
      urlPageIndex,
    });
  const {
    sortKey,
    sortDir,
    secondarySorts,
    setSecondarySorts,
    dateRange: savedDateRange,
    isViewReady,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    pageSize: savedPageSize,
    setPageSize,
    setSort,
    setDateRange,
    toggleColumn,
    resetView,
    groupBy,
    setGroupBy,
    hiddenSummaryCards,
    toggleSummaryCard,
  } = useSessionsViewState("sessions:web");
  // ISS-9692: the rows-per-page now comes from the SAME saved view the sort and
  // columns do, so it survives a reload and a navigate-away-and-back. Resolved
  // against the ladder in force before it reaches the query, so a 500 stored
  // while `table-page-size-ladder` was on becomes the largest legal rung — never
  // a `limit` the API rejects — the moment it goes back off.
  //
  // ISS-9692 (whitlockk review): `isPageSizeReady` is the flag's UNRESOLVED state,
  // which is not the same answer as "off" — it feeds the read gate below so the
  // first fetch already carries the remembered size instead of one 100-row page
  // followed by a refetch at 500.
  const { isReady: isPageSizeReady, pageSize } =
    useTablePageSizeOptions(savedPageSize);
  const maxPageIndex = resolveMaxPageIndex(SESSION_LIST_MAX_OFFSET, pageSize);
  const safePageIndex = Math.min(effectivePageIndex, maxPageIndex);

  // ISS-10301: the Autonomy sort is unconditional now that the v2 surface is the
  // only surface. ISS-8190 made these two values wait on `grid-table-v2` because
  // the v1 controls could not name an Autonomy sort, so sending one would have
  // read against a vocabulary the surface could not change back; with v1 gone
  // there is no second vocabulary and nothing to wait for.
  const querySortKey = sortKey;
  const querySecondarySorts = secondarySorts;

  // The window this view actually reads over: an inbound `?range=` when the URL
  // carries one, otherwise the viewer's saved range (ISS-5355). The hook also
  // owns the RUM range tag (ISS-7250), so the tag cannot come to name a window
  // other than the one in effect.
  const dateRange = useSessionsEffectiveDateRange({
    isViewReady,
    savedRange: savedDateRange,
    searchParams,
  });

  // ISS-5355 (ISS-4779 closed-by-default): with the Project facet flag off the
  // Project dimension does not exist on this surface, so an inbound `project=`
  // param must not narrow the list. Dropping it here rather than at the parse
  // means the URL keeps the value (a viewer with the flag ON who is handed the
  // same link still gets the filter) while nothing narrows a list behind a facet
  // and chip this viewer cannot see or remove.
  const effectiveFacetFilters = useMemo(
    () => applyProjectFacetGate(facetFilters, projectFacetEnabled),
    [facetFilters, projectFacetEnabled]
  );

  // FEA-4201: the explicit `?from=`/`?to=` window, when the URL carries a valid
  // pair AND this viewer has the gate. Behind the gate the params are inert, so
  // a link written by a build that has it on cannot narrow a listing whose
  // viewer has no control to see or clear the window.
  const {
    customDateWindow,
    gateCustomDateWindowChange,
    isCustomDateWindowReady,
  } = useSessionsCustomDateWindow(
    SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
    searchParams,
    routePath
  );
  // FEA-4201 (whitlockk review): the same ISS-6382 reasoning the restore gate already
  // encodes, for the flag rather than the saved view. PostHog reports an
  // unresolved flag as `false`, so a flagged `?from=`/`?to=` link read the PRESET
  // window first — rows AND summary figures for a window nobody asked for — and
  // refetched once the flag answered. Only a URL that names a window waits, and
  // the flag's own deadline bounds that wait.
  // ISS-9619: the reader's day boundary, read ONCE here. Shut, it is UTC with no
  // setter, so the toolbar renders no control and this window is unchanged.
  const { timezoneMode, setTimezoneMode, isTimezoneModeReady } =
    useSharedTimezoneMode("sessions:web");
  // ISS-9619 (whitlockk + codex review): and the day boundary joins that wait, for
  // the same reason the custom window does. An unresolved assignment reads as
  // UTC, so a reader whose stored mode is `local` would otherwise fetch rows AND
  // cards for the UTC window first and refetch the Local one once PostHog
  // answered. Both reads below are gated on this single signal, so the two
  // halves of the surface cannot settle on different windows.
  const isSessionsReadReady =
    resolveSessionsReadReady(
      isViewReady,
      isCustomDateWindowReady,
      isPageSizeReady
    ) && isTimezoneModeReady;

  // UTC-day quantization keeps the query identity stable across remounts. The
  // next render after a UTC rollover advances it; no timer forces a render.
  // Both the list read and the summary-card read below take these two values, so
  // a boundary change re-windows the rows and the cards together.
  const { startDate, endDate } = resolveSessionDateWindow(
    customDateWindow,
    getStableDateWindowForRange(dateRange, timezoneMode)
  );

  // FEA-4177 — stable summary cache identity + no-facet dedupe. The summary cards
  // aggregate the whole (faceted) set, so their usage read is keyed by the summary
  // scope ONLY — never the list's pagination/sort, which the usage endpoint
  // ignores — so paging or sorting the table never re-fetches the cards (the old
  // combined list-keyed read churned this key on every page/sort change).
  // `buildSessionSummaryUsageFilters` normalizes the scope (empty facet arrays
  // dropped, default quality dropped), so with no facet active it deep-equals the
  // bare `{ startDate, endDate, userId }` scope and hashes to one cache key.
  //
  // ISS-5283 (whitlockk review): this is now ALSO the toolbar's facet-option read.
  // The page used to issue a second, date-only usage request for the facet lists
  // so an active Owner selection could not collapse the Owner options — a
  // client-side workaround the server's self-excluding facet predicates replace.
  // Sending the active filters is what lets those predicates run at all.
  const summaryUsageFilters = useMemo(
    () =>
      buildSessionSummaryUsageFilters({
        // ISS-5809: ask the producer for the period-over-period movement in the
        // SAME response as the figures. This replaced a second full usage read
        // for the prior window, which re-ran every facet groupBy and both pagers
        // to yield five percentages.
        comparison: AgentSessionComparisonMode.Prior,
        endDate,
        startDate,
        userId: selectedUserId ?? undefined,
        statuses: facetFilters.statuses,
        userIds: facetFilters.userIds,
        repositories: facetFilters.repositories,
        harnesses: facetFilters.harnesses,
        models: facetFilters.models,
        autonomyTiers: facetFilters.autonomyTiers,
        costBuckets: facetFilters.costBuckets,
        changePresence: facetFilters.changePresence,
        prAssociation: facetFilters.prAssociation,
        projectIds: effectiveFacetFilters.projectIds,
      }),
    [startDate, endDate, facetFilters, effectiveFacetFilters, selectedUserId]
  );

  // The paginated list query. `sortBy` is sent only once a header is clicked, so
  // the default view uses the server's natural order.
  const listFilters = useMemo(
    () => ({
      endDate,
      startDate,
      statuses: facetFilters.statuses,
      userIds: facetFilters.userIds,
      repositories: facetFilters.repositories,
      harnesses: facetFilters.harnesses,
      models: facetFilters.models,
      autonomyTiers: facetFilters.autonomyTiers,
      costBuckets: facetFilters.costBuckets,
      changePresence: facetFilters.changePresence,
      prAssociation: facetFilters.prAssociation,
      projectIds: effectiveFacetFilters.projectIds,
      userId: selectedUserId ?? undefined,
      ...(search === "" ? {} : { listSearch: search }),
      ...(querySortKey ? { sortBy: querySortKey, sortDir } : {}),
      // ISS-8335: the multi-rule spelling of the SAME axis, sent only when a
      // second rule exists so an ordinary one-rule view keeps the exact query it
      // has always sent. `sortBy`/`sortDir` still ride along as the back-compat
      // echo of the lead rule; the server reads `sorts` when it is present.
      //
      // Gated on `sortKey` for the same reason `sortBy` is: with no primary
      // there is no rule list, and a secondary rule cannot lead — the saved view
      // has one lead slot and it is `sortKey`.
      ...(querySortKey && querySecondarySorts.length > 0
        ? {
            sorts: toSessionSortRuleParams([
              { direction: sortDir, fieldId: querySortKey },
              ...querySecondarySorts,
            ]),
          }
        : {}),
      limit: pageSize,
      offset: safePageIndex * pageSize,
    }),
    [
      startDate,
      endDate,
      facetFilters,
      effectiveFacetFilters,
      search,
      selectedUserId,
      querySortKey,
      sortDir,
      querySecondarySorts,
      pageSize,
      safePageIndex,
    ]
  );

  // FEA-4177 — independent failure domains. The list and the summary are two
  // independent queries (the desktop/HTTP sessions usage read shares no scan with
  // the list, so this adds no reads), so a summary-read failure degrades ONLY the
  // cards and never blanks the table (and vice-versa). `keepPreviousData` keeps
  // the last-good page on screen while a filter/page/sort change loads.
  //
  // ISS-6382: both reads hold until the persisted view has restored. The window
  // AND the sort are in these query keys, so a mount that fetched first
  // paginated the corpus under the defaults and then again under the restored
  // view, with the first run unrecoverable. Fails OPEN on a stalled auth
  // hydration (`VIEW_RESTORE_AUTH_DEADLINE_MS`), so the worst case is the
  // pre-gate double read, never a permanent skeleton.
  const sessionsQuery = useAgentSessions(listFilters, {
    enabled: isSessionsReadReady,
    placeholderData: keepPreviousData,
    // FEA-4203: the poll is decided from the query's OWN latest response, so
    // each fetch re-decides whether the next one happens and the timer stops
    // itself on the response in which the last running row goes terminal (or
    // merely silent — the gate reads the DISPLAYED status, so a Stale row does
    // not hold it open). Flag off, this is `false` for every input.
    //
    // `status` is passed so a FAILING read backs the cadence off instead of
    // retrying every 30s (packages/app/AGENTS.md). It backs off rather than stops
    // because the error card below is gated on `isLoadingError`, so a refetch
    // that fails over a good page shows the reader nothing — a stopped poll
    // would leave that page frozen and live-looking with nothing to re-arm it.
    refetchInterval: (query) =>
      resolveSessionsActiveRefetchInterval({
        enabled: activeRowRefetchEnabled,
        items: query.state.data?.items,
        status: query.state.status,
      }),
    // A backgrounded tab has nobody watching the rows move, so the poll pauses
    // with it. Stated rather than left to the TanStack default: this is the half
    // of the gate a reader would otherwise have to know by heart.
    refetchIntervalInBackground: false,
  });
  // ISS-12286 — operator ruling (Marisol Ashgrove, 2026-10-08, PRD-792 open
  // question 1, updated the same day): the summary polls every 2 minutes and
  // refetches on filter change (its query key); Active rows keep the list's
  // 30s refresh. The poll runs under the same running-row gate as the list,
  // derived from the list's ROWS because the usage payload carries none, but
  // from the summary's OWN `status`: the two reads are independent failure
  // domains (FEA-4177), so a failing summary backs its own cadence off.
  const summaryUsageQuery = useAgentSessionUsage(summaryUsageFilters, {
    enabled: isSessionsReadReady,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      resolveSessionsActiveRefetchInterval({
        enabled: activeRowRefetchEnabled,
        intervalMs: SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS,
        items: sessionsQuery.data?.items,
        status: query.state.status,
      }),
    refetchIntervalInBackground: false,
  });
  // ISS-6382 (whitlockk review): `enabled` stops the FETCH; it does not make a warm
  // observer pending. The gate-closed commit still subscribes to the DEFAULT
  // view's cache key, so on any revisit both observers resolve to `success` from
  // cache with `isPending` already false — pre-restore rows, pre-restore cards,
  // and a `total` the page clamp would act on, every one of them describing the
  // view the restore is about to replace. So the readiness signal is read
  // DIRECTLY here rather than inferred from query state, and everything below
  // derives from these.
  const { data: listData, isPending: isListPending } = gateRestoredRead(
    isSessionsReadReady,
    sessionsQuery
  );
  const { data: summaryUsage, isPending: isSummaryPending } = gateRestoredRead(
    isSessionsReadReady,
    summaryUsageQuery
  );
  // ISS-6382: the GATED pending flag, not the query's own. A held-closed read on
  // a warm cache trips none of the comparison helpers' other four flags, so both
  // of them would otherwise read a scope this mount never read.
  const gatedSummaryRead = {
    ...summaryUsageQuery,
    isPending: isSummaryPending,
  };
  // ISS-9897: the metric row behaves like the Sessions listing — a read this
  // scope has not settled is the skeleton, never another scope's figures.
  // `isPlaceholderData` is what says the payload in hand belongs to the PREVIOUS
  // cache key (`keepPreviousData` above), so it skeletons alongside `isPending`;
  // an exact-key hit is neither, and paints from cache without a refetch.
  // ISS-9887: expressed through the one predicate the Branches summary row now
  // reads too — behavior here is unchanged; naming the fold is what stops the
  // other row answering the same question differently again.
  const isSummaryLoading = isSummaryMetricsLoading({
    isPending: isSummaryPending,
    isServingPreviousScope: summaryUsageQuery.isPlaceholderData,
  });
  // #4480: read the rows BEFORE the footer is built — the range readout's upper
  // bound is the rows actually on screen, not `(page + 1) * pageSize`, so it
  // needs this on the same render that decides the footer.
  const items = listData?.items ?? [];
  const listReadModel = resolveSessionsListReadModel({
    canRead: isSessionsReadReady,
    hasData: listData !== undefined,
    isError: sessionsQuery.isError,
    isLoading: isListPending || sessionsQuery.isLoading,
    isLoadingError: sessionsQuery.isLoadingError,
    isPlaceholderData: sessionsQuery.isPlaceholderData,
    knownTotal: listData?.total,
    rowCount: items.length,
  });
  const knownTotal = listReadModel.totalRows;
  const total = knownTotal ?? 0;
  const totalPages = resolveCappedTotalPages(
    total,
    pageSize,
    SESSION_LIST_MAX_OFFSET
  );
  // FEA-3560: one shared writer for every list-URL write. It re-asserts the
  // facet params on each call (from the filters argument), so a pagination or
  // sort click landing while a facet replace is still reconciling into the
  // search-params snapshot cannot silently drop the facets from the URL.
  const replaceListParams = useReplaceListParams(
    writeSessionFacetFilterParams,
    writeSessionsPageParam
  );
  const replacePage = useSessionsReplacePage(replaceListParams, facetFilters);
  // FEA-4199: growing/shrinking the page size RESETS to page 0. Keeping the
  // index would silently move the user: at 25/page, page 3 starts at row 76;
  // switching to 100/page with index 3 would jump them to row 301, a place they
  // never asked to go (and often past the end of the result set).
  // stage review: `markPageReset()` is what holds `effectivePageIndex` at the
  // intended 0 while the router replace is still reconciling into the
  // search-params snapshot — every other reset handler here calls it. Without
  // it, `listFilters` recomputes IMMEDIATELY as
  // `limit: nextPageSize, offset: oldIndex * nextPageSize` and a request goes
  // out for a window nobody asked for (page 4 of 431 at 25/page → switch to
  // 100/page → fetch offset 300 limit 100 while the footer reads 301-400). The
  // clamp effect below cannot rescue it, because index 3 is still a VALID page
  // at 100/page.
  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      markPageReset();
      setPageSize(nextPageSize);
      replacePage(0);
    },
    [markPageReset, replacePage, setPageSize]
  );
  useEffect(() => {
    if (knownTotal === undefined) {
      return;
    }

    const clampedPageIndex = clampSessionsPageIndex(
      effectivePageIndex,
      knownTotal,
      pageSize,
      SESSION_LIST_MAX_OFFSET
    );
    if (clampedPageIndex === effectivePageIndex) {
      return;
    }

    markPageOverride(clampedPageIndex);
    replacePage(clampedPageIndex);
    // FEA-4199: `pageSize` is a real dependency — the clamp is computed FROM it,
    // so shrinking the page size (100 → 25) must re-clamp a now-out-of-range
    // page index rather than leaving the user on a page past the end.
  }, [effectivePageIndex, knownTotal, markPageOverride, replacePage, pageSize]);

  // ISS-12286: a focus or reconnect re-reads only the stale half.
  //
  // ISS-6382: EMPTY while the restore gate holds. A query with no data is stale,
  // and `refetch()` ignores `enabled` — so a focus or reconnect event landing
  // inside the restore window would force exactly the default-view read the gate
  // exists to prevent. An empty group is inert (`some` over nothing is false).
  useQueryFreshnessGroup(
    isSessionsReadReady ? [sessionsQuery, summaryUsageQuery] : []
  );
  const handleSort = (column: string, direction: SortDirection) => {
    markPageReset();
    setSort(column as SessionSortKey, direction as SessionSortDir);
    replacePage(0);
  };
  // Every write this page makes to its own list URL — see the module for why
  // they are ONE unit and why each performs exactly one `replaceListParams`.
  const {
    handleClearFilters,
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleRemoveSelectedUser,
    handleScopeChange,
  } = useSessionsListUrlWriters({
    facetFilters,
    markPageReset,
    projectFacetEnabled,
    replaceListParams,
    selectedUserParam: SESSIONS_SELECTED_USER_PARAM,
    setDateRange,
    setFacetFilters,
  });

  // #4480: the banded column's removal used to live HERE, which is exactly why
  // desktop printed the grouped value twice — it never ran this. The shared
  // `SessionsTable` owns that derivation now (`hideSessionGroupedColumn`), so
  // this page hands it the user's real column set and both shells behave the
  // same.
  useSessionsHistoryScroll({
    scrollKey: `org:${orgSlug}:sessions:page:${safePageIndex}`,
    container: scrollContainer,
    // ISS-6382: the same signal the table body uses — a read held closed by the
    // restore gate is not "loaded", and starting the scroll restore against an
    // unpopulated container burns its bounded retry budget before the rows
    // exist. `isPlaceholderData` is in there for the same reason (whitlockk review):
    // `keepPreviousData` puts the OUTGOING page's rows in the container while
    // the incoming one loads, so restoring against them measures the wrong
    // content height and lands the scroll somewhere the user never was.
    restoreWhen: !(isListPending || sessionsQuery.isPlaceholderData),
  });

  // Is anything narrowing the list, and would a Clear move either read's query
  // key? Both questions are answered from one place so the empty state's
  // filtered-vs-genuinely-empty split and the recovery control's refetch
  // decision cannot drift apart — see `resolveSessionsScopeState`.
  const { hasActiveFilters, isListScopeDefault, isUsageScopeDefault } =
    resolveSessionsScopeState({
      customDateWindow,
      dateRange,
      effectivePageIndex: safePageIndex,
      facetFilters: effectiveFacetFilters,
      search,
      selectedUserId,
    });
  // PRD-536 §5: only probe "has any agent ever connected?" when the list has
  // resolved to zero rows — a populated list never pays for the extra request,
  // and `undefined` while it loads keeps the neutral filters message.
  const hasConnectedAgentQuery = useHasConnectedAgent({
    enabled:
      sessionsQuery.isSuccess &&
      listReadModel.hasKnownTotal &&
      knownTotal === 0,
  });
  // ISS-11913: gated on HELD current data rather than `isSuccess`, so a refetch
  // that fails over an empty page keeps the answer that page already has.
  const outsideWindowProbe = useSessionsOutsideWindow({
    customWindowActive: customDateWindow !== null,
    dateRange,
    isListSettledEmpty:
      listData !== undefined &&
      !sessionsQuery.isPlaceholderData &&
      listReadModel.hasKnownTotal &&
      knownTotal === 0,
    otherFiltersActive: resolveSessionsNonWindowFiltersActive({
      facets: effectiveFacetFilters,
      isServerDriven: true,
      scopeUserId: selectedUserId,
      search,
    }),
  });
  const refetchSessions = sessionsQuery.refetch;
  const refetchSummaryUsage = summaryUsageQuery.refetch;
  const handleClearFiltersAndReload = useCallback(() => {
    handleClearFilters();
    // Self-catching, both: the Link ignores the result, and a rejected re-read
    // must not surface as an unhandled rejection — the errored card already
    // renders.
    if (isListScopeDefault) {
      refetchSessions().catch(() => undefined);
    }
    if (isUsageScopeDefault) {
      refetchSummaryUsage().catch(() => undefined);
    }
  }, [
    handleClearFilters,
    isListScopeDefault,
    isUsageScopeDefault,
    refetchSessions,
    refetchSummaryUsage,
  ]);

  // Both branches offer the SAME two actions, so they are built once. Two
  // copies drifted apart is how the v2 mount lost props the v1 one kept.
  const onboardingAction = (
    <Button asChild size="sm">
      <Link href={`/${orgSlug}/settings`}>Connect a compute target</Link>
    </Button>
  );
  // ISS-4534: the errored card is never a dead end. Its single primary action is
  // "Clear filters and reload" — clearing the active filters (which re-issues
  // the read via the query-key change) escapes a read wedged by a stale
  // filter/search URL, and its `href` still opens a working list in a new tab on
  // a modified click. This is a superset of a bare Retry, so the card carries
  // this one honest action instead of two. ISS-7414: the RELOAD half is
  // `handleClearFiltersAndReload`, so the control still re-reads from an
  // already-clean scope, where the reset alone moves no query key and would
  // otherwise do nothing.
  const errorRecoveryAction = (
    <SessionsRecoveryAction
      href={`/${orgSlug}/sessions`}
      onClearFilters={handleClearFiltersAndReload}
    />
  );

  // ISS-8221: every value the listing needs, assembled ONCE and handed to
  // whichever surface the branch below picks. Neither surface receives the
  // `grid-table-v2` key, which is what keeps the flag's whole reach the single
  // read above this object.
  const surfaceInput: SessionsSurfaceInput = {
    columnOrder,
    columnWidths,
    customDateWindow,
    dateRange,
    effectiveFacetFilters,
    effectivePageIndex: safePageIndex,
    errorRecoveryAction,
    facetFilters,
    getIssueHref: buildIssueHref,
    getSessionHref,
    githubConnectGate,
    groupBy,
    handleClearFilters,
    handleCustomDateWindowChange: gateCustomDateWindowChange(
      handleCustomDateWindowChange
    ),
    handleDateRangeChange,
    handleFiltersChange,
    handleRemoveSelectedUser,
    handleScopeChange,
    handleSort,
    handleTimezoneModeChange: setTimezoneMode,
    timezoneMode,
    hasActiveFilters,
    hasConnectedAgent: hasConnectedAgentQuery.data,
    hasSessionsOutsideWindow: outsideWindowProbe.hasSessionsOutsideWindow,
    hiddenSummaryCards,
    honestLoadingEnabled,
    // ISS-11913: an empty list has not said whether sessions exist until the
    // outside-window probe lands, so the surface keeps its loading treatment.
    isListPending: isListPending || outsideWindowProbe.isPending,
    isListUnavailable: sessionsQuery.isLoadingError,
    isPlaceholderPage: sessionsQuery.isPlaceholderData,
    isSessionsReadReady,
    isSummaryLoading,
    isSummaryLoadingError: summaryUsageQuery.isLoadingError,
    items,
    listReadState: listReadModel.state,
    listFilters,
    markPageReset,
    onboardingAction,
    onPageSizeChange: handlePageSizeChange,
    pageSize,
    // ISS-9555: forwarded straight off the read. The surface reads the served
    // page from here instead of the host re-deriving it from `total`.
    pageInfo: listData?.pageInfo,
    projectFacetEnabled,
    replacePage,
    resetView,
    search,
    selectedUserId,
    setColumnOrder,
    setColumnWidth,
    setGroupBy,
    setScrollContainer,
    secondarySorts,
    setSecondarySorts,
    setSort,
    sortDir,
    sortKey,
    summaryComparisonRead: gatedSummaryRead,
    summaryUsage,
    toggleColumn,
    toggleSummaryCard,
    total,
    totalPages,
    visibleColumns,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ISS-5975: the header's right slot no longer carries a Refresh control
          (ISS-5315 added it, ISS-5478 placed it here). Nothing replaces it —
          the list keeps itself current — so the header is back to breadcrumbs
          alone. The Sessions DETAIL page keeps its own refresh path; this
          ticket is the listing page only. */}
      <Header breadcrumbs={[{ label: "Sessions" }]} />
      {/* ISS-8221: the surface below owns its own render derivations. */}
      <SessionsV2Page input={surfaceInput} />
    </div>
  );
}
