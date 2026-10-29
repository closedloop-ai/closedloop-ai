/**
 * @file page-unavailable-monitoring.test.tsx
 * @description ISS-9725: a failed web Branches list read reaching the client
 * monitoring path, driven through the REAL page rather than the hook alone.
 *
 * The sibling `page-empty-state-semantics.test.tsx` proves the page SAYS the
 * right thing about a failed read. That is not the same as anyone outside the
 * browser hearing about it: before this, `isError` went to the screen and
 * nowhere else. So each case here asserts what arrived at the installed sink,
 * and pairs every silence with the same sink in the state that does emit.
 */
import { ListEmptyReason } from "@repo/api/src/list-empty-state";
import {
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "@repo/app/branches/lib/branch-sort-group";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "@repo/app/shared/api/api-timeout";
import { screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEventProperties } from "@/lib/analytics/client-event-sink";
import { setClientEventSink } from "@/lib/analytics/client-event-sink";
import { BRANCHES_LIST_UNAVAILABLE_EVENT } from "@/lib/branches/branches-list-unavailable-monitor";
import BranchesPage from "../page";
import {
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

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
const ROWS = [
  makeBranchRow({ branchName: "feature/a", id: "branch-a", owner: ADA }),
  makeBranchRow({ branchName: "feature/b", id: "branch-b", owner: ADA }),
];
/** The key `useBranchViewState("branches:web", true)` restores from. An
 * unbounded window is what makes the empty org reachable as `true_zero` rather
 * than as a date-narrowed `filtered`. */
const BRANCH_SAVED_VIEW_KEY = "branches:saved-view:branches:web:approved";
/** An owner facet no row carries, so the visible page narrows to zero. */
const UNMATCHED_OWNER_QUERY = "owner=Nobody";

let captured: Array<{ event: string; properties: ClientEventProperties }>;

function monitoredEvents() {
  return captured.filter(
    (entry) => entry.event === BRANCHES_LIST_UNAVAILABLE_EVENT
  );
}

beforeEach(() => {
  captured = [];
  setClientEventSink((event, properties) => {
    captured.push({ event, properties });
  });
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
  localStorage.clear();
});

afterEach(() => {
  setClientEventSink(undefined);
  localStorage.clear();
});

describe("BranchesPage failed-read monitoring (ISS-9725)", () => {
  it("reports a failed list read to the client monitoring path", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        error: new ApiError("branches unavailable", 503),
        isError: true,
        list: makeListResponse([]),
      })
    );

    render(<BranchesPage />);

    expect(
      await screen.findByText("Couldn't load branches")
    ).toBeInTheDocument();
    await waitFor(() => expect(monitoredEvents()).toHaveLength(1));
    expect(monitoredEvents()[0].properties).toEqual({
      reason: ListEmptyReason.Unavailable,
      httpStatus: 503,
    });
  });

  it("omits the status when the read timed out with no response", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        error: new ApiError(
          API_TIMEOUT_ERROR_MESSAGE,
          API_NO_RESPONSE_STATUS,
          API_TIMEOUT_ERROR_CODE
        ),
        isError: true,
        list: makeListResponse([]),
      })
    );

    render(<BranchesPage />);

    await waitFor(() => expect(monitoredEvents()).toHaveLength(1));
    expect(monitoredEvents()[0].properties).not.toHaveProperty("httpStatus");
    expect(monitoredEvents()[0].properties.reason).toBe(
      ListEmptyReason.Unavailable
    );
  });

  it("stays silent for a filtered-away page, which is not a failure", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams(UNMATCHED_OWNER_QUERY)
    );

    render(<BranchesPage />);

    // The paired positive: the page really did reach a settled zero-row state…
    expect(await screen.findByText("No matching branches")).toBeInTheDocument();
    // …and that state is NOT reported as a broken read.
    expect(monitoredEvents()).toHaveLength(0);
  });

  it("stays silent for a genuinely empty org over the all-time window", async () => {
    localStorage.setItem(
      BRANCH_SAVED_VIEW_KEY,
      JSON.stringify({
        dateRange: "all",
        sortDir: DEFAULT_BRANCH_SORT_DIR,
        sortKey: DEFAULT_BRANCH_SORT_KEY,
      })
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([]) })
    );

    render(<BranchesPage />);

    // The paired positive: the page really reached the true-zero treatment,
    // which is a DIFFERENT screen from the filtered one above…
    expect(await screen.findByText("No branches yet")).toBeInTheDocument();
    // …and neither of them is reported as a failed read.
    expect(monitoredEvents()).toHaveLength(0);
  });

  it("reports one record per failure, not one per commit", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        error: new ApiError("branches unavailable", 503),
        isError: true,
        list: makeListResponse([]),
      })
    );

    const view = render(<BranchesPage />);
    expect(
      await screen.findByText("Couldn't load branches")
    ).toBeInTheDocument();
    await waitFor(() => expect(monitoredEvents()).toHaveLength(1));

    view.rerender(<BranchesPage />);
    view.rerender(<BranchesPage />);

    expect(monitoredEvents()).toHaveLength(1);
  });
});
