import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import {
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import { BranchesListSurfaceV2 } from "@repo/app/branches/components/branches-list-surface-v2";
import type { BranchesStallCta } from "@repo/app/branches/components/branches-stall-cta";
import type { BranchesToolbarProps } from "@repo/app/branches/components/branches-toolbar-model";
import { useBranchesBulkTagActions } from "@repo/app/branches/components/use-branches-bulk-tag-actions";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { useBranchesDataSource } from "@repo/app/branches/data-source/provider";
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
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import type { BranchAppliedArrangement } from "@repo/app/branches/lib/branch-saved-views";
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
  useFeatureFlagEnabled,
  useFeatureFlagGate,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import { useSharedTimezoneMode } from "@repo/app/shared/hooks/use-shared-timezone-mode";
import { ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStableDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { keepPreviousData } from "@tanstack/react-query";
import { Profiler, useCallback, useEffect, useMemo, useRef } from "react";
import { RendererRenderView } from "../../../shared/render-commit-event";
import { useDesktopBranchMetricSparkline } from "../../feature-flags/use-desktop-branch-metric-sparkline";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useOnlineStatus } from "../../shared-agent-sessions/use-online-status";
import {
  desktopBranchDetailHref,
  desktopBranchSessionChipHref,
  desktopBranchSessionsHref,
} from "../../shared-branches/branch-hrefs";
import { DesktopBranchesSource } from "../../shared-branches/desktop-branches-source";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { DesktopGitHubConnectSurface } from "../../shared-branches/desktop-github-connect-copy";
import {
  resolveBranchesListCause,
  useRenderCommitInstrumentation,
} from "../sessions/use-render-commit-instrumentation";
import { BranchesStallAccountCta } from "./branches-stall-account-cta";
import { branchesSummaryConnectAsk } from "./branches-summary-connect-ask";
import { useBranchesListDeadEndTelemetry } from "./use-branches-dead-end-telemetry";
import { useBranchesListRecovery } from "./use-branches-list-recovery";
import { useDesktopBranchesCustomFieldsController } from "./use-desktop-branches-custom-fields-controller";
import { useDesktopGitHubConnect } from "./use-desktop-github-connect";

/**
 * Branches view — desktop counterpart of the web `/branches` page, rendering
 * the shared `BranchesListSurfaceV2` from the `@repo/app`
 * branches slice so both surfaces stay identical (PRD-454). Rows come from
 * `useBranchesPageData()` (the authenticated canonical cloud source or the
 * signed-out local `BranchesDataSource`, combined list + analytics read —
 * FEA-3056 follow-up) mapped through
 * `adaptBranchRows` into the render row shape the scaffold expects.
 *
 * Auth-driven source selection (PLN-1138 D-E / Phase 2) lives in
 * `DesktopBranchesSource`: a complete authenticated identity keeps the org
 * cloud source across connectivity changes so a matching canonical cache can
 * remain readable; an uncached offline read pauses. Signed-out or incomplete
 * identity reads the local SQLite source. Desktop asks split-capable cloud
 * producers for one exact Branches page; local producers keep the combined
 * complete-list IPC read so their pre-pagination cohort cards stay exact.
 *
 * Layout: a first-class time window + filter toolbar on top, then the summary
 * cards (which reflect the window), then the table.
 */

// Five summary cards (vs the Sessions view's four), so a five-column top end
// instead of DASHBOARD_GRID_CLASS_NAME's four. Five is odd, so a two-column
// tier reflows to 2+2+1 and orphans the last card (Median PR size) at half
// width with an empty cell beside it (FEA-2935).
//
// ISS-4787 follow-up: the pinned `lg:3 → xl:5` tiers that replaced it are gone
// too — the column count is DERIVED from the shared `--summary-card-min` floor,
// which self-limits at every width and can never squeeze a card under the width
// the strip's two-line label reservation assumes. The Sessions strip one nav click
// away lays out from the same floor, so the two desktop summary strips keep the
// same card rhythm.
//
// Stage review: an earlier version of this note claimed "the web twin already
// derives its columns from the same floor". That is true of web SESSIONS and NOT
// of web BRANCHES — `apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx`
// still pins `grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5` over an 11rem
// per-card floor. Bringing that page onto this floor is tracked separately and
// is deliberately not folded in here rather than being claimed as already done.
const DESKTOP_BRANCHES_LIST_STALE_TIME_MS = 90_000;
const DESKTOP_BRANCHES_SCROLL_CONTAINER_TEST_ID = "branches-scroll-container";
const DESKTOP_BRANCHES_HISTORY_LIST_TEST_ID = "branches-history-list";

export function BranchesView({
  dataSource,
  isActive = true,
}: {
  /** Test seam; production selects local vs cloud by mode (DesktopBranchesSource). */
  dataSource?: BranchesDataSource;
  /**
   * Whether this view is the page the shell has committed to. Branches is kept
   * mounted across navigation (`shouldKeepNavMounted`), so dead-end telemetry
   * must not report a treatment that came up behind a hidden panel.
   */
  isActive?: boolean;
} = {}) {
  return (
    <DesktopBranchesSource override={dataSource}>
      <BranchesViewContent isActive={isActive} />
    </DesktopBranchesSource>
  );
}

function BranchesViewContent({ isActive }: { isActive: boolean }) {
  const isOnline = useOnlineStatus();
  // Read unconditionally, not gated on whether the stalled-load slot ends up
  // asking: those are the same instant, so a gate would paint the first-time
  // verb and swap it to `Reconnect` a roundtrip later (decided 2026-08-21).
  const {
    connectAction: githubConnectAction,
    connectState,
    connectTarget: githubConnect,
  } = useDesktopGitHubConnect("/branches");
  const { dateRange, setDateRange } = useSharedDateRange("desktop");
  const trendSparkline = useDesktopBranchMetricSparkline();
  // ISS-9619: the same surface key the range above uses, so this shell's two
  // lists keep agreeing about the window the way they already do. One flag read;
  // shut, it is UTC with no setter and the toolbar grows no control.
  const { timezoneMode, setTimezoneMode, isTimezoneModeReady } =
    useSharedTimezoneMode("desktop");
  const {
    sortKey,
    sortDir,
    visibleColumns,
    hiddenColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    pageSize: savedPageSize,
    setPageSize,
    setSort,
    toggleColumn,
    resetView,
    hiddenSummaryCards,
    toggleSummaryCard,
    isViewReady,
    ...groupViewSource
  } = useBranchViewState("desktop", true);
  // ISS-9447 (review): the named saved-view COLLECTION, restored here rather
  // than at the `useBranchSavedViews` call below, for the reason the web page
  // gives — `isArrangementSettled` gates the read that call's inputs come from.
  const savedViewsStore = useBranchSavedViewsStore("desktop", true);
  const dataSource = useBranchesDataSource();
  const splitPageDataSupported = dataSource.supportsSplitPageData === true;
  // ISS-10332 (#7762 review): the Priority column's opt-in is the data-source
  // seam, as on Sessions. Cloud mode's HTTP source writes priority, and so
  // does the local store (PLN-2086 Milestone 3) when its preload offers it.
  const showPriorityColumn = dataSource.updatePriority !== undefined;
  // ISS-12456: Tags is a cloud-Artifact concept — the tag picker writes
  // against `item.artifactId`, which local rows never carry — so the column's
  // opt-in mirrors Priority's, keyed on the data source rather than per row.
  const showTagsColumn = dataSource.supportsTags === true;
  // ISS-12456: same reasoning as Tags — Project is also a cloud-Artifact
  // concept local rows carry no identity for.
  const showProjectColumn = dataSource.supportsProject === true;
  // ISS-9692: the URL still wins, but a visit that carries no `?pageSize=`
  // adopts the saved view's — so the choice survives navigating away and coming
  // back, not just a reload of the same link.
  const serverControls = useUrlSyncedBranchServerState(
    {
      groupView: groupViewSource,
      isArrangementSettled: savedViewsStore.isArrangementSettled,
      isRestored: isViewReady,
      onPageSizePersist: setPageSize,
      persistedPageSize: savedPageSize,
    },
    showTagsColumn
  );
  const partialCohortMetricsEnabled = useFeatureFlagEnabled(
    BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY
  );
  // ISS-9437: the GATE form, for the same reason the web page uses it
  // (marisolashgrove review on #6928). The desktop adapter reports real
  // settled-ness — `DesktopPostHogFlagAssignment.resolved` — so `false` here
  // means "not answered yet" just as often as it means "off", and acting on it
  // sorted the table in vocabulary order and re-sorted it when the account's
  // assignment arrived.
  const statusOrderingGate = useFeatureFlagGate(
    ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY
  );
  const branchPageSize = serverControls.pageSize;
  // Desktop requests the same bounded server page the API validates for the
  // cloud path. Local producers keep the complete-list client pipeline.
  // ISS-9619: ONE window under the chosen boundary, feeding both the bounded
  // page request and the summary reads, so rows and cards cannot disagree.
  const { startDate, endDate } = getStableDateWindowForRange(
    dateRange,
    timezoneMode
  );
  const pageDataFilters = useMemo(
    () =>
      splitPageDataSupported
        ? buildBranchServerPageFilters({
            filters: serverControls.filters,
            page: serverControls.page,
            pageSize: branchPageSize,
            sortKey,
            sortDir,
            startDate,
            endDate,
          })
        : {
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
          },
    [
      endDate,
      branchPageSize,
      serverControls.filters,
      serverControls.page,
      splitPageDataSupported,
      sortKey,
      sortDir,
      startDate,
    ]
  );
  // Combined list + analytics read (FEA-3056 follow-up): the Branches screen
  // mounts the table and the summary cards together, so one query shares one
  // underlying read instead of each independently re-scanning the same rows.
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
  } = useBranchesPageData(pageDataFilters, {
    // ISS-9692 (whitlockk review): hold the read until the saved view has restored
    // AND `table-page-size-ladder` has answered — the two inputs that decide the
    // `limit` this request carries. Ungated, desktop issued the default-size
    // request first (earlier than web, which already held on `isViewReady`) and
    // replaced it once the remembered 500 arrived. The composition lives in the
    // hook so this shell and the web page cannot answer it differently.
    //
    // ISS-9725: and on `isActive`, the ISS-8055 gate `SessionsView` already
    // applies (`canReadPageData`). Branches is kept mounted across navigation,
    // so ungated it polled the cloud behind a hidden panel — which is not just
    // wasted work now that the surface reports dead ends. `useDeadEndTelemetry`
    // deliberately leaves its dedupe key untouched while hidden, so a read that
    // recovered and re-failed out of sight would come back carrying the key
    // already emitted, and the treatment the reader is actually looking at
    // would be suppressed as a duplicate. Freezing the read while hidden is
    // what makes the record honest, not merely cheaper.
    // ISS-9437: no row exists before the status ordering this request carries
    // has settled. The desktop assignment resolves once per account and every
    // terminal non-answer (signed out, offline, no bridge) settles as
    // `resolved: true`, so this waits on a live fetch only on the first
    // Branches mount after sign-in, and
    // `FEATURE_FLAG_RESOLUTION_DEADLINE_MS` bounds even that.
    // ISS-9619 (whitlockk + codex review): and on the day-boundary gate. An
    // unresolved assignment reads as UTC, so a reader whose stored mode is
    // `local` read this page against the UTC window and refetched it under the
    // Local one once the account's assignment arrived — the same double read the
    // two gates above already wait out, settling from the same answer.
    enabled:
      serverControls.isReadReady &&
      isActive &&
      statusOrderingGate.isReady &&
      isTimezoneModeReady,
    // FEA-4177: the combined query only errors when the LIST half fails (the
    // analytics half is best-effort — see `BranchesPageData`), so `isError` drives
    // the table alone. The summary cards get their own error below so an
    // analytics-only failure degrades the cards without blanking the table.
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCHES_LIST_STALE_TIME_MS,
    // Keep the previous window's rows on screen while an uncached date range
    // loads, instead of blanking the table via isPending on every switch.
    placeholderData: keepPreviousData,
  });
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

  // Every row links into the branch-detail route (`/branches/:id`); the port
  // Link renders it hash-prefixed for the browser-deferred click paths.
  const getBranchHref = desktopBranchDetailHref;
  // FEA-4259: the Linked Sessions count links to the branch detail's Sessions
  // tab (`/branches/:id?tab=sessions-timeline`), which lists exactly that
  // branch's sessions.
  const getSessionsHref = desktopBranchSessionsHref;
  // ISS-8972: a Linked Sessions CHIP opens that Session's OWN detail — unlike
  // the count chip beside it, which opens this branch's Sessions tab.
  const getSessionHref = desktopBranchSessionChipHref;

  // ISS-9437: ONE read of the key on this surface — the SAME PostHog key the
  // web page reads, resolved from the signed-in account's assignment — turned
  // straight into a whole ordering. Nothing downstream sees the boolean.
  const statusOrdering =
    statusOrderingGate.isReady && statusOrderingGate.enabled
      ? ROOT_FIRST_BRANCH_STATUS_ORDERING
      : DEFAULT_BRANCH_STATUS_ORDERING;
  // ISS-9437: a producer that changes the order it serves has re-partitioned
  // every page, so the reader's offset now names a different slice. Absent on
  // the local desktop source, which issues no evaluation clock — that is the
  // no-reset case, not a missing one.
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
  // with the web Branches page so the glue can't drift per surface.
  const legacyState = useUrlSyncedBranchFilterState(
    sortedRows,
    branchPageSize,
    true,
    evaluationNow,
    serverControls.writeViewParams,
    showTagsColumn
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
  const bulkActions = useBranchesBulkTagActions(pagedRows, !isOnline);
  // ISS-12663: custom-field columns read the cloud rows' values; local rows
  // carry none, so the controller stays off outside cloud mode.
  const isCloudMode = useDesktopAppCoreMode() === DesktopAppCoreMode.Cloud;
  const customFields = useDesktopBranchesCustomFieldsController(
    isCloudMode,
    pagedRows
  );
  const legacyTotalPages = legacyState.totalPages;
  const setLegacyPage = legacyState.setPage;
  const legacyUrlPageAppliedRef = useRef(false);
  useEffect(() => {
    if (
      legacyUrlPageAppliedRef.current ||
      serverPageActive ||
      pageDataPresentationPending ||
      isError ||
      isPlaceholderData ||
      serverControls.page <= 0
    ) {
      return;
    }
    if (legacyTotalPages <= 1) {
      return;
    }
    legacyUrlPageAppliedRef.current = true;
    setLegacyPage(Math.min(serverControls.page, legacyTotalPages - 1));
  }, [
    isError,
    isPlaceholderData,
    legacyTotalPages,
    pageDataPresentationPending,
    serverControls.page,
    serverPageActive,
    setLegacyPage,
  ]);
  // Column-header clicks set both the sort key and direction.
  const handleSort = (column: string, direction: SortDirection) => {
    setSort(column as BranchSortKey, direction as BranchSortDir);
    legacyState.setPage(0);
    serverControls.setPage(0);
  };
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

  // FEA-4180: named saved views (order + visibility + sort + filters). On
  // desktop the time window lives in the SHARED cross-view store
  // (`useSharedDateRange`), not the view-state extras — so applying a switched
  // view routes its `dateRange` through the shared `setDateRange` while sort +
  // columns + order go through `applyArrangement`. Capture reads the same shared
  // `dateRange`, so a saved-then-switched view round-trips the window too.
  const { applyArrangement } = serverControls;
  const applySavedArrangement = useCallback(
    (arrangement: BranchAppliedArrangement) => {
      applyArrangement(arrangement);
      setDateRange(arrangement.dateRange);
    },
    [applyArrangement, setDateRange]
  );
  const savedViews = useBranchSavedViews(
    savedViewsStore,
    {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns,
      columnOrder,
      // ISS-9447 M5: captured here for the same reason as on web, and from the
      // same two hook values, so the two shells cannot record different views of
      // the same gesture.
      columnWidths,
      pageSize: savedPageSize,
      filters,
      grouping: serverControls.grouping,
      collapsedGroups: serverControls.collapsedGroups,
    },
    {
      applyArrangement: applySavedArrangement,
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
  // ISS-8127 (davetho review): desktop's window comes from the SHARED
  // `useSharedDateRange` store, which `isViewReady` does not track at all, and a
  // named active view's range lands one commit later via `applySavedArrangement`.
  // Gating presentation alone therefore left the producer reachable under the
  // pre-application range on a warm cache. A null request is the surface's
  // existing "no cohort yet" state.
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
  } = useBranchCohortAnalytics(cohortRequest, {
    enabled: presentedPageData?.analytics !== undefined,
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCHES_LIST_STALE_TIME_MS,
  });

  // ISS-5253: the approved cards read canonical current/prior metrics for the
  // exact date-windowed, facet-filtered Branch IDs before pagination. A missing
  // or mismatched producer response retains only row-provable values and never
  // substitutes whole-list Session spend for the selected cohort.
  const filteredAnalytics = useMemo(() => {
    if (serverPageActive) {
      return {
        analytics: presentedPageData?.analytics,
        comparisonSuppressedByFilter: false,
        // The server paged and scoped this response, so its figures are the
        // producer's own.
        metricsDerivedLocally: false,
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
  const summaryAnalyticsErrored = resolveBranchesSummaryErrored({
    analyticsError,
    cohortErrored: cohortRequest !== null && cohortIsError,
    listError: false,
    pageDataAnalyticsError: presentedPageData?.analyticsError === true,
  });
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

  // Reset pagination when dateRange changes — covers both local toolbar changes
  // AND cross-tab StorageEvent updates from Dashboard/Sessions.
  const dateRangeRef = useRef(dateRange);
  useEffect(() => {
    if (dateRangeRef.current !== dateRange) {
      dateRangeRef.current = dateRange;
      legacyState.setPage(0);
      serverControls.setPage(0);
    }
  }, [dateRange, legacyState, serverControls]);

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
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

  // ISS-9429: the ONE narrowing signal both hosts pass. This used to widen a
  // desktop-local `hasRows` through a file-private `branchFiltersAreActive`,
  // which is exactly why the web host — unable to import it — kept claiming a
  // filtered-away result meant the org had no branches.
  const hasActiveFilters = branchFiltersAreActive(filters);
  // ISS-9725: the same signals the body branches on go to the dead-end
  // classifier, so a failed read reaches the monitored `desktop:dead-end-telemetry`
  // channel as `unavailable` rather than being indistinguishable from an org
  // that genuinely has no branches. The wrapped handler is the one the list
  // surface renders, so the `retryOffered: true` the record carries is always
  // followed by a tracked attempt.
  const { onRetry: handleListRetry } = useBranchesListDeadEndTelemetry({
    hasActiveFilters,
    hasWindow: startDate !== undefined,
    isActive,
    isError,
    isPending: pageDataPresentationPending,
    listError,
    onRetry: refetch,
    visibleRowCount: pagedRows.length,
  });
  // `handleListRetry` is wrapped rather than `refetch` so the dead-end record
  // still sees every attempt; the recovery hook adds the in-flight dedupe and
  // the elapsed-time phase the body reads.
  const { handleRetry: handleListRetryWithStall, stallPhase } =
    useBranchesListRecovery({
      isBlockingLoad: pageDataPresentationPending,
      refetch: handleListRetry,
    });
  // ISS-10645: what a stalled read may honestly ask for, resolved from this
  // device's OWN two answers — a settled guest, and the connect action the
  // GitHub status already produced. The shared slot decides which arm that is;
  // this only reports.
  //
  // The outcome of this slot's handoff has to travel with it: `connectState`
  // settles in this renderer, and this slot is the only one mounted while the
  // blocking read has produced nothing. Once the list draws, the summary band's
  // `githubConnectOutcome` reports the same state for the strip's own ask.
  const stallCta: BranchesStallCta = {
    connectOutcome: (
      // `StalledList`, not `List`: this slot renders only while the blocking read
      // has produced nothing, so the retained-data line the populated list
      // surfaces show would describe content that is not on screen (ISS-11326).
      <DesktopConnectStatus
        state={connectState}
        variant={DesktopGitHubConnectSurface.StalledList}
      />
    ),
    createAccountAction: <BranchesStallAccountCta />,
    githubConnect,
    signals: resolveBranchesStallCtaSignals(githubConnectAction),
  };
  // ISS-9225: the v2 list surface renders its own `BranchesListToolbarV2` from
  // this object, so filters, columns and saved views have one source here.
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
    onSummaryRetry: () => {
      refetchAnalytics().catch(() => undefined);
      refetchCohort().catch(() => undefined);
    },
    summaryAnalyticsErrored,
    summaryCards: filteredAnalytics.analytics,
    summaryCardsErrored,
    summaryCardsPending: summaryAnalyticsPending,
    // ISS-9887: the same signal the web page folds in, from the same query
    // option (`keepPreviousData`). The withholding above already makes the
    // metrics undefined on this surface, so this is belt-and-braces today —
    // and it is what keeps the two surfaces answering the reload question
    // from the same input rather than agreeing by accident.
    summaryCardsReloading: isPlaceholderData,
    // ISS-10544: this shell's own answer, resolved at its own read site. The key
    // graduated on web and still gates here (operator ruling, 2026-09-17), so
    // the two hosts give the shared band two different answers to one question.
    trendSparkline,
  };
  const onRenderCommit = useRenderCommitInstrumentation({
    causeInputs: null,
    itemCount: pagedRows.length,
    resolveCause: resolveBranchesListCause,
    view: RendererRenderView.BranchesList,
  });
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <h1 className="sr-only">Branches</h1>
      <Profiler id="branches_list" onRender={onRenderCommit}>
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
          githubConnect={branchesSummaryConnectAsk({
            connectAction: githubConnectAction,
            connectTarget: githubConnect,
            metricsDerivedLocally: filteredAnalytics.metricsDerivedLocally,
          })}
          githubConnectOutcome={
            // Withheld while the blocking read has produced nothing, because
            // `stallCta.connectOutcome` is the slot that renders in exactly
            // that state — two banners reporting one handoff is the collision
            // this gate avoids, not a second affordance.
            pageDataPresentationPending ? undefined : (
              <DesktopConnectStatus
                state={connectState}
                variant={DesktopGitHubConnectSurface.List}
              />
            )
          }
          grouping={serverControls.grouping}
          hasActiveFilters={hasActiveFilters}
          hasCompletePopulation={hasCompletePopulation}
          hasWindow={startDate !== undefined}
          historyListTestId={DESKTOP_BRANCHES_HISTORY_LIST_TEST_ID}
          includePriorityColumn={showPriorityColumn}
          includeProjectColumn={showProjectColumn}
          includeTagsColumn={showTagsColumn}
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
          onRetry={handleListRetryWithStall}
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
          tableScrollTestId={DESKTOP_BRANCHES_SCROLL_CONTAINER_TEST_ID}
          tagsReadOnly={!isOnline}
          toolbar={toolbarProps}
          total={total}
          totalPages={totalPages}
          visibleColumns={visibleColumns}
        />
      </Profiler>
    </div>
  );
}
