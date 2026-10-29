import {
  type BranchAnalytics,
  type BranchesPageData,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { Surface } from "@repo/api/src/types/surface-analytics";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BRANCH_GRID_TABLE_V2_PAGE_SIZE } from "@repo/app/branches/hooks/use-branch-filter-state";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY } from "@repo/app/branches/lib/branches-partial-cohort-metrics-flag";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { BranchesView } from "../branches-view";
import { inertApiAdapter, renderView, wireRow } from "./test-helpers";

const PAGE_PARAM_PATTERN = /[?&]page=/;

/**
 * ISS-11284 coverage — the legacy-page URL reconciliation effect
 * (`branches-view.tsx` ~L436-450) and the server-page-corrected-offset effect
 * (~L672-680), plus the partial-cohort binder ternary (~L596-598).
 *
 * These are desktop-shell wiring, not policy: the behavior asserted here is
 * "the effect ran and the page state moved (or didn't)", pinning what
 * `branches-view.tsx` already does today.
 */

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));
vi.mock("@repo/app/branches/hooks/use-branch-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >();
  return {
    ...actual,
    useBranchViewState: () => ({
      isViewReady: true,
      sortKey: "updated",
      sortDir: "desc",
      dateRange: "all",
      visibleColumns: new Set<string>(["repo"]),
      setSort: vi.fn(),
      toggleSortDir: vi.fn(),
      setDateRange: vi.fn(),
      toggleColumn: vi.fn(),
    }),
  };
});

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: DesktopAuthStatus.Authenticated,
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: vi.fn(),
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

function row(id: string, activityIsoMinuteOffset: number): WireBranchRow {
  return {
    ...wireRow,
    id: `owner%2Frepo::${id}`,
    branchName: id,
    // Distinct, monotonic timestamps so the default last-activity sort keeps a
    // stable, predictable order across every row in the fixture.
    lastActivityAt: new Date(
      Date.UTC(2026, 5, 17, 12, activityIsoMinuteOffset)
    ).toISOString(),
    sessionIds: [`session-${id}`],
  };
}

/** A legacy (non-server-paginated) local source over `count` rows. */
function legacySource(count: number): BranchesDataSource {
  const items = Array.from({ length: count }, (_, index) =>
    row(`legacy-${index}`, index)
  );
  const list = {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Self,
  };
  return {
    scope: "local",
    list: () => Promise.resolve(list),
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<BranchUsageSummary>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    pageData: () => Promise.resolve({ list, analytics: makeBranchAnalytics() }),
  };
}

describe("BranchesView legacy URL-page reconciliation (L437/L447)", () => {
  it("leaves the legacy page at 0 when the corpus fits on a single page (L437 false, L447 true)", async () => {
    // `?page=2` parses to 0-based index 1 (`parseBranchPageParam` is 1-based on
    // the wire), so `serverControls.page > 0` and the big OR at L437 is FALSE —
    // reaching L447. There, a single-page corpus makes `legacyTotalPages <= 1`
    // true, so the effect returns before ever calling `setLegacyPage`. The
    // observable result is identical to what an unconditional
    // `setLegacyPage(min(page, 0))` would produce (both resolve to page 0), so
    // this pins that the early return does not corrupt anything rather than
    // proving a distinct rendered page.
    renderView(legacySource(3), undefined, [], "/branches?page=2");

    expect(await screen.findByText("legacy-0")).toBeTruthy();
    expect(screen.getByText("legacy-1")).toBeTruthy();
    expect(screen.getByText("legacy-2")).toBeTruthy();
  });

  it("adopts the URL's requested page onto the legacy paginator once the corpus spans multiple pages (L437 false, L447 false)", async () => {
    const perPage = BRANCH_GRID_TABLE_V2_PAGE_SIZE;
    const total = perPage + 5;
    // `?page=2` (0-based index 1) exceeds a single page's worth of rows, so
    // `legacyTotalPages` is 2 and `setLegacyPage(min(1, 1))` actually moves the
    // legacy paginator off its page-0 default — a rendered difference: without
    // the effect the reader would still be looking at page 0's rows.
    renderView(legacySource(total), undefined, [], "/branches?page=2");

    // With a 25-row page and a 30-row corpus, the pagination footer reads
    // "1-25 of 30" on page 0 and "26-30 of 30" on page 1 — a direct, row-identity
    // -independent proof that `setLegacyPage` moved the paginator off its
    // page-0 default onto the page the URL asked for.
    expect(await screen.findByText(`26–${total} of ${total}`)).toBeTruthy();
    expect(screen.queryByText(`1–${perPage} of ${total}`)).toBeNull();
  });

  it("still adopts a later-arriving multi-page corpus after an earlier single-page read took the L447 early return (L447 must not mark the applied-ref)", async () => {
    // The case above only ever sees the one-page state, so it
    // cannot tell an early return that leaves `legacyUrlPageAppliedRef` alone
    // apart from one that (incorrectly) marks it before ever moving the page.
    // Both read as "still on page 0" at that single mount. Grow the corpus on
    // the SAME instance (so the `useRef` survives) via a refetch, and only the
    // former can still honor `?page=2` once a page 2 exists.
    const perPage = BRANCH_GRID_TABLE_V2_PAGE_SIZE;
    const total = perPage + 5;
    let count = 3;
    const buildList = () => {
      const items = Array.from({ length: count }, (_, index) =>
        row(`legacy-${index}`, index)
      );
      return {
        items,
        total: items.length,
        viewerScope: BranchViewerScope.Self,
      };
    };
    const dataSource: BranchesDataSource = {
      scope: "local",
      list: () => Promise.resolve(buildList()),
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<BranchUsageSummary>(() => undefined),
      analytics: () => new Promise<BranchAnalytics>(() => undefined),
      pageData: () =>
        Promise.resolve({
          list: buildList(),
          analytics: makeBranchAnalytics(),
        }),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderView(dataSource, queryClient, [], "/branches?page=2");

    // Single-page corpus at mount: L447's early return fires without ever
    // calling `setLegacyPage`.
    expect(await screen.findByText("legacy-0")).toBeTruthy();

    // The corpus grows past a page and the page-data query refetches on the
    // SAME mounted `BranchesView` — the ref-holding effect instance survives
    // this, unlike a remount.
    count = total;
    await queryClient.invalidateQueries({
      queryKey: branchesKeys.pageDataRoot(),
    });

    expect(await screen.findByText(`26–${total} of ${total}`)).toBeTruthy();
    expect(screen.queryByText(`1–${perPage} of ${total}`)).toBeNull();
  });
});

function serverPageResponse(
  offset: number,
  branchNames: string[]
): BranchesPageData["list"] {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    items: branchNames.map((name, index) =>
      Object.assign(row(name, index), { id: `owner%2Frepo::${name}` })
    ),
    total: branchNames.length,
    viewerScope: BranchViewerScope.Self,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset,
      requestedOffset: offset,
      now: "2026-06-17T12:00:00.000Z",
    },
    facets: {
      names: emptyFacet,
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}

/**
 * Mounts `BranchesView` with its own `createMemoryNavigation` instance (rather
 * than `test-helpers`' `renderView`, which does not expose its navigation) so
 * the URL `page` param is directly readable after the repair effect settles.
 */
function renderWithNavigation(
  dataSource: BranchesDataSource,
  initialPath: string
) {
  const navigation = createMemoryNavigation({ initialPath });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
          >
            <NavigationProvider adapter={navigation.adapter}>
              <SurfaceAnalyticsProvider
                capture={() => undefined}
                surface={Surface.Desktop}
              >
                <BranchesView dataSource={dataSource} isActive={true} />
              </SurfaceAnalyticsProvider>
            </NavigationProvider>
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
  return navigation;
}

describe("BranchesView server-page offset repair (L677)", () => {
  it("corrects the URL's requested page down to what the server actually served", async () => {
    const dataSource: BranchesDataSource = {
      scope: "local",
      list: () => new Promise<never>(() => undefined),
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<BranchUsageSummary>(() => undefined),
      analytics: () => new Promise<BranchAnalytics>(() => undefined),
      cohortAnalytics: () => Promise.resolve(null),
      pageData: () =>
        Promise.resolve({
          // Always offset 0 — as a producer clamping an out-of-range request
          // would — regardless of what the URL asked for.
          list: serverPageResponse(0, ["server-row"]),
          analytics: makeBranchAnalytics(),
        }),
    };

    // `?page=6` parses to 0-based index 5, but the server-page fixture always
    // reports `pageInfo.offset: 0`, so `repairedPage` (0) mismatches
    // `serverControls.page` (5) and the effect corrects the URL back down.
    const navigation = renderWithNavigation(dataSource, "/branches?page=6");

    expect(await screen.findByText("server-row")).toBeTruthy();
    await waitFor(() =>
      expect(navigation.getCurrentHref()).not.toContain("page=6")
    );
    // `writeBranchPageParam` drops the param entirely for page index 0.
    expect(navigation.getCurrentHref()).not.toMatch(PAGE_PARAM_PATTERN);
  });

  it("leaves the URL's page alone when it already matches what the server served", async () => {
    const dataSource: BranchesDataSource = {
      scope: "local",
      list: () => new Promise<never>(() => undefined),
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<BranchUsageSummary>(() => undefined),
      analytics: () => new Promise<BranchAnalytics>(() => undefined),
      cohortAnalytics: () => Promise.resolve(null),
      pageData: () =>
        Promise.resolve({
          list: serverPageResponse(0, ["server-row"]),
          analytics: makeBranchAnalytics(),
        }),
    };

    const navigation = renderWithNavigation(dataSource, "/branches");

    expect(await screen.findByText("server-row")).toBeTruthy();
    // `repairedPage` (0) equals `serverControls.page` (0): no correction, so
    // the URL never gains a `page` param.
    expect(navigation.getCurrentHref()).not.toMatch(PAGE_PARAM_PATTERN);
  });
});

describe("BranchesView partial-cohort binder read site (L597 cond-expr)", () => {
  it("still recomputes summary cards over the admitted cohort when the partial-cohort flag is enabled", async () => {
    const ADMITTED_OWNER = "alice";
    const rows = [row("alice-a", 0), row("alice-b", 1), row("grace-a", 2)].map(
      (r, index) =>
        index < 2 ? { ...r, owner: ADMITTED_OWNER } : { ...r, owner: "grace" }
    );
    const list = {
      items: rows,
      total: rows.length,
      viewerScope: BranchViewerScope.Self,
    };
    const dataSource: BranchesDataSource = {
      scope: "local",
      list: () => Promise.resolve(list),
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<BranchUsageSummary>(() => undefined),
      analytics: () => new Promise<BranchAnalytics>(() => undefined),
      pageData: () =>
        Promise.resolve({ list, analytics: makeBranchAnalytics() }),
    };

    // Enabling the flag selects
    // `bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort` at the
    // read site instead of the plain binder — pinned by the table still
    // rendering the facet-admitted rows and excluding the facet-excluded one,
    // which is unaffected by which binder handles the summary cards.
    renderView(
      dataSource,
      undefined,
      [BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY],
      "/branches?owner=alice"
    );

    expect(await screen.findByText("alice-a")).toBeTruthy();
    expect(screen.getByText("alice-b")).toBeTruthy();
    expect(screen.queryByText("grace-a")).toBeNull();
  });

  it("republishes the partial-cohort producer's own merge-rate figure instead of the plain binder's recompute, when the facet admits every loaded row (L597 true branch)", async () => {
    // Row filtering alone can't tell the two binders apart —
    // flipping L597's ternary back to the plain binder still passes that
    // check, because which binder ran never changes which rows are on screen.
    // The one branch that DOES differ needs every loaded row admitted by the
    // facet (`sameRowCohort` true) plus a producer cohort response that
    // answers for a strict SUBSET of the requested branches: only then does
    // `bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort`
    // republish the producer's own cohort-sourced merge rate instead of
    // falling through to the plain binder's "rows didn't narrow, keep the
    // producer's analytics untouched" no-op.
    const rows = [row("alice-a", 0), row("alice-b", 1), row("alice-c", 2)];
    const list = {
      items: rows,
      total: rows.length,
      viewerScope: BranchViewerScope.Self,
    };
    const branchIds = rows.map((r) => r.id).sort();
    const dataSource: BranchesDataSource = {
      scope: "local",
      list: () => Promise.resolve(list),
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<BranchUsageSummary>(() => undefined),
      analytics: () => new Promise<BranchAnalytics>(() => undefined),
      // A strict subset of `branchIds` — a genuine partial match, distinct from
      // the producer's own (unfiltered) merge rate below.
      cohortAnalytics: () =>
        Promise.resolve({
          matchedBranchIds: branchIds.slice(0, 2),
          canonicalMetrics: makeBranchListMetrics({
            mergeRatePct: {
              current: { state: BranchMetricAvailability.Complete, value: 75 },
            },
          }),
        }),
      pageData: () =>
        Promise.resolve({
          list,
          analytics: makeBranchAnalytics({
            canonicalMetrics: makeBranchListMetrics({
              mergeRatePct: {
                current: {
                  state: BranchMetricAvailability.Complete,
                  value: 40,
                },
              },
            }),
          }),
        }),
    };

    // All three rows share `wireRow`'s default "alice" owner, so `?owner=alice`
    // admits every one of them — the facet narrows nothing.
    renderView(
      dataSource,
      undefined,
      [BRANCHES_PARTIAL_COHORT_METRICS_FEATURE_FLAG_KEY],
      "/branches?owner=alice"
    );

    expect(await screen.findByText("75%*")).toBeTruthy();
    expect(screen.queryByText("40%")).toBeNull();
  });
});
