"use client";
import { costFilterIncludesUnknown } from "@repo/api/src/agent-session-filters";
import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { SessionsEmptyState } from "@repo/app/agents/components/sessions/sessions-empty-state";
import { SessionsRecoveryAction } from "@repo/app/agents/components/sessions/sessions-recovery-action";
import { SessionsSummaryCards } from "@repo/app/agents/components/sessions/sessions-summary-cards";
import { SessionsToolbar } from "@repo/app/agents/components/sessions/sessions-toolbar";
import {
  useAgentSessions,
  useAgentSessionUsage,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { useHasConnectedAgent } from "@repo/app/agents/hooks/use-has-connected-agent";
import {
  DEFAULT_SESSIONS_DATE_RANGE,
  useSessionsViewState,
} from "@repo/app/agents/hooks/use-sessions-view-state";
import {
  parseSessionDateRangeParam,
  SESSION_DATE_RANGE_PARAM,
} from "@repo/app/agents/lib/session-date-range-param";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  hasAnyActiveSessionFacet,
  parseSessionFacetFilterParams,
  type SessionFacetFilters,
  writeSessionFacetFilterParams,
} from "@repo/app/agents/lib/session-filter-adapter";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import {
  buildSessionSummaryDeltas,
  shouldSuppressSessionComparison,
} from "@repo/app/agents/lib/session-summary-deltas";
import { buildSessionSummaryUsageFilters } from "@repo/app/agents/lib/session-usage-filters";
import { sessionsRangeReadout } from "@repo/app/agents/lib/sessions-range-readout";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { useReplaceListParams } from "@repo/app/shared/hooks/use-replace-list-params";
import { initialFacetParamsSource } from "@repo/app/shared/lib/facet-filter-params";
import {
  GRID_TABLE_V2_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
  SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY,
  SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { useQueryFreshnessGroup } from "@repo/app/shared/query/use-query-freshness-group";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  clampSessionsPageIndex,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  useSessionsUrlPageIndex,
  writeSessionsPageParam,
} from "@/app/(authenticated)/sessions-route-state";
import { SessionsTable } from "@/components/agent-sessions/sessions-table";
import { useOrgSlug } from "@/hooks/use-org-slug";

// FEA-4199: the pre-v2 fixed page size. Still the DEFAULT under GridTable v2 —
// the flag adds the 50/100 choices, it does not change what an existing user
// sees on first render.
const PAGE_SIZE = DEFAULT_TABLE_PAGE_SIZE;

// Module-local e2e anchors. A Next.js App Router page module may only export the
// reserved page exports (`default`, `metadata`, …), so these stay non-exported;
// the specs that read them redeclare the same literals. ISS-4673 turned the
// scroll container from a `<main>` into a `<div>` (the shell's `SidebarInset`
// owns the page's single `<main>`), so `getByRole("main")` no longer resolves to
// it — `e2e/visual-regression.spec.ts` screenshots the scroll container by test
// id, and the list body is the sessions-list-back / cost-unknown anchor.
const SCROLL_CONTAINER_TEST_ID = "sessions-scroll-container";
const HISTORY_LIST_TEST_ID = "sessions-history-list";

// The cross-surface selected-user deep link. URL-owned: the facet writer never
// emits or clears it, so every code path that has to strip it names it from here
// (ISS-4728).
const SELECTED_USER_PARAM = "userId";

export default function SessionsPage() {
  // ISS-5574: name the tab for this surface. Off by default behind the shared
  // web+desktop flag; the desktop renderer titles the same route from the same key.
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? "Sessions" : null);
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const selectedUserId = searchParams.get(SELECTED_USER_PARAM);
  // ISS-4728 (ISS-4779 closed-by-default): fold the selected-user scope into the
  // active-filter chip row and retire the legacy badge. OFF ⇒ prior badge.
  const ownerScopeChipEnabled = useFeatureFlagEnabled(
    SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY
  );
  // FEA-3560: seeded from the list URL (the facet params are mirrored into the
  // URL on every change below), so navigating into a session detail and back —
  // or reloading / opening a shared link — restores the active facet filters
  // instead of showing `?page=N` of the unfiltered set.
  const [facetFilters, setFacetFilters] = useState<SessionFacetFilters>(() =>
    // `initialFacetParamsSource` falls back to the browser URL when the App
    // Router snapshot is still reconciling (empty) on a reload/deep link —
    // mirrors `readSessionsPageIndex`'s page-param fallback.
    parseSessionFacetFilterParams(initialFacetParamsSource(searchParams))
  );
  // FEA-4199 (GridTable v2). Component state, not URL state: the page INDEX is
  // URL-owned (FEA-3560) because a shared link must land on the same page, but
  // the page SIZE is a per-user viewing preference and putting it in the URL
  // would make every shared Sessions link impose the sharer's density on the
  // recipient.
  const gridTableV2Enabled = useFeatureFlagEnabled(
    GRID_TABLE_V2_FEATURE_FLAG_KEY
  );
  const projectFacetEnabled = useFeatureFlagEnabled(
    SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY
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
  const buildIssueHref = useCallback(
    (artifact: SessionLinkedArtifact) =>
      withOrgSlug(
        orgSlug,
        getDocumentTypeRoute(artifact.documentType, artifact.slug)
      ),
    [orgSlug]
  );
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  // ISS-4901: gates the horizontal scroll affordance on the list's scroll
  // region. One key with the rest of the Sessions fold legibility pass — the
  // affordance only earns its keep once the fold is flush (ISS-4889/4906), and
  // shipping the flush fold without it is strictly worse than either alone.
  const foldLegibilityEnabled = useFeatureFlagEnabled(
    SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY
  );
  const urlPageIndex = useSessionsUrlPageIndex(searchParams);
  const { effectivePageIndex, markPageOverride, markPageReset } =
    useSessionsPageReset({
      urlPageIndex,
    });
  const {
    sortKey,
    sortDir,
    dateRange: savedDateRange,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    setDateRange,
    toggleColumn,
    resetView,
    groupBy,
    setGroupBy,
  } = useSessionsViewState("sessions:web");

  // ISS-5355: an inbound link may name the window it was counted over
  // (`?range=`), which the viewer's saved range must not silently override —
  // that is what let the project-detail strip's count and the listing it opens
  // disagree. Derived during render (no Effect, no state mirror): the param wins
  // while it is in the URL, and the range picker strips it, so touching the
  // control hands control straight back to the saved preference.
  const urlDateRange = parseSessionDateRangeParam(
    searchParams.get(SESSION_DATE_RANGE_PARAM)
  );
  const dateRange = urlDateRange ?? savedDateRange;

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

  // UTC-day quantization keeps the query identity stable across remounts. The
  // next render after a UTC rollover advances it; no timer forces a render.
  const { startDate, endDate } = getStableUtcDateWindowForRange(dateRange);

  // FEA-4177 — stable summary cache identity + no-facet dedupe. The summary cards
  // aggregate the whole (faceted) set, so their usage read is keyed by the summary
  // scope ONLY — never the list's pagination/sort, which the usage endpoint
  // ignores — so paging or sorting the table never re-fetches the cards (the old
  // combined list-keyed read churned this key on every page/sort change).
  // `buildSessionSummaryUsageFilters` normalizes the scope (empty facet arrays
  // dropped, default quality dropped), so with no facet active it deep-equals the
  // bare `{ startDate, endDate, userId }` scope and hashes to one cache key.
  //
  // ISS-5283 (wongk review): this is now ALSO the toolbar's facet-option read.
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
      ...(sortKey ? { sortBy: sortKey, sortDir } : {}),
      limit: pageSize,
      offset: effectivePageIndex * pageSize,
    }),
    [
      startDate,
      endDate,
      facetFilters,
      effectiveFacetFilters,
      selectedUserId,
      sortKey,
      sortDir,
      effectivePageIndex,
      pageSize,
    ]
  );

  // FEA-4177 — independent failure domains. The list and the summary are two
  // independent queries (the desktop/HTTP sessions usage read shares no scan with
  // the list, so this adds no reads), so a summary-read failure degrades ONLY the
  // cards and never blanks the table (and vice-versa). `keepPreviousData` keeps
  // the last-good page on screen while a filter/page/sort change loads.
  const sessionsQuery = useAgentSessions(listFilters, {
    placeholderData: keepPreviousData,
  });
  const summaryUsageQuery = useAgentSessionUsage(summaryUsageFilters, {
    placeholderData: keepPreviousData,
  });
  const summaryDeltas = buildSessionSummaryDeltas({
    // FEA-4202 (Grid Parity): the cadence captions (WoW/MoM/QoQ) and the
    // `PRs Shipped` chip ride the SAME shared flag the rest of this tagged pass
    // uses, resolved here because the shared component has mount sites with no
    // flag provider. OFF ⇒ the ISS-5315 strip, unchanged.
    comparisonV2Enabled: gridTableV2Enabled,
    current: summaryUsageQuery.data,
    dateRange,
    // ISS-5809: the comparison now rides the SAME response as the figures it
    // grades, so there is no second query to keep in step — the #4480 hazard of
    // grading a landed response against another query's cached generation cannot
    // arise. The gate remains because a placeholder/stale/errored read still
    // means the figures ON SCREEN are not the ones the comparison describes.
    suppressed: shouldSuppressSessionComparison(summaryUsageQuery),
  });
  const knownTotal = sessionsQuery.data?.total;
  const total = knownTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // #4480: read the rows BEFORE the footer is built — the range readout's upper
  // bound is the rows actually on screen, not `(page + 1) * pageSize`, so it
  // needs this on the same render that decides the footer.
  const items = sessionsQuery.data?.items ?? [];
  // FEA-3560: one shared writer for every list-URL write. It re-asserts the
  // facet params on each call (from the filters argument), so a pagination or
  // sort click landing while a facet replace is still reconciling into the
  // search-params snapshot cannot silently drop the facets from the URL.
  const replaceListParams = useReplaceListParams(
    writeSessionFacetFilterParams,
    writeSessionsPageParam
  );
  const replacePage = useCallback(
    (nextPage: number) => replaceListParams(facetFilters, nextPage),
    [replaceListParams, facetFilters]
  );
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
    [markPageReset, replacePage]
  );
  // FEA-4199: with GridTable v2 on, the footer also carries the rows-per-page
  // select and an honest range readout, and renders whenever there are rows
  // (not only past page one) so the control stays reachable on a single-page
  // list. Flag off → the exact pre-v2 strip, guarded on `totalPages > 1` with
  // no readout. Built here rather than inline so neither branch needs a nested
  // ternary in the JSX.
  const paginationFooter = buildSessionsPaginationFooter({
    gridTableV2Enabled,
    isPlaceholderPage: sessionsQuery.isPlaceholderData,
    onPageChange: replacePage,
    onPageSizeChange: handlePageSizeChange,
    pageIndex: effectivePageIndex,
    pageSize,
    rowsOnPage: items.length,
    total,
    totalPages,
  });
  useEffect(() => {
    if (knownTotal === undefined) {
      return;
    }

    const clampedPageIndex = clampSessionsPageIndex({
      pageIndex: effectivePageIndex,
      pageSize,
      total: knownTotal,
    });
    if (clampedPageIndex === effectivePageIndex) {
      return;
    }

    markPageOverride(clampedPageIndex);
    replacePage(clampedPageIndex);
    // FEA-4199: `pageSize` is a real dependency — the clamp is computed FROM it,
    // so shrinking the page size (100 → 25) must re-clamp a now-out-of-range
    // page index rather than leaving the user on a page past the end.
  }, [effectivePageIndex, knownTotal, markPageOverride, replacePage, pageSize]);

  // ISS-5975: the header's manual Refresh control and its `handleRefresh`
  // callback are gone. The property that callback existed to guarantee — both
  // halves of this page re-reading TOGETHER — is preserved here instead.
  //
  // ISS-5976's focus/reconnect defaults alone do NOT preserve it (wongk review).
  // They revalidate each query against its OWN `dataUpdatedAt`, and these two
  // fetches resolve at different instants, so their 60-second windows are
  // offset: a focus event landing between the two boundaries refetches the rows
  // and leaves the cards and facet counts describing the previous population.
  // Grouping them makes either one going stale re-read both, and lands their
  // clocks together so the offset cannot grow.
  useQueryFreshnessGroup([sessionsQuery, summaryUsageQuery]);
  const handleSort = (column: string, direction: SortDirection) => {
    markPageReset();
    setSort(column as SessionSortKey, direction as SessionSortDir);
    replacePage(0);
  };
  const handleFiltersChange = (next: SessionFacetFilters) => {
    markPageReset();
    setFacetFilters(next);
    replaceListParams(next, 0);
  };
  const handleDateRangeChange = (next: DateRange) => {
    markPageReset();
    setDateRange(next);
    // ISS-5355: strip an inbound `?range=` in the SAME write as the page reset.
    // Two writes would both copy the pre-click params snapshot and the second
    // would restore what the first removed (the ISS-4728 trap), leaving the
    // link's window overriding the range the user just picked.
    replaceListParams(facetFilters, 0, [SESSION_DATE_RANGE_PARAM]);
  };

  // #4480: the banded column's removal used to live HERE, which is exactly why
  // desktop printed the grouped value twice — it never ran this. The shared
  // `SessionsTable` owns that derivation now (`hideSessionGroupedColumn`), so
  // this page hands it the user's real column set and both shells behave the
  // same.
  useSessionsHistoryScroll({
    scrollKey: `org:${orgSlug}:sessions:page:${effectivePageIndex}`,
    container: scrollContainer,
    restoreWhen: !sessionsQuery.isLoading,
  });

  // FEA-4181 (review cid 3653717604): is any filter narrowing the list? A
  // non-default time window, any active facet, or a cross-surface `userId` param.
  // Drives the filtered-vs-genuinely-empty split in the honest empty state below
  // (measured against the shared Sessions defaults, not a hardcoded literal).
  const hasActiveSessionFilters =
    dateRange !== DEFAULT_SESSIONS_DATE_RANGE ||
    hasAnyActiveSessionFacet(effectiveFacetFilters) ||
    Boolean(selectedUserId);
  // PRD-536 §5: only probe "has any agent ever connected?" when the list has
  // resolved to zero rows — a populated list never pays for the extra request,
  // and `undefined` while it loads keeps the neutral filters message.
  const hasConnectedAgentQuery = useHasConnectedAgent({
    enabled: sessionsQuery.isSuccess && knownTotal === 0,
  });
  const handleClearFilters = useCallback(() => {
    markPageReset();
    setDateRange(DEFAULT_SESSIONS_DATE_RANGE);
    setFacetFilters(DEFAULT_SESSION_FACET_FILTERS);
    // Reset the facets + page in the URL and strip the URL-owned `userId`
    // narrower the facet writer doesn't manage (FEA-4181), so the clear can't
    // re-run the same narrowed empty result.
    // ISS-5355 adds `?range=` to that set: it is URL-owned too, and leaving it
    // would keep the inbound window narrowing a view the user just cleared.
    replaceListParams(DEFAULT_SESSION_FACET_FILTERS, 0, [
      SELECTED_USER_PARAM,
      SESSION_DATE_RANGE_PARAM,
    ]);
  }, [markPageReset, replaceListParams, setDateRange]);

  // ISS-4728: remove the selected-user scope, leaving the date window and every
  // facet the chip row did not fold in where they are. `?userId=` is URL-owned —
  // the facet writer never emits it — so clearing it is a param strip, not a
  // facet toggle. Page resets to 0 because the row set widens under it and page
  // N of the narrowed list is not page N of the wider one.
  //
  // `nextFilters` comes from the chip row and is the ONLY facet state this write
  // may use: when the scoped user is also a selected Owner facet value the two
  // chips collapse into one, so removing it has to drop BOTH narrowers — and it
  // has to do so in this SINGLE `replaceListParams` call. Splitting it into a
  // param strip plus a separate `handleFiltersChange` is the bug this replaced
  // (review cid 3701353686): both writers copy the same pre-click search-params
  // snapshot, React batches them inside one click with no re-render between, and
  // the second `replace` wins — putting `userId` straight back while clearing
  // the facet, so the chip reappeared over a still-narrowed list.
  const handleRemoveSelectedUser = useCallback(
    (nextFilters: SessionFacetFilters) => {
      markPageReset();
      setFacetFilters(nextFilters);
      replaceListParams(nextFilters, 0, [SELECTED_USER_PARAM]);
    },
    [markPageReset, replaceListParams]
  );

  let tableContent: ReactNode;
  if (sessionsQuery.isLoading) {
    tableContent = <Skeleton className="h-[320px] w-full" />;
  } else if (items.length === 0) {
    // FEA-4181 (review cid 3653717604): the canonical org-scoped route now runs
    // the same honest empty state the desktop and legacy `/sessions` surfaces
    // use — an initial errored read renders "Couldn't load sessions" + Retry
    // (not the old "No sessions found" that lied when the read failed), a
    // filtered-away scope offers Clear filters, and a genuinely-empty org shows
    // the connect-a-compute-target onboarding CTA. `SessionsEmptyState` derives
    // which of the three from the signals; a refetch that still holds cached rows
    // keeps rendering the table (this branch is items.length === 0 only).
    tableContent = (
      <SessionsEmptyState
        // ISS-4534: the errored card is never a dead end. Its single primary
        // action is "Clear filters and reload" — clearing the active filters
        // (which re-issues the read via the query-key change) escapes a read
        // wedged by a stale filter/search URL, and its `href` still opens a
        // working list in a new tab on a modified click. This is a superset of a
        // bare Retry, so the card carries this one honest action instead of two.
        errorRecoveryAction={
          <SessionsRecoveryAction
            href={`/${orgSlug}/sessions`}
            onClearFilters={handleClearFilters}
          />
        }
        hasConnectedAgent={hasConnectedAgentQuery.data}
        onboardingAction={
          <Button asChild size="sm">
            <Link href={`/${orgSlug}/settings`}>Connect a compute target</Link>
          </Button>
        }
        onClearFilters={handleClearFilters}
        signals={{
          isUnavailable: sessionsQuery.isError,
          hasActiveFilters: hasActiveSessionFilters,
        }}
      />
    );
  } else {
    tableContent = (
      <SessionsTable
        columnOrder={columnOrder}
        getIssueHref={buildIssueHref}
        getSessionHref={(item) => `/${orgSlug}/sessions/${item.id}`}
        groupBy={groupBy}
        items={items}
        onColumnOrderChange={setColumnOrder}
        onSort={handleSort}
        sortBy={sortKey}
        sortDir={sortDir}
        visibleColumns={visibleColumns}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ISS-5975: the header's right slot no longer carries a Refresh control
          (ISS-5315 added it, ISS-5478 placed it here). Nothing replaces it —
          the list keeps itself current — so the header is back to breadcrumbs
          alone. The Sessions DETAIL page keeps its own refresh path; this
          ticket is the listing page only. */}
      <Header breadcrumbs={[{ label: "Sessions" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filter/View toolbar — pinned above the scroll area, left-aligned. The
            table header sticks to the top of the scroll container right beneath
            it. */}
        <div className="border-b px-4 py-3">
          <SessionsToolbar
            dateRange={dateRange}
            filters={effectiveFacetFilters}
            groupBy={groupBy}
            // ISS-5355 (ISS-4779 closed-by-default): the Project facet ships
            // behind its own flag, default off. Web-only, so no Labs twin — a
            // session's project comes from its cloud artifact, which the
            // desktop local producer cannot resolve. OFF ⇒ no facet, no chip,
            // and `projectIds` stays empty so no filter is applied.
            // FEA-4209 / FEA-4210: this surface renders the linked-entity
            // columns, so their View-menu entries belong in this menu. The
            // shared `grid-table-v2` key still gates them inside the toolbar.
            includeLinkedEntityColumns
            includeProjectFilter={projectFacetEnabled}
            onClearFilters={handleClearFilters}
            onDateRangeChange={handleDateRangeChange}
            onFiltersChange={handleFiltersChange}
            onGroupByChange={setGroupBy}
            onRemoveScopeUser={
              ownerScopeChipEnabled ? handleRemoveSelectedUser : undefined
            }
            onResetView={resetView}
            onToggleColumn={toggleColumn}
            scopeUserId={ownerScopeChipEnabled ? selectedUserId : undefined}
            // ISS-5283 (wongk review): the toolbar reads the ACTIVE-FILTER usage
            // response. It used to read a separate date-only request that dropped
            // every facet, so selecting an Owner left the Harness counts global —
            // the server's new self-excluding facet predicates never reached the
            // surface that operates the facets. `/agent-sessions/usage` now scopes
            // each facet's counts to every OTHER active filter while excluding the
            // facet's own dimension, which is exactly what a facet list needs: the
            // options the user can widen to, counted under the rest of the view.
            // (With no facet active `buildSessionSummaryUsageFilters` normalizes to
            // the same bounded `{ startDate, endDate, userId }` scope the old read
            // used, so this is
            // one query where there used to be two.)
            usage={summaryUsageQuery.data}
            visibleColumns={visibleColumns}
          />
        </div>

        {/* Cards + table share one scroll container, so they scroll together.
            The toolbar above stays pinned.
            plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto",
            // ISS-4901: now that the fold lands flush on a column boundary
            // (ISS-4889), the half-cut column that used to say "scroll me" is
            // gone — and on macOS default settings this region scrolls with an
            // overlay scrollbar that is invisible at rest, so 7 of 15 columns
            // show and nothing on screen says the other 8 exist. The
            // `scrollbar-overlay` utility is the cue the rest of the product
            // already uses for exactly this (the app sidebar, and this same
            // table's other host `synced-sessions-table.tsx`): a persistent thin
            // thumb whose LENGTH also reports how much more there is, which an
            // edge gradient cannot. It replaces the fold's lost cue without
            // laying anything over a value.
            foldLegibilityEnabled && "scrollbar-overlay"
          )}
          data-testid={SCROLL_CONTAINER_TEST_ID}
          ref={setScrollContainer}
        >
          <div className="sticky left-0 flex flex-col gap-4 px-4 pt-3 pb-4">
            {/* ISS-4728: the legacy selected-user badge. It named a filter it
                gave no way to remove, and sat inside the scroll area — a second
                visual language for the job the pinned chip row already does. When
                the flag is ON the scope is an Owner chip in that row instead. */}
            {!ownerScopeChipEnabled && selectedUserId ? (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">User filtered</Badge>
                <span className="text-muted-foreground text-sm">
                  Showing sessions for the selected user.
                </span>
              </div>
            ) : null}

            <SessionsSummaryCards
              // ISS-4481: when the active Cost facet is Unknown, every row shows
              // "—", so the Cost tile drops to its honest-empty state instead of
              // summing the all-unknown cohort to a fabricated "$0" (stage review).
              costUnknownActive={costFilterIncludesUnknown(
                facetFilters.costBuckets
              )}
              deltas={summaryDeltas}
              // isLoadingError (not raw isError): a refetch failure that still
              // has cached data keeps rendering the last-good values instead of
              // dashing every card. FEA-3865: opt into the mobile wrap so the
              // strip wraps with the table beneath it below `md`.
              isError={summaryUsageQuery.isLoadingError}
              // wongk review (FEA-4177): treat `isPlaceholderData` as loading
              // too. The summary and list queries settle independently, and
              // `keepPreviousData` on the summary means a filter-scope change
              // can leave the OLD scope's totals on screen next to the NEW
              // scope's rows until the summary refetch lands. Gating on
              // `isPlaceholderData` skeletons the cards during that window so
              // the numbers never disagree with the table. Pagination and sort
              // do NOT participate in the summary key, so they don't trip this.
              isLoading={
                summaryUsageQuery.isLoading ||
                summaryUsageQuery.isPlaceholderData
              }
              usage={summaryUsageQuery.data}
              wrapBelow
            />
          </div>

          {/* data-testid: stable anchor for the sessions-list-back e2e; see that spec. */}
          <div data-testid={HISTORY_LIST_TEST_ID}>{tableContent}</div>
        </div>

        {/* ISS-4681 shipped this footer without a readout, on the grounds that
            this list "has no settled total it could state honestly". ISS-5315
            revisits that: `total` IS the figure `totalPages` is already derived
            from, so stating it is strictly more honest than deriving a page
            count from it in silence — and the prototype's footer states it. The
            two branches (FEA-4199's v2 strip with the rows-per-page select, and
            the pre-v2 strip behind the flag) are assembled above so neither
            needs a nested ternary here. */}
        {paginationFooter}
      </div>
    </div>
  );
}

/**
 * ISS-5355's flag-off Project drop, lifted out of `SessionsPage`. Behavior is
 * unchanged — with the facet enabled the filters pass through untouched; with it
 * off `projectIds` is reset to the default so an inbound `project=` param cannot
 * narrow a list behind a facet and chip this viewer can neither see nor remove.
 * It lives here rather than inline because ISS-5315's Group-by branch
 * and this one landed in the same component, which put `SessionsPage` one point
 * over the cognitive-complexity ceiling; scoring this branch against its own
 * helper keeps both features whole.
 */
type SessionsPaginationFooterInput = {
  gridTableV2Enabled: boolean;
  isPlaceholderPage: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (size: number) => void;
  pageIndex: number;
  pageSize: number;
  rowsOnPage: number;
  total: number;
  totalPages: number;
};

/**
 * FEA-4199: with GridTable v2 on, the footer also carries the rows-per-page
 * select and an honest range readout, and renders whenever there are rows (not
 * only past page one) so the control stays reachable on a single-page list.
 * Flag off → the exact pre-v2 strip, guarded on `totalPages > 1` with no
 * readout. Built here rather than inline so neither branch needs a nested
 * ternary in the JSX, and lifted out of `SessionsPage` because ISS-5315's
 * Group-by work and ISS-5355's Project facet landed in that one
 * component and pushed it past the cognitive-complexity ceiling.
 *
 * stage review: `total` comes from `sessionsQuery.data?.total` under
 * `keepPreviousData`, so mid-filter-change it is the PRE-change population. The
 * summary cards on this page already treat `isPlaceholderData` as loading
 * precisely so they never state a placeholder number as fact; the readout has to
 * hold the same line, or the two halves of one strip disagree about whether the
 * number is known yet. Omitted (not frozen) while placeholder —
 * `TablePaginationFooter` renders no readout when it gets none, and the
 * rows-per-page select beside it stays put.
 *
 * #4480: the placeholder gate is the HELPER's, not this caller's. Both shells
 * hold the list with `keepPreviousData`, so both would otherwise have to
 * remember the same discipline; `sessionsRangeReadout` takes `isPlaceholderPage`
 * as a required input and returns `null` itself, which is also what keeps this
 * page and the desktop `SessionsView` phrasing one sentence rather than two.
 */
function buildSessionsPaginationFooter({
  gridTableV2Enabled,
  isPlaceholderPage,
  onPageChange,
  onPageSizeChange,
  pageIndex,
  pageSize,
  rowsOnPage,
  total,
  totalPages,
}: SessionsPaginationFooterInput): ReactNode {
  if (gridTableV2Enabled && total > 0) {
    return (
      <TablePaginationFooter
        className="sm:px-6"
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        page={pageIndex}
        pageSize={pageSize}
        readout={sessionsRangeReadout({
          isPlaceholderPage,
          pageIndex,
          pageSize,
          rowsOnPage,
          total,
        })}
        totalPages={totalPages}
      />
    );
  }
  if (!gridTableV2Enabled && totalPages > 1) {
    return (
      <TablePaginationFooter
        className="sm:px-6"
        onPageChange={onPageChange}
        page={pageIndex}
        totalPages={totalPages}
      />
    );
  }
  return null;
}

function applyProjectFacetGate(
  filters: SessionFacetFilters,
  projectFacetEnabled: boolean
): SessionFacetFilters {
  if (projectFacetEnabled) {
    return filters;
  }
  return {
    ...filters,
    projectIds: DEFAULT_SESSION_FACET_FILTERS.projectIds,
  };
}
