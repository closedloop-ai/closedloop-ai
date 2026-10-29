"use client";

import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import {
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import {
  BranchDetailTabParam,
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { OnboardingAnalyticsPageName } from "@repo/api/src/types/onboarding-analytics";
import { BranchesListSurfaceV2 } from "@repo/app/branches/components/branches-list-surface-v2";
import type { BranchesStallCta } from "@repo/app/branches/components/branches-stall-cta";
import type { BranchesToolbarProps } from "@repo/app/branches/components/branches-toolbar-model";
import { useBranchesBulkTagActions } from "@repo/app/branches/components/use-branches-bulk-tag-actions";
import {
  useBranchServedStatusOrderingReset,
  useUrlSyncedBranchFilterState,
  useUrlSyncedBranchServerState,
} from "@repo/app/branches/hooks/use-branch-filter-state";
import {
  useBranchSavedViews,
  useBranchSavedViewsStore,
} from "@repo/app/branches/hooks/use-branch-saved-views";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  useBranchCohortAnalytics,
  useBranchesPageData,
} from "@repo/app/branches/hooks/use-branches";
import { useBranchesCustomFieldsController } from "@repo/app/branches/hooks/use-branches-custom-fields-controller";
import {
  bindApprovedBranchCohortAnalyticsOverFilteredRows,
  bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort,
  buildApprovedBranchCohortRequest,
} from "@repo/app/branches/lib/approved-branch-cohort";
import {
  resolveBranchCohortEvaluationNow,
  resolveBranchCohortNotice,
} from "@repo/app/branches/lib/branch-cohort-transparency";
import { branchFiltersAreActive } from "@repo/app/branches/lib/branch-list-state";
import {
  branchListHasCompletePopulation,
  composeBranchResetView,
  isBranchPageDataPresentationPending,
  resolveBranchDisplayRows,
  resolveBranchPageState,
  selectPresentedBranchPageData,
  shouldUseBranchServerControls,
} from "@repo/app/branches/lib/branch-page-state";
import type {
  BranchRowSession,
  BranchRow as RenderBranchRow,
} from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import {
  buildBranchServerPageFilters,
  isBranchServerPageResponse,
} from "@repo/app/branches/lib/branch-server-page-query";
import type {
  BranchSortDir,
  BranchSortKey,
} from "@repo/app/branches/lib/branch-sort-group";
import { BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY } from "@repo/app/branches/lib/branches-partial-cohort-metrics-flag";
import { resolveBranchesStallCtaSignals } from "@repo/app/branches/lib/branches-stall-cta";
import {
  resolveBranchesSummaryErrored,
  resolveBranchesSummaryPending,
} from "@repo/app/branches/lib/branches-summary-state";
import { selectVisibleWireRows } from "@repo/app/branches/lib/filtered-branch-analytics";
import {
  useGitHubConnectAction,
  useGitHubConnectHrefTarget,
} from "@repo/app/github/hooks/use-github-connect-action";
import { usePostConnectBackfill } from "@repo/app/github/hooks/use-post-connect-backfill";
import { rumPeriodForRange } from "@repo/app/insights/lib/dashboard-range";
import {
  useFeatureFlagEnabled,
  useFeatureFlagGate,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import {
  LIST_LOADING_STALL_THRESHOLDS,
  useLoadingStall,
} from "@repo/app/shared/hooks/use-loading-stall";
import { useSharedTimezoneMode } from "@repo/app/shared/hooks/use-shared-timezone-mode";
import {
  ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStableDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { useBranchesListUnavailableMonitor } from "@/lib/branches/branches-list-unavailable-monitor";
import { useRumViewRange } from "@/lib/datadog-rum/view-range";
import { claimPostConnectBackfill } from "@/lib/github-post-connect-backfill";
import { WEB_BRANCH_METRIC_SPARKLINE } from "./branch-metric-sparkline-capability";

// Matches desktop's combined page-data cadence and the list's prior (pre-
// combined-read) 90s tuning — the analytics half no longer gets its own
// independent 30s staleTime now that both live behind one query.
const WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS = 90_000;

// Module-local e2e anchors. A Next.js App Router page module may only export the
// reserved page exports (`default`, `metadata`, …), so these stay non-exported;
// the specs that read them redeclare the same literals. ISS-4673 turned the
// scroll container from a `<main>` into a `<div>` (the shell's `SidebarInset`
// owns the page's single `<main>`), so `getByRole("main")` no longer resolves to
// it — `e2e/visual-regression.spec.ts` screenshots the scroll container by test
// id, and the list body is the FEA-4155 blank-body-guard anchor (mirroring
// Sessions' `sessions-history-list`), scoped so shell chrome cannot satisfy it.
const SCROLL_CONTAINER_TEST_ID = "branches-scroll-container";
const HISTORY_LIST_TEST_ID = "branches-history-list";

export default function BranchesPage() {
  // ISS-5574: name the tab for this surface. Off by default behind the shared
  // web+desktop flag; the desktop renderer titles the same route from the same key.
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? "Branches" : null);
  usePageViewedEvent(OnboardingAnalyticsPageName.Branches);
  return <BranchesPageContent />;
}

function BranchesPageContent() {
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const queryIdentity = useMemo(
    () => ({ cacheScope: `org:${orgSlug}` }),
    [orgSlug]
  );
  const {
    sortKey,
    sortDir,
    dateRange,
    isViewReady,
    visibleColumns,
    hiddenColumns,
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
    hiddenSummaryCards,
    toggleSummaryCard,
    ...groupViewSource
  } = useBranchViewState("branches:web", true);

  // ISS-9619: the reader's day boundary, and the ONE flag read behind it. With
  // the gate shut this is UTC with no setter, so the toolbar renders no control
  // and the window below is byte-identical to what shipped.
  const { timezoneMode, setTimezoneMode, isTimezoneModeReady } =
    useSharedTimezoneMode("branches:web");

  // ISS-7250: tag the RUM view with the selected window so page-load percentiles
  // are sliceable by route x range. Gated on the SAME `isViewReady` the read
  // below is (ISS-4655), not a second signal: until the persisted view restores,
  // `dateRange` is still the default, and tagging a saved-90d viewer's load `7`
  // buckets it under a window they never picked.
  useRumViewRange(isViewReady ? rumPeriodForRange(dateRange) : null);

  // ISS-9447 (review): the named saved-view COLLECTION, restored here rather
  // than at the `useBranchSavedViews` call below, because its
  // `isArrangementSettled` is a read gate and that call needs `filters` and
  // `handleFiltersChange`, which are derived from the very read it gates.
  const savedViewsStore = useBranchSavedViewsStore("branches:web", true);
  // ISS-9692: the URL still wins, but a visit that carries no `?pageSize=`
  // adopts the saved view's — so the choice survives navigating away and coming
  // back, not just a reload of the same link.
  const serverControls = useUrlSyncedBranchServerState({
    groupView: groupViewSource,
    isArrangementSettled: savedViewsStore.isArrangementSettled,
    isRestored: isViewReady,
    onPageSizePersist: setPageSize,
    persistedPageSize: savedPageSize,
  });
  // ISS-9437: the GATE form, not the plain read. `useFeatureFlagEnabled` reads
  // `false` while PostHog is still answering, which is indistinguishable from a
  // real "off" — so the client comparator sorted the corpus in vocabulary order
  // and re-sorted it under the reader when the assignment landed
  // (marisolashgrove review on #6928). `useBranchServedStatusOrderingReset` cannot
  // catch that one: `servedStatusOrdering` is null on the combined path.
  const statusOrderingGate = useFeatureFlagGate(
    ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY
  );
  const partialCohortMetricsEnabled = useFeatureFlagEnabled(
    BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY
  );
  // ISS-10301: the v2 surface owns the page size unconditionally. The fixed
  // `APPROVED_BRANCH_PAGE_SIZE` was the v1 shell's only page size, and v1 is gone.
  const branchPageSize = serverControls.pageSize;

  // The web list reads the bounded server-page request through the HTTP
  // BranchesDataSource. The producer receives the same window, filters, sort,
  // and page controls the desktop split-page source receives.
  // ISS-9619: ONE window for this surface, under the chosen boundary. Both the
  // bounded page read below and the summary/analytics reads take these same two
  // values, so the cards and the rows cannot describe different spans.
  const { startDate, endDate } = getStableDateWindowForRange(
    dateRange,
    timezoneMode
  );
  const pageDataFilters = useMemo(
    () =>
      buildBranchServerPageFilters({
        filters: serverControls.filters,
        page: serverControls.page,
        pageSize: branchPageSize,
        sortKey,
        sortDir,
        startDate,
        endDate,
      }),
    [
      endDate,
      branchPageSize,
      serverControls.filters,
      serverControls.page,
      sortDir,
      sortKey,
      startDate,
    ]
  );
  // Combined list + analytics read (FEA-3056 follow-up): the page mounts the
  // table and the summary cards together, so one query shares one underlying
  // read instead of each independently re-fetching.
  const {
    data: pageData,
    isPending,
    isError,
    error: listError,
    isPlaceholderData,
    refetch,
    analyticsPending,
    analyticsError,
    refetchAnalytics,
    servedStatusOrdering,
  } = useBranchesPageData(
    pageDataFilters,
    {
      // ISS-4655: hold the read until the persisted view has restored. The
      // window is part of the query key, and before the restore it is still the
      // 30d default — a user whose saved range differs paginated the whole
      // corpus against that default and then paginated it again, with the first
      // run unrecoverable under its own key. Fails OPEN on a stalled auth
      // hydration (see `VIEW_RESTORE_AUTH_DEADLINE_MS`), so the table degrades
      // to the pre-gate double read rather than to a permanent skeleton.
      // ISS-9692 (whitlockk review): `isReadReady` folds `isViewReady` together with
      // the page-size gate. `isViewReady` alone opened this read on the render
      // the saved 500 was still resolving, so the first page came back at the
      // default and was replaced. Composed in the hook so desktop reads the
      // same answer.
      // ISS-9437: `statusOrderingGate.isReady` joins the wait so no row can
      // exist before the order to sort it in does, bounded by the same
      // `FEATURE_FLAG_RESOLUTION_DEADLINE_MS` — so a flag-service outage still
      // degrades to the vocabulary-ordered table rather than a skeleton.
      // ISS-9619 (whitlockk + codex review): and on the day-boundary gate. An
      // unresolved assignment reads as UTC, so a reader whose stored mode is
      // `local` fetched this page against the UTC window and refetched it under
      // the Local one the moment PostHog answered — the same double read, and
      // the same transiently-wrong population, the two gates above already wait
      // out. Settles from the same PostHog answer and under the same
      // `FEATURE_FLAG_RESOLUTION_DEADLINE_MS`, so it adds no new way to stall.
      enabled:
        serverControls.isReadReady &&
        statusOrderingGate.isReady &&
        isTimezoneModeReady,
      staleTime: WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS,
      refetchOnWindowFocus: true,
      // Keep the previous window's rows on screen while an uncached date
      // range loads, instead of blanking the table via isPending on every
      // switch (the list used to be windowed client-side over a single
      // startDate-independent fetch, so this never flashed pre-combined-read).
      placeholderData: keepPreviousData,
    },
    queryIdentity
  );
  const presentedPageData = selectPresentedBranchPageData(pageData, {
    isPlaceholderData,
    isViewReady,
  });
  const pageDataPresentationPending = isBranchPageDataPresentationPending({
    isPending,
    isPlaceholderData,
    isError,
    isViewReady,
    pageData,
  });
  const data = presentedPageData?.list;
  const serverPageActive = isBranchServerPageResponse(data);
  const serverControlsActive = shouldUseBranchServerControls(
    isPending,
    isPlaceholderData,
    serverPageActive
  );
  // ISS-10350 (codex review): the REQUEST clock is retired, but the producer
  // still stamps its own instant on the RESPONSE. Judge rows against that, not
  // the viewer's browser clock — a system clock trailing the API's makes a
  // genuinely recent `lastActivityAt` look like a future timestamp, which the
  // adapter drops to an em-dash and the last-active facets then exclude.
  const evaluationNow = useMemo(
    () =>
      resolveBranchCohortEvaluationNow(
        data?.lastActiveCohort?.evaluationNow,
        data?.pageInfo?.now
      ),
    [data]
  );
  const rows = useMemo(
    () =>
      adaptBranchRows(data?.items ?? [], {
        now: evaluationNow,
        preferCanonicalLastActive: true,
      }),
    [data, evaluationNow]
  );

  // ISS-9437: ONE read of the key on this surface, resolved straight into a
  // whole ordering. Nothing downstream sees the boolean — the client comparator
  // takes the shape, so the flag picks between two orderings rather than
  // steering several derivations that could settle at different moments.
  const statusOrdering =
    statusOrderingGate.isReady && statusOrderingGate.enabled
      ? ROOT_FIRST_BRANCH_STATUS_ORDERING
      : DEFAULT_BRANCH_STATUS_ORDERING;
  // ISS-9437: the producer decides the order of a SERVER page, so when it
  // changes the one it serves, the reader's offset names a slice of a different
  // list. Reset to the first page rather than leave them somewhere arbitrary.
  useBranchServedStatusOrderingReset(
    servedStatusOrdering,
    serverControls.setPage
  );

  // Every branch class (merged, agent-worktree, bot) remains eligible. The
  // complete-list fallback applies the window locally; server-page producers
  // return rows already narrowed for the requested window.
  const { visibleRows, sortedRows } = useMemo(
    () =>
      resolveBranchDisplayRows(rows, {
        serverPageActive,
        startDate,
        endDate,
        sortKey,
        sortDir,
        statusOrdering,
      }),
    [
      endDate,
      rows,
      serverPageActive,
      sortDir,
      sortKey,
      startDate,
      statusOrdering,
    ]
  );

  // FEA-3560: seed-from-URL + URL write-through live inside the hook, shared
  // with the desktop Branches view so the glue can't drift per surface.
  const legacyState = useUrlSyncedBranchFilterState(
    sortedRows,
    branchPageSize,
    true,
    evaluationNow,
    serverControls.writeViewParams
  );
  const {
    filters,
    page,
    setPage,
    filteredRows,
    pagedRows,
    total,
    totalPages,
    pageSize: resolvedPageSize,
    handleFiltersChange,
    handleGroupingChange,
    handleCollapsedGroupsChange,
  } = resolveBranchPageState({
    serverPageActive,
    serverControlsActive,
    server: serverControls,
    legacy: legacyState,
    data,
    rows,
    pageSize: branchPageSize,
  });
  const hasCompletePopulation = branchListHasCompletePopulation(data);
  const cohortNotice = useMemo(
    () =>
      resolveBranchCohortNotice({
        rows: filteredRows,
        total,
        hasData: presentedPageData !== undefined,
        hasFiniteWindow: startDate !== undefined,
        isPlaceholderData,
        placeholderFailed: isPlaceholderData && isError,
        completeCorpus: hasCompletePopulation,
        renderNow: evaluationNow,
        cohortKey: branchListCohortKey(pageDataFilters),
        producerCohort: data?.lastActiveCohort,
      }),
    [
      data,
      evaluationNow,
      filteredRows,
      hasCompletePopulation,
      isError,
      isPlaceholderData,
      pageDataFilters,
      presentedPageData,
      startDate,
      total,
    ]
  );

  // FEA-4180: named saved views (order + visibility + sort + filters). Captures
  // the current live arrangement and applies a switched view back onto both the
  // view-state hook (sort/window/columns) and the filter-state hook (facets, via
  // the URL-mirroring `handleFiltersChange`). Keyed to the web surface.
  const savedViews = useBranchSavedViews(
    savedViewsStore,
    {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns,
      columnOrder,
      // ISS-9447 M5: the saved-view store captures the same widths and
      // rows-per-page the single live view already persisted. `savedPageSize`,
      // not `branchPageSize` — the reader's stored CHOICE, so a view captured
      // while the ladder flag is off still records what they picked rather than
      // the flag-resolved page size they happen to be looking at.
      columnWidths,
      pageSize: savedPageSize,
      filters,
      grouping: serverControls.grouping,
      collapsedGroups: serverControls.collapsedGroups,
    },
    {
      applyArrangement: serverControls.applyArrangement,
      applyFilters: handleFiltersChange,
    }
  );

  const filteredWireRows = useMemo(
    () => selectVisibleWireRows(data?.items ?? [], filteredRows),
    [data?.items, filteredRows]
  );
  const unfilteredWireRows = useMemo(
    () => selectVisibleWireRows(data?.items ?? [], visibleRows),
    [data?.items, visibleRows]
  );
  // ISS-8127 (davetho review): `isViewReady` settles when the view-state
  // extras restore, which knows nothing about a NAMED active view — that
  // arrangement, `dateRange` included, is pushed on one commit later by
  // `useBranchSavedViews`. Gating only the presentation left that window open,
  // so a warm cache could still reach the producer under the pre-application
  // range. A null request is the surface's existing "no cohort yet" state.
  const cohortArrangementSettled = savedViews.isArrangementSettled;
  const cohortRequest = useMemo(
    () =>
      serverPageActive || !cohortArrangementSettled
        ? null
        : buildApprovedBranchCohortRequest({
            filteredRows: filteredWireRows,
            unfilteredRows: unfilteredWireRows,
            filters,
            dateRange,
            startDate,
            endDate,
          }),
    [
      filteredWireRows,
      unfilteredWireRows,
      filters,
      dateRange,
      startDate,
      endDate,
      serverPageActive,
      cohortArrangementSettled,
    ]
  );
  const {
    data: cohortResponse,
    isError: cohortIsError,
    isPending: cohortIsPending,
    refetch: refetchCohort,
  } = useBranchCohortAnalytics(
    cohortRequest,
    {
      enabled: presentedPageData?.analytics !== undefined,
      refetchOnWindowFocus: true,
      staleTime: WEB_BRANCHES_PAGE_DATA_STALE_TIME_MS,
    },
    queryIdentity
  );

  // ISS-5253: the approved cards read canonical current/prior metrics for the
  // exact date-windowed, facet-filtered Branch IDs before pagination. A missing
  // or mismatched producer response retains only row-provable values and never
  // substitutes whole-list Session spend for the selected cohort.
  const filteredAnalytics = useMemo(() => {
    if (serverPageActive) {
      return {
        analytics: presentedPageData?.analytics,
        comparisonSuppressedByFilter: false,
      };
    }
    // The gate is read once above and picks a WHOLE binder HERE, at the read
    // site: the binders never learn a flag exists, and no helper takes one as a
    // parameter (root AGENTS.md, "One read site per feature flag" — the
    // receiving half, which the gate cannot see).
    const bind = partialCohortMetricsEnabled
      ? bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort
      : bindApprovedBranchCohortAnalyticsOverFilteredRows;
    return bind({
      analytics: presentedPageData?.analytics,
      filteredRows: filteredWireRows,
      unfilteredRows: unfilteredWireRows,
      filters,
      sessionCostUsd: data?.sessionCostUsd,
      request: cohortRequest,
      response: cohortResponse,
    });
  }, [
    presentedPageData?.analytics,
    filteredWireRows,
    unfilteredWireRows,
    filters,
    data?.sessionCostUsd,
    cohortRequest,
    cohortResponse,
    serverPageActive,
    partialCohortMetricsEnabled,
  ]);

  // FEA-4177: the analytics half is best-effort — when only it fails the combined
  // read still resolves the list (`isError` stays false so the table renders) and
  // flags `analyticsError`. Surface that as the summary cards' own error so they
  // degrade to "Unavailable" while the table keeps rendering. Guard on missing
  // analytics so a partial resolve never renders stale-zero KPIs.
  // ANALYTICS-only: this is what drives the analytics error strip and its Retry,
  // which must not appear for a list failure.
  const summaryAnalyticsErrored = resolveBranchesSummaryErrored({
    analyticsError,
    cohortErrored: cohortRequest !== null && cohortIsError,
    listError: false,
    pageDataAnalyticsError: presentedPageData?.analyticsError === true,
  });
  // What the CARDS answer to. Both halves, because a failure in either stops the
  // summary being refreshed — routing only the analytics half through the
  // lifecycle dashed a payload we were holding while the line above it said the
  // figures were on screen and refreshing.
  const summaryCardsErrored = resolveBranchesSummaryErrored({
    analyticsError,
    cohortErrored: cohortRequest !== null && cohortIsError,
    listError: isError,
    pageDataAnalyticsError: presentedPageData?.analyticsError === true,
  });
  const summaryAnalyticsPending = resolveBranchesSummaryPending({
    analyticsPending,
    // The un-settled arrangement counts as PENDING, not as "no cohort asked
    // for": with the request withheld the cards would otherwise fall through to
    // row-provable values for a commit and flash a number built from the
    // pre-application window — the same lie in a shorter frame (ISS-8127).
    // Scoped to the cohort path; the server-page path reads page analytics and
    // never builds a cohort request at all.
    cohortPending:
      !(serverPageActive || cohortArrangementSettled) ||
      (cohortRequest !== null && cohortIsPending),
    listPending: pageDataPresentationPending,
    hasData: data !== undefined,
  });
  const handleSort = (column: string, direction: SortDirection) => {
    setSort(column as BranchSortKey, direction as BranchSortDir);
    serverControls.setPage(0);
  };

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    legacyState.setPage(0);
    serverControls.setPage(0);
  };

  const handlePageSizeChange = (nextPageSize: number) => {
    serverControls.setPageSize(nextPageSize);
    legacyState.setPage(0);
  };

  useEffect(() => {
    if (!(serverPageActive && data?.pageInfo) || isPlaceholderData) {
      return;
    }
    const repairedPage = data.pageInfo.offset / data.pageInfo.limit;
    if (repairedPage !== serverControls.page) {
      serverControls.setPage(repairedPage);
    }
  }, [data?.pageInfo, isPlaceholderData, serverControls, serverPageActive]);

  const getBranchHref = (item: RenderBranchRow) =>
    `/${orgSlug}/branches/${item.id}`;
  // FEA-4259: the Linked Sessions count links to the branch detail's Sessions
  // tab (which lists exactly that branch's sessions). The org-relative path +
  // `?tab=` is built by the notification-route SSOT so the tab literal can never
  // drift from the value the detail route reads; the web shell prefixes `/org`.
  const getSessionsHref = (item: RenderBranchRow) =>
    `/${orgSlug}${getNotificationEntityPath({
      kind: NotificationEntityKind.Branch,
      branchId: item.id,
      tab: BranchDetailTabParam.SessionsTimeline,
    })}`;
  // ISS-8972: a Linked Sessions CHIP opens that Session's OWN detail — unlike
  // the count chip beside it, which opens the branch's Sessions tab. Built from
  // the same notification-route SSOT so the path cannot drift from the one the
  // session detail route reads, and org-prefixed like every other web route here.
  const getSessionHref = (session: BranchRowSession) =>
    `/${orgSlug}${getNotificationEntityPath({
      kind: NotificationEntityKind.Session,
      sessionId: session.navigableRef,
    })}`;
  const connectHref = useGitHubAuthorizeHref({
    returnTo: `/${orgSlug}/branches`,
  });
  const githubStatus = searchParams.get("github");
  // ISS-9429: the ONE narrowing signal both hosts pass. Web used to pass a bare
  // `rows.length > 0`, so a filtered-away result on the all-time range rendered
  // "No branches yet" over a populated org; desktop corrected it with a private
  // helper web could not reach. The correction now lives in one place.
  const hasActiveFilters = branchFiltersAreActive(filters);
  // ISS-9725: a failed list read reaches the client monitoring path instead of
  // being visible only as `isError` on screen. Same signals the body branches
  // on, so the record cannot describe a screen other than the one drawn.
  useBranchesListUnavailableMonitor({
    hasActiveFilters,
    hasWindow: startDate !== undefined,
    isError,
    isPending: pageDataPresentationPending,
    listError,
    visibleRowCount: pagedRows.length,
  });
  // ISS-5958 D1/D2: a web `(authenticated)` route always has a session behind
  // it, so this CTA is never a sign-up — only whether the user's OWN grant is
  // what broke changes the verb. Read unconditionally, not gated on whether the
  // CTA renders: those are the same instant, so a gate would paint the
  // first-time verb and swap it to `Reconnect` a roundtrip later, which is the
  // D2 collapse arriving late (decided 2026-08-21).
  const githubConnect = useGitHubConnectHrefTarget({
    authenticated: true,
    href: connectHref,
  });
  // ISS-10645: the RAW action, which `githubConnect.action` cannot report — it
  // floors `null` to a first-time connect so a rendered CTA always has a verb,
  // which is right for wording and wrong for gating. Same query key as the
  // target above, so this is one cached status read rather than a second source.
  const githubConnectAction = useGitHubConnectAction(true);
  // No `createAccountAction` is threaded: this listing lives in the Clerk
  // `(authenticated)` group, so `authenticated: true` above is a fact about the
  // route and the action can never resolve to `SignUp` — the sign-up arm is
  // unreachable here by construction rather than by omission.
  const stallCta: BranchesStallCta = {
    githubConnect,
    signals: resolveBranchesStallCtaSignals(githubConnectAction),
  };

  // Elapsed loading time may reveal the account CTA, never a pending Retry.
  const [stallRetryToken, setStallRetryToken] = useState(0);
  const bulkActions = useBranchesBulkTagActions(pagedRows);
  // ISS-12663: the org custom-field columns, read off the rows on this page.
  const customFields = useBranchesCustomFieldsController(pagedRows);
  const retryInFlight = useRef<Promise<unknown> | null>(null);
  const handleRetry = () => {
    if (retryInFlight.current) {
      return retryInFlight.current;
    }
    if (pageDataPresentationPending) {
      return Promise.resolve();
    }
    setStallRetryToken((token) => token + 1);
    const pending = Promise.resolve().then(() => refetch());
    retryInFlight.current = pending;
    return pending.finally(() => {
      retryInFlight.current = null;
    });
  };
  const stallPhase = useLoadingStall(
    pageDataPresentationPending,
    LIST_LOADING_STALL_THRESHOLDS,
    stallRetryToken
  );

  const handleSummaryRetry = () => {
    return Promise.all([refetchAnalytics(), refetchCohort()]).catch(
      () => undefined
    );
  };

  // ISS-7338's claim is threaded in rather than held in a ref: a remount must
  // not re-fire the Apply run, and only a document navigation — how every real
  // reconnect arrives — clears it.
  const claimBackfillStart = useCallback(
    () => claimPostConnectBackfill(orgSlug),
    [orgSlug]
  );
  usePostConnectBackfill({
    claimStart: claimBackfillStart,
    enabled: githubStatus === GitHubConnectReturnStatus.Connected,
  });

  // ISS-9225: ONE set of toolbar arguments for both rollout branches. The v1
  // toolbar renders them directly; the v2 list surface renders its own
  // `BranchesListToolbarV2` from the same object, so the two cannot be handed
  // different filters, columns or saved views.
  const toolbarProps: BranchesToolbarProps = {
    approved: true,
    dateRange,
    facets: serverPageActive ? data?.facets : undefined,
    filters,
    hiddenSummaryCards,
    now: evaluationNow,
    onDateRangeChange: handleDateRangeChange,
    onFiltersChange: handleFiltersChange,
    onResetView: composeBranchResetView(resetView, {
      handleCollapsedGroupsChange,
      handleGroupingChange,
    }),
    onTimezoneModeChange: setTimezoneMode,
    onToggleColumn: toggleColumn,
    onToggleSummaryCard: toggleSummaryCard,
    rows: visibleRows,
    timezoneMode,
    visibleColumns,
  };
  const summaryBandProps = {
    cohortNotice,
    comparisonSuppressedByFilter:
      filteredAnalytics.comparisonSuppressedByFilter,
    githubReturnStatus: githubStatus,
    onSummaryRetry: handleSummaryRetry,
    summaryAnalyticsErrored,
    summaryCards: filteredAnalytics.analytics,
    summaryCardsErrored,
    summaryCardsPending: summaryAnalyticsPending,
    summaryCardsReloading: isPlaceholderData,
    // ISS-10544: this shell's own answer, and it is unconditional — the trend
    // sparkline graduated on web (operator ruling, 2026-09-17).
    trendSparkline: WEB_BRANCH_METRIC_SPARKLINE,
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      <Header breadcrumbs={[{ label: "Branches" }]} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <BranchesListSurfaceV2
          allRows={filteredRows}
          bulkActions={bulkActions}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          collapsedGroups={serverControls.collapsedGroups}
          columnOrder={columnOrder}
          columnWidths={columnWidths}
          customFields={customFields}
          getBranchHref={getBranchHref}
          getSessionHref={getSessionHref}
          getSessionsHref={getSessionsHref}
          grouping={serverControls.grouping}
          hasActiveFilters={hasActiveFilters}
          hasCompletePopulation={hasCompletePopulation}
          hasWindow={startDate !== undefined}
          historyListTestId={HISTORY_LIST_TEST_ID}
          includePriorityColumn
          includeProjectColumn
          includeTagsColumn
          isError={isError}
          isPending={pageDataPresentationPending}
          isPlaceholderData={isPlaceholderData}
          items={pagedRows}
          onCollapsedGroupsChange={handleCollapsedGroupsChange}
          onColumnOrderChange={setColumnOrder}
          onColumnWidthChange={setColumnWidth}
          onGroupingChange={handleGroupingChange}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
          onRetry={handleRetry}
          onShowAllTime={() => handleDateRangeChange("all")}
          onSort={handleSort}
          page={page}
          pageSize={resolvedPageSize}
          sortBy={sortKey}
          sortDir={sortDir}
          stallCta={stallCta}
          stallPhase={stallPhase}
          {...summaryBandProps}
          tableScrollAttributes={{
            "aria-label": "Branches",
            role: "region",
            tabIndex: 0,
          }}
          tableScrollTestId={SCROLL_CONTAINER_TEST_ID}
          toolbar={toolbarProps}
          total={total}
          totalPages={totalPages}
          visibleColumns={visibleColumns}
        />
      </div>
    </div>
  );
}
