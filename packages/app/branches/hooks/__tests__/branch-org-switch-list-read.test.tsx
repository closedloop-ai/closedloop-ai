import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchPrCommentsResponse,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchListCapability } from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiAdapterProvider } from "../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { orgScopedViewStateKey } from "../../../shared/lib/org-scoped-view-state-key";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { resolveBranchPageState } from "../../lib/branch-page-state";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import { buildBranchServerPageFilters } from "../../lib/branch-server-page-query";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import {
  useUrlSyncedBranchFilterState,
  useUrlSyncedBranchServerState,
} from "../use-branch-filter-state";
import {
  useBranchSavedViews,
  useBranchSavedViewsStore,
} from "../use-branch-saved-views";
import { useBranchViewState } from "../use-branch-view-state";
import { useBranchesPageData } from "../use-branches";

const USER_ID = "user_alice";
const ORG_A = "org_a";
const ORG_B = "org_b";
const SURFACE_KEY = "branches:org-switch-test";
const listSpy =
  vi.fn<(filters: Record<string, unknown>) => Promise<BranchListResponse>>();

describe("Branches organization switch reads", () => {
  beforeEach(() => {
    localStorage.clear();
    listSpy.mockReset();
    listSpy.mockImplementation(async (filters) => ({
      items: [],
      total: 0,
      viewerScope: "self",
      pageInfo: {
        capability: BranchListCapability.ServerPaginationV1,
        limit: 25,
        offset: Number(filters.offset),
        requestedOffset: Number(filters.offset),
        now: "2026-09-19T12:00:00.000Z",
      },
    }));
    seedLiveView();
    seedNamedView(ORG_A, "owner-a");
    seedNamedView(ORG_B, "owner-b");
  });

  it.each([false, true])(
    "keeps hidden named filters out of org-switch reads (org-scoped live view: %s)",
    async (orgScoped) => {
      if (orgScoped) {
        seedLiveView(ORG_A);
        seedLiveView(ORG_B, BranchSortDir.Desc);
      }
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        },
      });
      const navigation = createMemoryNavigation({ initialPath: "/branches" });
      const view = render(
        <Providers
          orgId={ORG_A}
          orgScoped={orgScoped}
          queryClient={queryClient}
        >
          <NavigationProvider adapter={navigation.adapter}>
            <Probe orgId={ORG_A} />
          </NavigationProvider>
        </Providers>
      );

      await waitFor(() =>
        expect(view.getByTestId("settled").textContent).toBe(ORG_A)
      );
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(listSpy.mock.calls[0]?.[0]).toMatchObject({
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      });
      expect(listSpy.mock.calls[0]?.[0]).not.toHaveProperty("owners");

      view.rerender(
        <Providers
          orgId={ORG_B}
          orgScoped={orgScoped}
          queryClient={queryClient}
        >
          <NavigationProvider adapter={navigation.adapter}>
            <Probe orgId={ORG_B} />
          </NavigationProvider>
        </Providers>
      );

      // Observe the completed list response AND both production restore gates,
      // rather than guessing how many microtasks restoration needs. Counts pin
      // requests across the switch, not the timing of isArrangementSettled alone.
      await waitFor(() =>
        expect(view.getByTestId("settled").textContent).toBe(ORG_B)
      );
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(listSpy.mock.calls[1]?.[0]).toMatchObject({
        sortDir: orgScoped ? BranchSortDir.Desc : BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      });
      expect(listSpy.mock.calls[1]?.[0]).not.toHaveProperty("owners");
      view.unmount();
      queryClient.clear();
    }
  );
});

function Probe({ orgId }: { orgId: string }) {
  const view = useBranchViewState(SURFACE_KEY, true);
  const savedViewsStore = useBranchSavedViewsStore(SURFACE_KEY, true);
  const server = useUrlSyncedBranchServerState({
    groupView: {
      applyArrangement: view.applyArrangement,
      collapsedGroups: view.collapsedGroups,
      grouping: view.grouping,
      setCollapsedGroups: view.setCollapsedGroups,
      setGrouping: view.setGrouping,
    },
    isArrangementSettled: savedViewsStore.isArrangementSettled,
    isRestored: view.isViewReady,
    onPageSizePersist: view.setPageSize,
    persistedPageSize: view.pageSize,
  });
  const filters = buildBranchServerPageFilters({
    filters: server.filters,
    page: server.page,
    pageSize: server.pageSize,
    sortKey: view.sortKey,
    sortDir: view.sortDir,
  });
  const pageData = useBranchesPageData(
    filters,
    { enabled: server.isReadReady },
    { cacheScope: `org:${orgId}` }
  );
  const legacy = useUrlSyncedBranchFilterState(
    [],
    server.pageSize,
    true,
    undefined,
    server.writeViewParams
  );
  const state = resolveBranchPageState({
    serverPageActive: pageData.data?.list.pageInfo !== undefined,
    serverControlsActive: pageData.isPending,
    server,
    legacy,
    data: pageData.data?.list,
    rows: [],
    pageSize: server.pageSize,
  });
  useBranchSavedViews(
    savedViewsStore,
    {
      sortKey: view.sortKey,
      sortDir: view.sortDir,
      dateRange: view.dateRange,
      hiddenColumns: view.hiddenColumns,
      columnOrder: view.columnOrder,
      columnWidths: view.columnWidths,
      pageSize: view.pageSize,
      filters: state.filters,
      grouping: server.grouping,
      collapsedGroups: server.collapsedGroups,
    },
    {
      applyArrangement: server.applyArrangement,
      applyFilters: state.handleFiltersChange,
    }
  );
  return (
    <output data-testid="settled">
      {server.isReadReady &&
      savedViewsStore.isArrangementSettled &&
      pageData.isSuccess &&
      !pageData.isPlaceholderData
        ? orgId
        : "waiting"}
    </output>
  );
}

function Providers({
  children,
  orgId,
  orgScoped,
  queryClient,
}: {
  children: ReactNode;
  orgId: string;
  orgScoped: boolean;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ userId: USER_ID, orgId })}
      >
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={
              orgScoped ? orgScopedFeatureFlagAdapter : featureFlagAdapter
            }
          >
            <BranchesDataSourceProvider dataSource={dataSource}>
              {children}
            </BranchesDataSourceProvider>
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

function arrangement(owner: string) {
  return {
    sortKey: BranchSortKey.LastActivity,
    sortDir: BranchSortDir.Desc,
    dateRange: "30d",
    hiddenColumns: [],
    columnOrder: [],
    columnWidths: {},
    pageSize: 25,
    filters: { ...DEFAULT_BRANCH_FILTERS, owners: [owner] },
    grouping: EMPTY_TABLE_GROUPING,
    collapsedGroups: {},
  };
}

function seedLiveView(
  orgId?: string,
  sortDir: BranchSortDir = BranchSortDir.Asc
) {
  const baseKey = `branches:saved-view:${SURFACE_KEY}:approved`;
  const key = orgId
    ? orgScopedViewStateKey(baseKey, USER_ID, orgId)
    : `${baseKey}:u:${USER_ID}`;
  if (!key) {
    throw new Error("live-view fixture requires a storage identity");
  }
  localStorage.setItem(
    key,
    JSON.stringify({
      sortKey: BranchSortKey.Name,
      sortDir,
      dateRange: "30d",
      hiddenColumns: [],
      columnOrder: [],
      columnWidths: {},
      pageSize: 25,
      grouping: EMPTY_TABLE_GROUPING,
      collapsedGroups: {},
    })
  );
}

function seedNamedView(orgId: string, owner: string) {
  localStorage.setItem(
    `branches:saved-views:${orgId}:${USER_ID}:${SURFACE_KEY}:approved`,
    JSON.stringify({
      activeViewId: `view-${orgId}`,
      views: [
        { id: `view-${orgId}`, name: orgId, arrangement: arrangement(owner) },
      ],
    })
  );
}

const inertApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("unexpected HTTP request")),
};

const featureFlagAdapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
const orgScopedFeatureFlagAdapter = createStaticFeatureFlagAdapter({
  enabledFlags: [ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY],
});

const dataSource: BranchesDataSource = {
  scope: "test",
  supportsSplitPageData: true,
  list: listSpy,
  detail: () => new Promise<BranchPageDetail>(() => undefined),
  comments: () => new Promise<BranchPrCommentsResponse>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  pageData: () =>
    Promise.reject(new Error("split source must not call pageData")),
};
