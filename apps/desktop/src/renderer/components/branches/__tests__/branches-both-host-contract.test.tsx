/**
 * ISS-9544 — the DESKTOP half of the Branches both-host contract.
 *
 * The states asserted here are not written here: they live once in
 * `@repo/app/branches/__tests__/branches-both-host-contract`, and
 * `apps/app/app/(authenticated)/[orgSlug]/branches/__tests__/branches-both-host-contract.test.tsx`
 * runs the identical cases over identical fixtures against the web page. This
 * file owns only the desktop ADAPTER: the Electron shell's providers, its
 * static flag adapter over the SAME PostHog key web reads (ISS-8753 — there is
 * no second desktop gate, and the surviving Labs row for this key is residue
 * that no longer gates the surface), and the module graph `apps/app` never
 * resolves.
 *
 * That split is the point. A shared-surface change is reviewed by grepping
 * `apps/desktop/src`, which finds direct importers and not the shared render path
 * through `BranchesView` and `BranchesListSurfaceV2`. Mounting the shell is what
 * proves the behavior.
 */

import type {
  BranchAnalytics,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  BRANCHES_BOTH_HOST_CONTRACT,
  type BranchesBothHostFixture,
} from "@repo/app/branches/__tests__/branches-both-host-contract";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchSortKey } from "@repo/app/branches/lib/branch-sort-group";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { renderView } from "./test-helpers";

const {
  beginSignInMock,
  getGitHubIntegrationStatusMock,
  openGitHubConnectMock,
  useDesktopAuthMock,
} = vi.hoisted(() => ({
  beginSignInMock: vi.fn(),
  getGitHubIntegrationStatusMock: vi.fn(),
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));
// Radix's menus read the pointer-capture API jsdom does not implement, and the
// renderer lane declares no global setup file.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: () => null,
}));
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: () => ({
    activeViewId: null,
    isArrangementSettled: true,
    modified: false,
    onCreateView: vi.fn(),
    onDeleteView: vi.fn(),
    onRenameView: vi.fn(),
    onSelectView: vi.fn(),
    onUpdateView: vi.fn(),
    views: [],
  }),
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
// "all", so the contract's rows are read from the fixture rather than from
// whichever window this shell last persisted.
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));
// The visible set is derived from the shell's OWN canonical column table, not
// retyped: a renamed or dropped column would otherwise leave this half mounting
// a column set production no longer has, while the web half — which uses the
// real hook — tracks the change. That silent drift between the two halves is
// the defect class this contract exists to catch.
vi.mock("@repo/app/branches/hooks/use-branch-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >();
  const visibleColumns = new Set(
    actual.APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id)
  );
  return {
    ...actual,
    useBranchViewState: () => ({
      applyArrangement: vi.fn(),
      columnOrder: [],
      dateRange: "all",
      hiddenSummaryCards: new Set<string>(),
      isViewReady: true,
      resetColumns: vi.fn(),
      resetView: vi.fn(),
      setColumnOrder: vi.fn(),
      setDateRange: vi.fn(),
      setSort: vi.fn(),
      sortDir: "desc",
      sortKey: BranchSortKey.LastActivity,
      toggleColumn: vi.fn(),
      toggleSortDir: vi.fn(),
      toggleSummaryCard: vi.fn(),
      visibleColumns,
    }),
  };
});

let contractRows = BRANCHES_BOTH_HOST_CONTRACT.cases[0].fixture.rows;

const dataSource: BranchesDataSource = {
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: (request) =>
    Promise.resolve({
      canonicalMetrics: makeBranchListMetrics({
        cohortSize: request.branchIds.length,
      }),
      matchedBranchIds: request.branchIds,
    }),
  comments: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  list: () =>
    Promise.resolve({
      items: [...contractRows],
      total: contractRows.length,
      viewerScope: BranchViewerScope.Self,
    }),
  pageData: () =>
    Promise.resolve({
      analytics: makeBranchAnalytics(),
      list: {
        items: [...contractRows],
        total: contractRows.length,
        viewerScope: BranchViewerScope.Self,
      },
    }),
  scope: "local",
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  beginSignInMock.mockResolvedValue({ ok: true });
  getGitHubIntegrationStatusMock.mockResolvedValue({ connected: true });
  openGitHubConnectMock.mockResolvedValue({ ok: true, url: "" });
  useDesktopAuthMock.mockReturnValue({
    beginSignIn: beginSignInMock,
    state: {
      organizationId: "org-1",
      status: "authenticated",
      userId: "user-1",
    },
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getGitHubIntegrationStatus: getGitHubIntegrationStatusMock,
      openGitHubConnect: openGitHubConnectMock,
    },
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

runBothHostContract<BranchesBothHostFixture>({
  contract: BRANCHES_BOTH_HOST_CONTRACT,
  host: DESKTOP_HOST,
  mount: (fixture) => {
    contractRows = fixture.rows;
    renderView(
      dataSource,
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        },
      }),
      []
    );
  },
});

it("keeps shared adoption active while GitHub status is unresolved", async () => {
  getGitHubIntegrationStatusMock.mockReturnValue(new Promise(() => undefined));
  contractRows = BRANCHES_BOTH_HOST_CONTRACT.cases[0].fixture.rows;

  const result = renderView(
    dataSource,
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    }),
    [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
  );

  expect(await result.findByText(contractRows[0]!.branchName)).not.toBeNull();
  expect(
    result.container.querySelector('[data-grid-row-id="__grid-chrome__header"]')
  ).not.toBeNull();
  expect(
    await result.findAllByRole("button", { name: "Branch actions" })
  ).not.toHaveLength(0);
});
