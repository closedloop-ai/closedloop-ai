import { BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/branches-summary-honest-loading-flag";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  cardText,
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

/**
 * ISS-9887 — the Branches metric strip must not state the previous window's
 * figures as current while the read for the new one is in flight.
 *
 * WHAT THESE CASES PIN, exactly: the rendered outcome on the shipped web path.
 * They do NOT pin the `summaryIsReloading` prop this page threads — measured by
 * counterfactual, replacing it with `{false}` leaves all three green, because
 * `selectPresentedBranchPageData` withholds a previous-key payload, so
 * `summaryAnalyticsPending` is already true and reaches the skeleton first. The
 * prop is pinned where it is the deciding input, in
 * `apps/desktop/src/renderer/components/branches/__tests__/branches-view-placeholder-data.test.tsx`
 * (that one does fail under the same mutation), and the fold itself is unit-
 * pinned in `packages/app/shared/lib/__tests__/summary-metrics-loading.test.ts`.
 *
 * Kept as its own file because this suite mocks the auth port, and that mock
 * would change the persisted-view keys `page.test.tsx` already pins. It
 * replaces the reload cases ISS-9897 (#7350) deleted along with the metric-card
 * snapshot mechanism; the snapshot-branch case is genuinely retired and is not
 * carried forward.
 */

const ACTIVE_BRANCHES_LABEL = "Active branches";
const FROZEN_NOW = new Date("2026-07-05T12:00:00.000Z");

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  searchParamsMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
  featureFlagEnabledMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchCohortAnalyticsMock: vi.fn(),
  useBranchesPageDataMock: vi.fn(),
  featureFlagEnabledMock: vi.fn<(flag: string) => boolean>(() => false),
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

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => {
  const snapshot = {
    getToken: () => Promise.resolve(null),
    isLoaded: true,
    orgId: "org_test",
    userId: "user_test",
  };
  return {
    useAuthSnapshot: () => snapshot,
    useOptionalAuthSnapshot: () => snapshot,
  };
});

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Ready by default, so suites written before the gate
  // keep their synchronous behaviour.
  useFeatureFlagGateOptional: (flag: string) => ({
    enabled: featureFlagEnabledMock(flag),
    isReady: true,
  }),
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
  // The server-pagination gate stays closed here; this suite is about the
  // summary row, and the client-paged path is the shipped default.
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
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
  const queryClient = { invalidateQueries: vi.fn() };
  return {
    ...actual,
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
    useQueryClient: () => queryClient,
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("branches summary scope-change loading (ISS-9887)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    localStorage.clear();
    featureFlagEnabledMock.mockImplementation(() => false);
    headerMock.mockImplementation(renderHeaderMock);
    searchParamsMock.mockReturnValue(new URLSearchParams());
    useBranchCohortAnalyticsMock.mockReturnValue({
      data: undefined,
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.clearAllMocks();
  });

  function enableHonestLoading() {
    featureFlagEnabledMock.mockImplementation(
      (flag) => flag === BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY
    );
  }

  function renderHoldingPreviousScope(isPlaceholderData: boolean) {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        isPlaceholderData,
        list: makeListResponse([makeBranchRow()]),
      })
    );
    return render(<BranchesPage />);
  }

  it("does not state the previous window's figures while the new one loads", () => {
    enableHonestLoading();

    const { container } = renderHoldingPreviousScope(true);

    expect(cardText(ACTIVE_BRANCHES_LABEL)).not.toContain("1");
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("states them again once the read is serving this window", () => {
    // The positive control: identical props with the placeholder flag cleared
    // DO print the figure, so its absence above is the reload treatment and
    // not a fixture that renders nothing.
    enableHonestLoading();

    const { container } = renderHoldingPreviousScope(false);

    expect(cardText(ACTIVE_BRANCHES_LABEL)).toContain("1");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("leaves the reload window unskeletoned while the gate is closed", () => {
    const { container } = renderHoldingPreviousScope(true);

    expect(cardText(ACTIVE_BRANCHES_LABEL)).not.toContain(
      LIST_SUMMARY_LOADING_DETAIL
    );
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
