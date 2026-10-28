import { TableGroupOrder } from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import { isGridChromeRowId } from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import {
  type BranchAnalytics,
  type BranchListResponse,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchListCapability,
  BranchListFacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import { Surface } from "@repo/api/src/types/surface-analytics";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type {
  BranchesDataSource,
  BranchListOptions,
} from "@repo/app/branches/data-source/branches-data-source";
import {
  branchGrouping,
  requiredAxisKey,
} from "@repo/app/branches/lib/__tests__/support/branch-grouping-fixtures";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  PERSISTED_COLLAPSED_GROUPS_SCHEMA,
  TABLE_COLLAPSED_GROUP_PARAM,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { BranchesView } from "../branches-view";
import { inertApiAdapter, wireRow } from "./test-helpers";

/**
 * ISS-9582 — the DESKTOP host's half of the `groupCollapse` port: a link's
 * `group`/`collapsed` URL params seed the band collapse a reader sees on
 * mount, and collapsing a band through the UI writes both the URL and the
 * desktop saved view (`branches:saved-view:desktop:approved*` in
 * `localStorage`) so a reload restores the same bands.
 *
 * `use-branch-view-state` is deliberately left UNMOCKED (unlike the sibling
 * `branches-view-column-controls.test.tsx`), because it is the module that
 * owns the real `localStorage` persistence this suite asserts against. The
 * named-view switcher (`use-branch-saved-views`) is stubbed exactly as the
 * sibling suites do — capturing a NAMED saved-view snapshot is out of scope
 * here and not observable through that stub.
 */

const originalHasPointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "hasPointerCapture"
);
const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "setPointerCapture"
);
const originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "releasePointerCapture"
);
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView"
);

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/** Restores an `Element.prototype` member to whatever this file found on import. */
function restoreElementPrototypeMember(
  name:
    | "hasPointerCapture"
    | "setPointerCapture"
    | "releasePointerCapture"
    | "scrollIntoView",
  original: PropertyDescriptor | undefined
): void {
  if (original) {
    Object.defineProperty(Element.prototype, name, original);
  } else {
    Reflect.deleteProperty(Element.prototype, name);
  }
}

afterAll(() => {
  restoreElementPrototypeMember("hasPointerCapture", originalHasPointerCapture);
  restoreElementPrototypeMember("setPointerCapture", originalSetPointerCapture);
  restoreElementPrototypeMember(
    "releasePointerCapture",
    originalReleasePointerCapture
  );
  restoreElementPrototypeMember("scrollIntoView", originalScrollIntoView);
});

const { beginSignInMock, openGitHubConnectMock, useDesktopAuthMock } =
  vi.hoisted(() => ({
    beginSignInMock: vi.fn(),
    openGitHubConnectMock: vi.fn(),
    useDesktopAuthMock: vi.fn(),
  }));
const { setSharedDateRangeMock } = vi.hoisted(() => ({
  setSharedDateRangeMock: vi.fn(),
}));

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: () => null,
}));
// The named-view switcher is not the subject of this suite: `collapsedGroups`
// persistence under test comes from `use-branch-view-state`, left real below.
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
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
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({
    dateRange: "all",
    setDateRange: setSharedDateRangeMock,
  }),
}));

const GROUP_TRIGGER = { name: "Group" } as const;
const PRIMARY_GROUPING_FIELD = { name: "Primary grouping field" } as const;
const REPOSITORY_DIMENSION = { name: "Repository" } as const;
const ONE_GROUPING_LEVEL = { name: "Groups: 1" } as const;
const SAVED_VIEW_KEY_PREFIX = "branches:saved-view:desktop:approved";
const REPO_AXIS_KEY = requiredAxisKey(
  branchGrouping("repo", TableGroupOrder.Custom)
);
const COLLAPSED_REPO = "acme/web";

const ROWS: WireBranchRow[] = [
  {
    ...wireRow,
    id: "owner%2Frepo::feature-a",
    branchName: "feature/a",
    repoFullName: "acme/web",
    sessionIds: ["s1"],
  },
  {
    ...wireRow,
    id: "owner%2Frepo::feature-b",
    branchName: "feature/b",
    repoFullName: "acme/api",
    sessionIds: ["s2"],
  },
];

const BRANCH_LIST_METRICS = makeBranchListMetrics();
const listMock =
  vi.fn<(filters: BranchListOptions) => Promise<BranchListResponse>>();
const dataSource: BranchesDataSource = {
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: async (request) => ({
    canonicalMetrics: BRANCH_LIST_METRICS,
    matchedBranchIds: request.branchIds,
  }),
  comments: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  list: listMock,
  pageData: async (filters) => ({
    analytics: makeBranchAnalytics(),
    list: await listMock(filters),
  }),
  scope: "http",
  supportsSplitPageData: true,
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
};

let desktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  useDesktopAuthMock.mockReturnValue({
    beginSignIn: beginSignInMock,
    state: {
      organizationId: "org-1",
      status: "authenticated",
      userId: "user-1",
    },
  });
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getGitHubIntegrationStatus: () => Promise.resolve({ connected: true }),
      openGitHubConnect: openGitHubConnectMock,
    },
  });
  listMock.mockResolvedValue(makeServerListResult(ROWS));
});

afterEach(() => {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("BranchesView group collapse deep link", () => {
  it("renders the band the URL names as collapsed on mount", async () => {
    const deepLinkPath = `/branches?${new URLSearchParams([
      [TABLE_GROUP_PARAM, `repo:${TableGroupOrder.Ascending}`],
      [TABLE_COLLAPSED_GROUP_PARAM, COLLAPSED_REPO],
    ]).toString()}`;

    renderBranchesView({ initialPath: deepLinkPath });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "web" })).toBeTruthy()
    );
    expect(
      screen.getByRole("button", { expanded: false, name: "web" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { expanded: true, name: "api" })
    ).toBeTruthy();
    expect(screen.queryByText("feature/a")).toBeNull();
    expect(screen.getByText("feature/b")).toBeTruthy();
  });
});

describe("BranchesView group collapse gesture", () => {
  it("writes the collapsed band into the URL and the desktop saved view", async () => {
    const { navigation } = renderBranchesView({});

    await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));

    fireEvent.click(screen.getByRole("button", GROUP_TRIGGER));
    fireEvent.click(screen.getByRole("combobox", PRIMARY_GROUPING_FIELD));
    fireEvent.click(await screen.findByRole("option", REPOSITORY_DIMENSION));

    await waitFor(() =>
      expect(screen.getByRole("button", ONE_GROUPING_LEVEL)).toBeTruthy()
    );

    fireEvent.click(
      screen.getByRole("button", { expanded: true, name: "web" })
    );

    await waitFor(() => {
      const url = new URL(navigation.getCurrentHref(), "http://localhost");
      expect(url.searchParams.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([
        COLLAPSED_REPO,
      ]);
    });

    await waitFor(() => {
      const record = findSavedViewRecord();
      expect(record).not.toBeNull();
      expect(record?.collapsedGroups[REPO_AXIS_KEY]).toEqual([COLLAPSED_REPO]);
    });
  });
});

function renderedRowCount(): number {
  // DATA rows only: the grid's chrome header row carries `data-grid-row-id`
  // too since ISS-10245 made `navigableHeaderCells` unconditional.
  return [
    ...document.querySelectorAll<HTMLElement>("[data-grid-row-id]"),
  ].filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")).length;
}

function findSavedViewRecord(): z.infer<
  typeof SAVED_VIEW_RECORD_SCHEMA
> | null {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(SAVED_VIEW_KEY_PREFIX)) {
      const raw = localStorage.getItem(key);
      if (raw) {
        return SAVED_VIEW_RECORD_SCHEMA.parse(JSON.parse(raw));
      }
    }
  }
  return null;
}

/**
 * A local render helper rather than the shared `renderView` (`./test-helpers`):
 * this suite needs the `MemoryNavigation` handle itself (`getCurrentHref`) to
 * assert on the URL a collapse gesture writes, which `renderView` builds and
 * discards internally.
 */
function renderBranchesView({
  initialPath = "/branches",
}: {
  initialPath?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const navigation = createMemoryNavigation({ initialPath });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({
              enabledFlags: [
                GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
                BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY,
              ],
            })}
          >
            <NavigationProvider adapter={navigation.adapter}>
              <SurfaceAnalyticsProvider
                capture={() => undefined}
                surface={Surface.Desktop}
              >
                <BranchesView dataSource={dataSource} />
              </SurfaceAnalyticsProvider>
            </NavigationProvider>
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
  return { ...result, navigation, queryClient };
}

function makeServerListResult(items: WireBranchRow[]): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    facets: {
      collaborators: emptyFacet,
      lastActiveRanges: emptyFacet,
      names: emptyFacet,
      owners: emptyFacet,
      pullRequests: emptyFacet,
      repositories: emptyFacet,
      statuses: emptyFacet,
      tags: emptyFacet,
    },
    items,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: 25,
      now: "2026-08-18T18:00:00.000Z",
      offset: 0,
      requestedOffset: 0,
    },
    total: items.length,
    viewerScope: BranchViewerScope.Self,
  };
}

/**
 * The one field this suite reads off a persisted saved-view record. Every
 * other field on the stored view is untyped here on purpose — `.passthrough()`
 * lets the rest of the record through unexamined rather than requiring this
 * test to restate the whole `BranchViewSnapshot` shape.
 */
const SAVED_VIEW_RECORD_SCHEMA = z
  .object({ collapsedGroups: PERSISTED_COLLAPSED_GROUPS_SCHEMA })
  .passthrough();
