import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { screen, waitFor } from "@testing-library/react";
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
 * ISS-9429 — the WEB host's half of the list state contract.
 *
 * The package-level suites mount the shared body directly and hand it whatever
 * signals they like, so they cannot tell a host that derives those signals
 * honestly from one that hardcodes them. This drives the REAL page: the org is
 * populated, an owner facet narrows it to nothing, and what the page says about
 * that has to distinguish a narrowed read from an empty org and from a failed
 * one. Web is the host that got both wrong — it passed a bare `rows.length > 0`
 * where desktop passed a file-private filters-are-active correction web could
 * not import.
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

vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
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

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const ADA = "Ada Lovelace";
/** A populated org: the list is never actually empty in any case below. */
const ROWS = [
  makeBranchRow({ branchName: "feature/a", id: "branch-a", owner: ADA }),
  makeBranchRow({ branchName: "feature/b", id: "branch-b", owner: ADA }),
];
/** An owner facet no row carries, so the visible page narrows to zero. */
const UNMATCHED_OWNER_QUERY = "owner=Nobody";

beforeEach(() => {
  headerMock.mockReset();
  headerMock.mockImplementation(renderHeaderMock);
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReset();
  searchParamsMock.mockReturnValue(new URLSearchParams(UNMATCHED_OWNER_QUERY));
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
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("BranchesPage zero-row semantics (ISS-9429)", () => {
  // The date window is NOT what emptied this page, the owner facet is. Offering
  // "Show all time" would name a fix that is not one — and it is exactly the
  // button that appears if the host reports no active filters, which is what
  // web did before it could reach the shared `branchFiltersAreActive`.
  it("names a facet-narrowed page and withholds the date reset", async () => {
    render(<BranchesPage />);

    expect(await screen.findByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No branches match the current filters. Try clearing a filter."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });

  // The failed read over a narrowed page. `isError` with the corpus still held
  // used to miss the error branch entirely and render the settled filtered
  // empty above — a confident "nothing matched" about a read that failed.
  it("names a failed read rather than a filtered empty", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ isError: true, list: makeListResponse(ROWS) })
    );

    render(<BranchesPage />);

    expect(
      await screen.findByText("Couldn't load branches")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    );
    expect(screen.queryByText("No matching branches")).toBeNull();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });
});
