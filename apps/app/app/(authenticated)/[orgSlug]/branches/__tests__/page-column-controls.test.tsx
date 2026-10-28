import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

/**
 * ISS-9676 — the WEB host's half of the column-controls contract.
 *
 * The package-level suite mounts `BranchesListSurfaceV2` under a static flag
 * adapter, which cannot tell a host that reaches the surface through its own
 * flag path apart from one that never does (whitlockk review). This drives the REAL
 * page: the key is turned on through the host's own
 * `useFeatureFlagEnabledOptional`, and the Group control has to partition the
 * rows THIS page renders.
 */

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  searchParamsMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchCohortAnalyticsMock: vi.fn(),
  useBranchesPageDataMock: vi.fn(),
}));
const { cohortRefetchMock, invalidateQueriesMock } = vi.hoisted(() => ({
  cohortRefetchMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
}));
const { flagEnabledOptionalMock } = vi.hoisted(() => ({
  flagEnabledOptionalMock: vi.fn<(flag: string) => boolean>(() => false),
}));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty: vi.fn() },
}));

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    analyticsRoot: () => ["branches", "analytics"],
    cohortAnalyticsRoot: () => ["branches", "cohort-analytics"],
    pageDataRoot: () => ["branches", "page-data"],
  },
  useBranchCohortAnalytics: useBranchCohortAnalyticsMock,
  useBranchesPageData: useBranchesPageDataMock,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: navigationReplaceMock,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/branches",
}));

// Stable identity, matching production: the page's backfill effect lists the
// client in its deps, so a fresh object per render would re-run it every render.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  useGitHubIntegrationStatus: () => ({
    data: { connected: true },
    isPending: false,
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  return {
    ...actual,
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
    useQueryClient: () => queryClient,
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

// The column-controls key is read through `useFeatureFlagEnabledOptional`, so
// that hook — not `useFeatureFlagEnabled`, not `useFeatureFlagGate` — is the
// host path this suite has to drive.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: (flag: string) =>
    flagEnabledOptionalMock(flag),
  // ISS-9692's page-size ladder reads the provider-optional gate. Routed to the
  // same control, and ready by default so this suite stays synchronous.
  useFeatureFlagGateOptional: (flag: string) => ({
    enabled: flagEnabledOptionalMock(flag),
    isReady: true,
  }),
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// Radix's select reads the pointer-capture API jsdom does not implement.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const RE_SORTED_BY = /^Sorted by/;
const RE_REPOSITORY_HEADER = /Repository/;
const GROUP_BUTTON_NAME = "Group";
const ADA = "Ada Lovelace";
const GRACE = "Grace Hopper";
const ROW_SELECTOR = "[data-grid-row-id]";
const ADAPTER_FLAGS: ReadonlySet<string> = new Set([
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
]);

/**
 * The DATA rows only. ISS-10245 made `navigableHeaderCells` unconditional, so
 * the grid's chrome header row carries `data-grid-row-id` too; counting it
 * would make "every row still renders" a claim about chrome.
 */
function dataRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(
    (row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")
  );
}
const ROWS = [
  makeBranchRow({ branchName: "feature/a", id: "branch-a", owner: ADA }),
  makeBranchRow({ branchName: "feature/b", id: "branch-b", owner: GRACE }),
];

beforeEach(() => {
  headerMock.mockReset();
  headerMock.mockImplementation(renderHeaderMock);
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReset();
  searchParamsMock.mockReturnValue(new URLSearchParams());
  navigationReplaceMock.mockReset();
  invalidateQueriesMock.mockReset();
  cohortRefetchMock.mockReset();
  useBranchCohortAnalyticsMock.mockReset();
  useBranchCohortAnalyticsMock.mockReturnValue({
    data: null,
    isError: false,
    isPending: false,
    refetch: cohortRefetchMock,
  });
  useBranchesPageDataMock.mockReset();
  useBranchesPageDataMock.mockReturnValue(
    pageDataResult({ list: makeListResponse(ROWS) })
  );
  flagEnabledOptionalMock.mockReset();
  flagEnabledOptionalMock.mockImplementation((flag) => ADAPTER_FLAGS.has(flag));
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("BranchesPage column controls (ISS-9676)", () => {
  it("bands the rows it renders when a grouping dimension is picked", async () => {
    flagEnabledOptionalMock.mockImplementation(
      (flag) =>
        ADAPTER_FLAGS.has(flag) ||
        flag === BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY
    );
    render(<BranchesPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: GROUP_BUTTON_NAME })
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Primary grouping field" })
    );
    fireEvent.click(await screen.findByRole("option", { name: "Author" }));

    // The band's collapse toggle, which only a rendered band emits — the owner
    // CELLS carry the same words, so a text query would pass over a flat table.
    for (const band of [ADA, GRACE]) {
      await waitFor(() =>
        expect(
          screen.getByRole("button", { expanded: true, name: band })
        ).toBeInTheDocument()
      );
    }
    // Every row still renders: a band is an arrangement, never a filter.
    expect(dataRows()).toHaveLength(ROWS.length);
  });

  it("keeps sorting but not grouping while the flag is off", async () => {
    render(<BranchesPage />);

    await waitFor(() => expect(dataRows()).toHaveLength(ROWS.length));
    expect(
      screen.queryByRole("button", { name: GROUP_BUTTON_NAME })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: RE_SORTED_BY })
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("columnheader", { name: RE_REPOSITORY_HEADER })
        .querySelector("button")
    ).not.toBeNull();
  });

  it("GV-OFF keeps sorting in the headers and the Filter label while gridview-adoption is off (ISS-13035)", async () => {
    flagEnabledOptionalMock.mockImplementation(() => false);
    render(<BranchesPage />);

    await waitFor(() => expect(dataRows()).toHaveLength(ROWS.length));
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RE_SORTED_BY })).toBeNull();
    expect(
      screen
        .getByRole("columnheader", { name: RE_REPOSITORY_HEADER })
        .querySelector("button")
    ).not.toBeNull();
  });
});
