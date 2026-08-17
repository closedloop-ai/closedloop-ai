import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { render, screen } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  RECENT_ACTIVITY_AT,
  renderHeaderMock,
} from "./branches-page-fixtures";

/**
 * ISS-4655: the Branches read is issued once, against the window the user keeps.
 *
 * Two independent defects made one page view paginate the whole corpus several
 * times, and this file covers the PAGE's half of each — the composition, not the
 * helpers, which are unit-covered in `packages/app`. Both assertions read the
 * arguments the page actually hands `useBranchesPageData`, so deleting either
 * wiring reds them:
 *
 *  - the window in the query key must be stable across mounts milliseconds apart
 *    (`getStableUtcDateWindowForRange`, not the ms-precision `getStartDateForRange`);
 *  - the read must not fire before the persisted view has restored (`enabled`).
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
  githubKeys: { all: ["github"] },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  return { ...actual, useQueryClient: () => queryClient };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// Midday on the fixture row's own UTC date. Anchored to the fixture (one day
// before the REAL clock) rather than pinned to an ISO literal, so the row stays
// inside the page's 30d window and the table actually renders it — a hardcoded
// past date would put every row out of window and quietly reduce these to
// assertions about an empty table. Midday rather than the raw fixture instant so
// the two reads below cannot straddle UTC midnight.
const fixtureActivity = new Date(RECENT_ACTIVITY_AT);
const FIRST_READ = new Date(
  Date.UTC(
    fixtureActivity.getUTCFullYear(),
    fixtureActivity.getUTCMonth(),
    fixtureActivity.getUTCDate(),
    12
  )
);
// 270ms later — the exact interval the RUM evidence caught issuing two
// overlapping full paginations under two distinct `startDate` values.
const SECOND_READ = new Date(FIRST_READ.getTime() + 270);
// One UTC day later: the bucket the window must still follow.
const NEXT_DAY_READ = new Date(FIRST_READ.getTime() + 86_400_000);

type PageDataOptions = { enabled?: boolean };

function pageDataCalls() {
  return useBranchesPageDataMock.mock.calls as [
    Record<string, unknown>,
    PageDataOptions,
    unknown,
  ][];
}

function renderAt(now: Date, wrapper?: (node: ReactNode) => ReactNode) {
  vi.setSystemTime(now);
  const page = <BranchesPage />;
  return render(wrapper ? wrapper(page) : page);
}

beforeEach(() => {
  // Fake only `Date` so the window is deterministic while the async timers
  // behind `act` — and the hook's auth deadline — keep the real clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  headerMock.mockReset();
  apiPostMock.mockReset();
  searchParamsMock.mockReset();
  useBranchesPageDataMock.mockReset();
  cohortRefetchMock.mockReset();
  navigationReplaceMock.mockReset();
  invalidateQueriesMock.mockReset();
  useBranchCohortAnalyticsMock.mockReset();
  useBranchCohortAnalyticsMock.mockReturnValue({
    data: null,
    isError: false,
    isPending: false,
    refetch: cohortRefetchMock,
  });
  headerMock.mockImplementation(renderHeaderMock);
  useBranchesPageDataMock.mockReturnValue(
    pageDataResult({ list: makeListResponse([makeBranchRow()]) })
  );
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReturnValue(new URLSearchParams());
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("BranchesPage query-key stability (ISS-4655 cause 1)", () => {
  it("sends byte-identical filters for two mounts 270ms apart", () => {
    const first = renderAt(FIRST_READ);
    const firstFilters = pageDataCalls()[0][0];
    first.unmount();

    useBranchesPageDataMock.mockClear();
    const second = renderAt(SECOND_READ);
    const secondFilters = pageDataCalls()[0][0];
    second.unmount();

    // Not just deep-equal shapes: the query key is these values, so any drift
    // here is a fresh cache entry and another full pagination.
    expect(secondFilters).toEqual(firstFilters);
    expect(firstFilters.startDate).toEqual(expect.any(String));
  });

  it("renders the fixture row inside the window it computes", () => {
    // Guards the two window tests either side of this one: they read the
    // filters the page emits, which it would emit just as happily with every
    // row filtered out of the window and an empty table behind them.
    const view = renderAt(FIRST_READ);
    expect(screen.getByText("feature/web-branches")).toBeInTheDocument();
    view.unmount();
  });

  it("still moves the window when the UTC day rolls over", () => {
    const first = renderAt(FIRST_READ);
    const firstFilters = pageDataCalls()[0][0];
    first.unmount();

    useBranchesPageDataMock.mockClear();
    const second = renderAt(NEXT_DAY_READ);
    const secondFilters = pageDataCalls()[0][0];
    second.unmount();

    // A key that never changed would pin the list to a stale window instead of
    // following the rolling lookback — the opposite failure to the one above.
    expect(secondFilters).not.toEqual(firstFilters);
  });
});

describe("BranchesPage restore gating (ISS-4655 cause 2)", () => {
  it("does not read while auth is hydrating and the saved window is unknown", () => {
    const hydrating = createStaticAuthAdapter({ isLoaded: false });
    const view = renderAt(FIRST_READ, (node) => (
      <AuthAdapterProvider adapter={hydrating}>{node}</AuthAdapterProvider>
    ));

    const calls = pageDataCalls();
    expect(calls.length).toBeGreaterThan(0);
    // Every render, not just the first: one enabled pass anywhere in here is a
    // full corpus pagination against a window the restore is about to replace.
    for (const [, options] of calls) {
      expect(options.enabled).toBe(false);
    }
    view.unmount();
  });

  it("reads once auth has resolved and the view has restored", () => {
    const resolved = createStaticAuthAdapter({ userId: "user_alice" });
    const view = renderAt(FIRST_READ, (node) => (
      <AuthAdapterProvider adapter={resolved}>{node}</AuthAdapterProvider>
    ));

    const calls = pageDataCalls();
    expect(calls.at(-1)?.[1].enabled).toBe(true);
    view.unmount();
  });
});
