import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { waitFor } from "@testing-library/react";
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
 * ISS-9447 M5 — the WEB host's half of the saved-view CAPTURE.
 *
 * Both shells read the rows-per-page from `useBranchViewState` and assemble
 * their own snapshot object, and the desktop half is pinned in
 * `apps/desktop/src/renderer/components/branches/__tests__/branches-view.test.tsx`.
 * This is the web half, and it exists because the compiler cannot cover it: the
 * page holds TWO numbers named for a page size — `savedPageSize` (the reader's
 * stored choice) and `branchPageSize` (that choice resolved against the ladder
 * flag and the v2 rollout) — and `pageSize: number` accepts either. Capturing the
 * resolved one would write a size the reader never picked into a durable record,
 * silently, on a surface where nothing renders the difference.
 */

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  searchParamsMock,
  savedViewsSnapshotMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  searchParamsMock: vi.fn(),
  savedViewsSnapshotMock: vi.fn(),
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

// The store itself is covered by its own suite; what this file needs is the
// snapshot the PAGE hands it.
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The page now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review); this file still only cares about the snapshot.
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: (_store: unknown, snapshot: unknown) => {
    savedViewsSnapshotMock(snapshot);
    return {
      views: [],
      activeViewId: null,
      modified: false,
      isArrangementSettled: true,
      onSelectView: vi.fn(),
      onCreateView: vi.fn(),
      onUpdateView: vi.fn(),
      onRenameView: vi.fn(),
      onDeleteView: vi.fn(),
    };
  },
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

// The link states a rows-per-page the reader's saved view does not: the surface
// PAGES by this one, and the two capture candidates are observably different
// numbers for as long as the case runs.
const LINKED_PAGE_SIZE = 50;
const ROWS = [makeBranchRow({ branchName: "feature/a", id: "branch-a" })];

beforeEach(() => {
  headerMock.mockReset();
  headerMock.mockImplementation(renderHeaderMock);
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReset();
  searchParamsMock.mockReturnValue(
    new URLSearchParams(`pageSize=${LINKED_PAGE_SIZE}`)
  );
  navigationReplaceMock.mockReset();
  invalidateQueriesMock.mockReset();
  cohortRefetchMock.mockReset();
  savedViewsSnapshotMock.mockReset();
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

describe("BranchesPage saved-view capture (ISS-9447 M5)", () => {
  it("captures the reader's stored rows-per-page, not the size the link is paging by", async () => {
    render(<BranchesPage />);

    await waitFor(() => expect(savedViewsSnapshotMock).toHaveBeenCalled());
    const snapshot = savedViewsSnapshotMock.mock.calls.at(-1)?.[0] as
      | { columnWidths?: Record<string, number>; pageSize?: number }
      | undefined;

    expect(snapshot?.pageSize).toBe(DEFAULT_TABLE_PAGE_SIZE);
    expect(snapshot?.pageSize).not.toBe(LINKED_PAGE_SIZE);
    expect(snapshot?.columnWidths).toEqual({});
  });
});
