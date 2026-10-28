import type {
  BranchListResponse,
  BranchQueryFilters,
  BranchRow,
} from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BranchListCohortScope,
  branchListCohortKey,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import type { BranchCohortNoticeModel } from "@repo/app/branches/lib/branch-cohort-transparency";
import { BranchCohortNoticeKind } from "@repo/app/branches/lib/branch-cohort-transparency";
import { BRANCH_PAGE_SIZE } from "@repo/app/branches/lib/branch-filter-params";
import {
  BranchSortDir,
  BranchSortKey,
} from "@repo/app/branches/lib/branch-sort-group";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  DEFAULT_DATE_RANGE,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { TABLE_PAGE_SIZE_OPTIONS } from "@repo/design-system/components/ui/table-page-size-select";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  cardText,
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  RECENT_ACTIVITY_AT,
  renderBranchesPage as render,
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
const { cohortNoticeMock } = vi.hoisted(() => ({
  cohortNoticeMock: vi.fn(),
}));
const { statusOrderingGateMock } = vi.hoisted(() => ({
  statusOrderingGateMock: vi.fn(() => ({ enabled: false, isReady: true })),
}));
const { optionalFlagMock } = vi.hoisted(() => ({
  optionalFlagMock: vi.fn<(flag: string) => boolean>(() => false),
}));
const { setViewContextProperty } = vi.hoisted(() => ({
  setViewContextProperty: vi.fn(),
}));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty },
}));
const RETRY_BUTTON_NAME_PATTERN = /retry/i;
const ONE_ITEM_READOUT_PATTERN = /of 1/i;
/**
 * `SUMMARY_CARD_STRETCH_CLASS`'s flex basis. Written out here rather than
 * imported so a change to it has to be made deliberately instead of silently
 * agreeing with itself, which is the convention the desktop strip tests already
 * follow.
 */
const STRETCH_BASIS_CLASS = "basis-[var(--summary-card-min)]";

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

// The shipped notice renders NOTHING for Complete, Partial, Unavailable, and
// Hidden alike, so the model the page composed is not observable in the DOM.
// Capture it at the mount site instead — the same technique the sibling
// summary-card and toolbar suites use.
vi.mock("@repo/app/branches/components/branch-cohort-notice", () => ({
  BranchCohortNotice: (props: { model: BranchCohortNoticeModel }) => {
    cohortNoticeMock(props);
    return null;
  },
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

vi.mock("@repo/design-system/components/ui/select", () => ({
  Select: ({
    children,
    disabled,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <select
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

// Stable identity, matching production: the page's backfill effect lists the
// client in its deps, so a fresh object per render would re-run it every render.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  // ISS-7408: `usePostConnectBackfill` reads `backfill()` on every render, so a
  // stub without it throws before any assertion in this file runs.
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  // ISS-5958: the page reads the GitHub status to decide whether its gated CTA
  // says connect or reconnect. This suite is about the Branch read's query keys,
  // so the status stays unresolved — which the resolver reports as "unknown".
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  // ISS-7408: the backfill poll is covered by its hook suite; this page suite isolates its read.
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Closed and ready, matching this suite's other gates.
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: (flag: string) => optionalFlagMock(flag),
  useFeatureFlagGate: (flag: string) => {
    if (flag === ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY) {
      return statusOrderingGateMock();
    }
    return { enabled: false, isReady: true };
  },
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// Midday on the fixture row's own UTC date. Anchored to the fixture (one day
// before the REAL clock) rather than pinned to an ISO literal, so the row stays
// inside the page's default window and the table actually renders it — a
// hardcoded past date would put every row out of window and quietly reduce
// these to assertions about an empty table. Midday rather than the raw fixture
// instant so the two reads below cannot straddle UTC midnight.
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

// The server's own instant for the page, a row that settled one day AFTER it,
// and a viewer whose system clock is a decade past both. On the server-page
// path the client window filter is skipped entirely (`resolveBranchDisplayRows`),
// so the skew cannot quietly empty the table.
const SERVER_PAGE_NOW = "2026-08-19T12:00:00.000Z";
const SERVER_PAGE_ROW_ACTIVITY = "2026-08-20T12:00:00.000Z";
// A page whose corpus is larger than the rows it carries, so `completeCorpus`
// is false and the producer cohort is the only source of exact counts.
const BOUNDED_COHORT_BRANCH_NAME = "feature/bounded-cohort";
const BOUNDED_COHORT_TOTAL = 3;
const BOUNDED_COHORT_RETAINED = 1;
const ROWS_PER_PAGE_25_OPTION = "25 / page";
const ROWS_PER_PAGE_100_OPTION = "100 / page";
const ROWS_PER_PAGE_50_OPTION = "50 / page";

// The saved-view key this page's `useBranchViewState("branches:web", true)`
// resolves to. Both halves are module-local to their owning hooks (a page
// module may not re-export them), so they are redeclared here exactly as the
// e2e anchors in `page.tsx` are — a drift on either side reds the restore
// assertion below rather than passing on a key nothing reads.
const BRANCHES_SAVED_VIEW_KEY_PREFIX = "branches:saved-view:";
const BRANCHES_WEB_APPROVED_VIEW_KEY = "branches:web:approved";
const SAVED_VIEW_USER_ID = "user_alice";
// Deliberately NOT the shared default: a saved view equal to the default cannot
// distinguish a gated tag from an ungated one.
const SAVED_VIEW_RANGE = "90d";

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
  cohortNoticeMock.mockReset();
  statusOrderingGateMock.mockReturnValue({ enabled: false, isReady: true });
  optionalFlagMock.mockReset();
  optionalFlagMock.mockReturnValue(false);
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
  /**
   * ISS-10301: the asserted `limit` moved from `BRANCH_LIST_SERVER_PAGE_SIZE`
   * (20) to `BRANCH_PAGE_SIZE` (25) because the OPERAND changed, not because the
   * expectation was weakened: the page used to select the fixed legacy size on
   * the `grid-table-v2` OFF arm, and now reads `serverControls.pageSize`
   * unconditionally. Still exactly one request, still page 0.
   */
  it("waits for the rollout gate and requests exactly one fixed Product page", () => {
    const resolved = createStaticAuthAdapter({ userId: "user_alice" });
    const view = renderAt(FIRST_READ, (node) => (
      <AuthAdapterProvider adapter={resolved}>{node}</AuthAdapterProvider>
    ));

    expect(pageDataCalls().at(-1)?.[0]).toMatchObject({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    });
    expect(pageDataCalls().at(-1)?.[1].enabled).toBe(true);
    view.unmount();
  });

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
    // Stability alone is satisfied by a stably WRONG window, so pin which one:
    // the first paint owes the shared default, composed through the canonical
    // helper (whose arithmetic is pinned against literals in format-utils').
    expect(firstFilters.startDate).toBe(
      getStableUtcDateWindowForRange(DEFAULT_DATE_RANGE, FIRST_READ).startDate
    );
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

describe("BranchesPage Grid Table v2 surface swap (ISS-7053)", () => {
  it("uses the shared page-size ladder without adding a Branches search box", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("page=2"));
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse(
          Array.from({ length: 47 }, (_value, index) =>
            makeBranchRow({
              id: `branch-${index}`,
              branchName: `feature/web-branches-${index}`,
            })
          )
        ),
      })
    );

    const view = renderAt(FIRST_READ);

    expect(pageDataCalls().at(-1)?.[0]).toMatchObject({
      limit: TABLE_PAGE_SIZE_OPTIONS[0],
      offset: 25,
      pageMode: BranchListPageMode.Server,
    });
    expect(screen.getByText("1–25 of 47")).toBeInTheDocument();
    const scrollRegion = screen.getByRole("region", { name: "Branches" });
    expect(scrollRegion).toHaveAttribute(
      "data-testid",
      "branches-scroll-container"
    );
    expect(scrollRegion).toHaveAttribute("tabindex", "0");
    const summaryCardRow = screen
      .getByText("Active branches")
      .closest("[data-density]");
    // #7544: the strip is ONE rank that STRETCHES to fill the band. The three
    // classes below are what distinguish that from the two layouts it is not,
    // and jsdom lays out no boxes, so this file asserts the emitted class list
    // and nothing about the resulting geometry — that is measured on the
    // launched shell by `expectMetricsCardsToSpanBandAtDesktopWidth`
    // (`apps/desktop/test/e2e/branches-page.spec.ts`).
    //
    // `flex` + the host's `overflow-x-auto` is the fixed rank: a rank too wide
    // for the band scrolls rather than wrapping, which is what keeps the band
    // from taking a second rank out of the sibling table's `min-h-0 flex-1`
    // scroll region. `grow` on the card is the stretch that the pre-#7544 strip
    // lacked, and `shrink-0` beside `basis-[var(--summary-card-min)]` is what
    // holds the published floor as a hard minimum rather than a suggestion.
    // Counting cards cannot see any of this, so do not swap it for a count.
    expect(summaryCardRow).toHaveClass("flex", "overflow-x-auto");
    expect(summaryCardRow).not.toHaveClass("grid");
    const firstCard = summaryCardRow?.querySelector('[data-slot="card"]');
    expect(firstCard).toHaveClass("grow", "shrink-0", STRETCH_BASIS_CLASS);
    expect(firstCard).not.toHaveClass("w-full");
    expect(screen.queryByRole("searchbox")).toBeNull();

    const fiftyPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_50_OPTION,
    });
    const pageSizeSelect = fiftyPerPage.closest("select") as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: "50" } });

    await waitFor(() =>
      expect(pageDataCalls().at(-1)?.[0]).toMatchObject({
        limit: 50,
        offset: 0,
        pageMode: BranchListPageMode.Server,
      })
    );
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/acme/branches?pageSize=50",
      { scroll: false }
    );

    const hundredPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_100_OPTION,
    });
    const updatedPageSizeSelect = hundredPerPage.closest(
      "select"
    ) as HTMLSelectElement;
    fireEvent.change(updatedPageSizeSelect, { target: { value: "100" } });

    await waitFor(() =>
      expect(pageDataCalls().at(-1)?.[0]).toMatchObject({
        limit: 100,
        offset: 0,
        pageMode: BranchListPageMode.Server,
      })
    );
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/acme/branches?pageSize=100",
      { scroll: false }
    );
    view.unmount();
  });

  it("keeps the v2 page-size footer mounted but disabled while server placeholder rows are withheld", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeServerPageListResponse("feature/server-before-toggle"),
        isPlaceholderData: true,
      })
    );

    const view = renderAt(FIRST_READ);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();
    const rowsPerPage = screen
      .getByRole("option", { name: ROWS_PER_PAGE_25_OPTION })
      .closest("select");
    expect(rowsPerPage).toBeDisabled();
    expect(screen.queryByText("feature/server-before-toggle")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
  });
});

describe("BranchesPage server placeholder presentation (ISS-7197)", () => {
  it("withholds the previous cohort until the selected key settles", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ branchName: "feature/previous-window" }),
        ]),
        isPlaceholderData: true,
      })
    );

    renderAt(FIRST_READ);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();
    expect(
      screen.queryByText("feature/previous-window")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: ONE_ITEM_READOUT_PATTERN })
    ).not.toBeInTheDocument();
    expect(cardText("Active branches")).toContain("—");
    expect(cardText("Active branches")).not.toContain("1");
  });

  it("shows error and Retry without restoring previous-key data", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ branchName: "feature/previous-window" }),
        ]),
        isError: true,
        isPlaceholderData: true,
      })
    );

    renderAt(FIRST_READ);

    expect(screen.getByText("Couldn't load branches")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading branches…")).not.toBeInTheDocument();
    expect(
      screen.queryByText("feature/previous-window")
    ).not.toBeInTheDocument();
  });

  it("withholds complete-list placeholder rows after server paging graduates", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ branchName: "feature/legacy-placeholder" }),
        ]),
        isPlaceholderData: true,
      })
    );

    renderAt(FIRST_READ);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();
    expect(
      screen.queryByText("feature/legacy-placeholder")
    ).not.toBeInTheDocument();
  });

  it("withholds a server-produced placeholder on the bounded server-page path", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeServerPageListResponse("feature/server-before-toggle"),
        isPlaceholderData: true,
      })
    );

    renderAt(FIRST_READ);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();
    expect(
      screen.queryByText("feature/server-before-toggle")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: ONE_ITEM_READOUT_PATTERN })
    ).not.toBeInTheDocument();
  });

  it("renders matching-key cached data on the server-page path", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ branchName: "feature/matching-cache" }),
        ]),
      })
    );

    renderAt(FIRST_READ);

    expect(screen.getByText("feature/matching-cache")).toBeInTheDocument();
    expect(screen.queryByText("Loading branches…")).not.toBeInTheDocument();
  });

  /**
   * ISS-7125: the page must key the cohort comparison from the filter set it
   * actually READ. `cohortKey` is a required parameter, so deleting it fails
   * typecheck — but computing it from `filters`, a stale variable, or `{}`
   * compiles, and no other case here can catch that: every other fixture omits
   * `lastActiveCohort` and sets `total === items.length`, which makes
   * `completeCorpus` true and short-circuits the comparison entirely.
   *
   * So this answers the read the way a producer does — keying the cohort on the
   * request it was handed — over a bounded page (`total` > rows) so the
   * comparison runs. A wrong argument names a different request, the equality
   * gate rejects the cohort, and the model degrades to `Unavailable`.
   */
  it("keys the cohort comparison from the filter set it read", () => {
    optionalFlagMock.mockImplementation(
      (flag) => flag === BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY
    );
    useBranchesPageDataMock.mockImplementation((filters: BranchQueryFilters) =>
      pageDataResult({ list: makeBoundedCohortPage(filters) })
    );

    renderAt(FIRST_READ);

    // Positive control: the page really presented this page, so the model below
    // cannot be an unmounted notice in disguise.
    expect(screen.getByText(BOUNDED_COHORT_BRANCH_NAME)).toBeInTheDocument();
    expect(lastCohortNoticeModel()).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: BOUNDED_COHORT_TOTAL,
      knownInWindow: BOUNDED_COHORT_TOTAL - BOUNDED_COHORT_RETAINED,
      retainedUnavailable: BOUNDED_COHORT_RETAINED,
    });
  });
});

/**
 * ISS-10350: retiring the REQUEST clock must not take the RESPONSE clock with
 * it. The producer still stamps its evaluation instant on every page, and
 * `validTimestamp` drops any `lastActivityAt` past `now` — so presenting on the
 * viewer's clock makes a genuinely recent branch on a browser that trails the
 * API read as an em-dash and counts it against the cohort as unavailable.
 *
 * The page-level wiring is what regressed and what was unpinned: deleting
 * `now: evaluationNow` from the page's `adaptBranchRows` call left every suite
 * in this file green. These two cases move the row across the producer's own
 * instant and nothing else, so only the wired clock separates them.
 */
describe("BranchesPage producer-clock presentation (ISS-10350)", () => {
  const PRODUCER_NOW = new Date(FIRST_READ.getTime() + 120_000).toISOString();
  const BEFORE_PRODUCER_NOW = new Date(
    FIRST_READ.getTime() + 60_000
  ).toISOString();
  const AFTER_PRODUCER_NOW = new Date(
    FIRST_READ.getTime() + 180_000
  ).toISOString();
  const CLOCK_BRANCH_NAME = "feature/producer-clock";

  function renderRowSettledAt(lastActivityAt: string) {
    optionalFlagMock.mockImplementation(
      (flag) => flag === BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: {
          ...makeListResponse([
            makeBranchRow({
              branchName: CLOCK_BRANCH_NAME,
              lastActivityAt,
            }),
          ]),
          lastActiveCohort: completeBranchLastActiveCohort({
            scope: BranchListCohortScope.RequestFilters,
            cohortKey: branchListCohortKey({}),
            evaluationNow: new Date(PRODUCER_NOW),
            total: 1,
            retainedUnavailable: 0,
          }),
        },
      })
    );

    // The viewer's clock trails the producer's by two minutes in both cases.
    renderAt(FIRST_READ);
  }

  it("keeps a row the producer's clock says already settled", () => {
    renderRowSettledAt(BEFORE_PRODUCER_NOW);

    // Positive control: the page really presented this page, so the Hidden
    // model below cannot be an unmounted notice or a withheld window in
    // disguise.
    expect(screen.getByText(CLOCK_BRANCH_NAME)).toBeInTheDocument();
    expect(lastCohortNoticeModel()).toEqual({
      kind: BranchCohortNoticeKind.Hidden,
      total: 1,
    });
  });

  it("still reports a row that settled after the producer's own instant", () => {
    renderRowSettledAt(AFTER_PRODUCER_NOW);

    expect(screen.getByText(CLOCK_BRANCH_NAME)).toBeInTheDocument();
    expect(lastCohortNoticeModel()).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: 1,
      knownInWindow: 0,
      retainedUnavailable: 1,
    });
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

/**
 * ISS-9437 (marisolashgrove review on #6928): no row may exist before the order to
 * sort it in does.
 *
 * `useFeatureFlagEnabled` reads `false` while PostHog is still answering, which
 * is indistinguishable from a real "off". Acting on it let the client comparator
 * sort the corpus in vocabulary order and re-sort it under the reader when the
 * assignment landed — and `useBranchServedStatusOrderingReset` cannot catch that
 * one, because `servedStatusOrdering` is null on the combined path. The page
 * therefore folds the ordering key's READINESS into the read's `enabled`.
 *
 * The second case is the control: a gate that is ready must not hold the read,
 * or this would "pass" by never reading at all.
 */
describe("BranchesPage status-ordering readiness (ISS-9437)", () => {
  it("does not read while the status-ordering flag is still unresolved", () => {
    statusOrderingGateMock.mockReturnValue({ enabled: false, isReady: false });

    const view = renderAt(FIRST_READ);

    const calls = pageDataCalls();
    expect(calls.length).toBeGreaterThan(0);
    // Every render, not only the last: one enabled pass anywhere here is a
    // corpus the comparator sorts before it knows which order to sort it in.
    for (const [, options] of calls) {
      expect(options.enabled).toBe(false);
    }
    view.unmount();
  });

  it("reads once the status-ordering flag has resolved", () => {
    statusOrderingGateMock.mockReturnValue({ enabled: false, isReady: true });

    const view = renderAt(FIRST_READ);

    expect(pageDataCalls().at(-1)?.[1].enabled).toBe(true);
    view.unmount();
  });
});

/**
 * ISS-7250: proves THIS route reaches the shared telemetry hook. The hook's own
 * suite owns the range-CHANGE path; without this, deleting the `useRumViewRange`
 * call from the page would leave that suite green.
 */
describe("BranchesPage RUM range attribute (ISS-7250)", () => {
  it("retags its view when the operator picks a different window", async () => {
    setViewContextProperty.mockReset();
    const view = renderAt(FIRST_READ);
    expect(setViewContextProperty).toHaveBeenCalledWith("range_days", "7");

    await userEvent.click(screen.getByRole("radio", { name: "Last 90 days" }));

    // The route must report the window it actually queried, not a constant: a
    // page hardcoding the default would satisfy the first assertion alone.
    expect(setViewContextProperty).toHaveBeenCalledWith("range_days", "90");
    view.unmount();
  });

  /**
   * ISS-7250 (whitlockk review). The persisted view restores in a POST-MOUNT effect
   * by design (FEA-4125), so a saved-90d viewer's first commit still holds the
   * 7d default. Ungated, the tag wrote `7` to the live Datadog view and only
   * corrected it after the restore — bucketing any view/update emitted in that
   * window under a range the user never selected, which is precisely the
   * cross-range averaging this attribute exists to remove.
   *
   * The whole call list, not a `not.toHaveBeenCalledWith`: the requirement is
   * that NOTHING is written while the window is unknown, so an extra write of
   * any value has to red this. A saved view equal to the default cannot
   * reproduce it — it passes identically with and without the gate.
   */
  it("writes no range at all until the saved 90d view has restored", () => {
    setViewContextProperty.mockReset();
    localStorage.setItem(
      `${BRANCHES_SAVED_VIEW_KEY_PREFIX}${BRANCHES_WEB_APPROVED_VIEW_KEY}:u:${SAVED_VIEW_USER_ID}`,
      JSON.stringify({
        sortKey: BranchSortKey.LastActivity,
        sortDir: BranchSortDir.Desc,
        dateRange: SAVED_VIEW_RANGE,
        hiddenColumns: [],
        columnOrder: [],
        columnWidths: {},
      })
    );
    const resolved = createStaticAuthAdapter({ userId: SAVED_VIEW_USER_ID });

    const view = renderAt(FIRST_READ, (node) => (
      <AuthAdapterProvider adapter={resolved}>{node}</AuthAdapterProvider>
    ));

    expect(setViewContextProperty.mock.calls).toEqual([["range_days", "90"]]);
    view.unmount();
  });
});

function lastCohortNoticeModel(): BranchCohortNoticeModel {
  const props = cohortNoticeMock.mock.lastCall?.[0] as
    | { model: BranchCohortNoticeModel }
    | undefined;
  if (!props) {
    throw new Error("Branch cohort notice did not render");
  }
  return props.model;
}

/**
 * A bounded server page whose cohort is keyed on the request the producer was
 * handed — the same `branchListCohortKey(request)` the cloud list stamps.
 * `total` deliberately exceeds the row count, so `completeCorpus` is false and
 * the producer comparison actually runs.
 */
function makeBoundedCohortPage(
  filters: BranchQueryFilters
): BranchListResponse {
  return {
    ...makeServerPageListResponse(BOUNDED_COHORT_BRANCH_NAME),
    total: BOUNDED_COHORT_TOTAL,
    hasMore: true,
    lastActiveCohort: completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: branchListCohortKey(filters),
      evaluationNow: new Date(SERVER_PAGE_NOW),
      total: BOUNDED_COHORT_TOTAL,
      retainedUnavailable: BOUNDED_COHORT_RETAINED,
    }),
  };
}

function makeServerPageListResponse(branchName: string): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    ...makeListResponse([
      makeBranchRow({ branchName, lastActivityAt: SERVER_PAGE_ROW_ACTIVITY }),
    ]),
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: SERVER_PAGE_NOW,
    },
    // Required by the server-page boundary schema: without facets the envelope
    // is not a valid server page, `serverPageActive` stays false, and the page
    // silently drops onto the legacy path.
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
 * ISS-8127: the cohort producer request must never describe a window the user
 * did not select.
 *
 * The persisted view restores in a POST-MOUNT effect (FEA-4125), so the first
 * commit of every mount still holds the 7d default. `enabled: isViewReady`
 * stops that commit from FETCHING, but a query is disabled, not blind: TanStack
 * returns whatever is already cached under the key, and on a back-navigation
 * the default window's key is populated — the first mount fetched under it
 * before the user picked a range. So the full corpus and the stale default
 * window co-occur for one commit, `resolveBranchDisplayRows` narrows the corpus
 * to whatever falls in the trailing 7 days, and the page POSTs that as the
 * exact pre-pagination cohort. The cards then read canonical spend for a
 * fraction of the branches the user is looking at.
 *
 * The assertion walks every request the page hands the cohort hook rather than
 * the last one: the narrowed request is transient and a final-state read cannot
 * see it — which is exactly why this shipped.
 */
describe("BranchesPage cohort window integrity (ISS-8127)", () => {
  const RECENT_ROW_COUNT = 3;
  const STALE_ROW_COUNT = 9;

  function cohortRequestsIssued(): BranchAnalyticsCohortRequest[] {
    return (
      useBranchCohortAnalyticsMock.mock.calls as [
        BranchAnalyticsCohortRequest | null,
        { enabled?: boolean } | undefined,
        unknown,
      ][]
    )
      .filter(([request, options]) => request !== null && options?.enabled)
      .map(([request]) => request as BranchAnalyticsCohortRequest);
  }

  function windowSpanningCorpus(): BranchRow[] {
    const dayMs = 86_400_000;
    return [
      ...Array.from({ length: RECENT_ROW_COUNT }, (_, index) =>
        makeBranchRow({
          branchName: `feature/recent-${index}`,
          id: `branch-recent-${index}`,
          lastActivityAt: new Date(
            FIRST_READ.getTime() - (index + 1) * dayMs
          ).toISOString(),
          sessionIds: [`session-recent-${index}`],
        })
      ),
      ...Array.from({ length: STALE_ROW_COUNT }, (_, index) =>
        makeBranchRow({
          branchName: `feature/stale-${index}`,
          id: `branch-stale-${index}`,
          lastActivityAt: new Date(
            FIRST_READ.getTime() - (index + 40) * dayMs
          ).toISOString(),
          sessionIds: [`session-stale-${index}`],
        })
      ),
    ];
  }

  it("never posts a cohort narrowed by the default window before the saved All-time view restores", () => {
    const corpus = windowSpanningCorpus();
    localStorage.setItem(
      `${BRANCHES_SAVED_VIEW_KEY_PREFIX}${BRANCHES_WEB_APPROVED_VIEW_KEY}:u:${SAVED_VIEW_USER_ID}`,
      JSON.stringify({
        sortKey: BranchSortKey.LastActivity,
        sortDir: BranchSortDir.Desc,
        dateRange: "all",
        hiddenColumns: [],
        columnOrder: [],
        columnWidths: {},
      })
    );
    // A status facet is what makes the page build an exact-cohort request at
    // all (`hasApprovedBranchFilters`), and it is what the e2e's own URL
    // carries. Without it the surface stays on the unfiltered path and this
    // suite would pass while proving nothing.
    searchParamsMock.mockReturnValue(new URLSearchParams("status=open"));
    // The mocked read returns the corpus regardless of `enabled`, which is
    // precisely the production cache-hit this reproduces.
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse(corpus) })
    );
    const resolved = createStaticAuthAdapter({ userId: SAVED_VIEW_USER_ID });

    const view = renderAt(FIRST_READ, (node) => (
      <AuthAdapterProvider adapter={resolved}>{node}</AuthAdapterProvider>
    ));

    const requests = cohortRequestsIssued();
    expect(requests.length).toBeGreaterThan(0);
    const allIds = corpus.map((row) => row.id).sort();
    for (const request of requests) {
      expect([...request.branchIds].sort()).toEqual(allIds);
      // "All time" carries no bounds; a request that has them was built from a
      // window the restore was about to discard.
      expect(request.startDate).toBeUndefined();
      expect(request.endDate).toBeUndefined();
    }
    view.unmount();
  });
});

// The rendered form of SERVER_PAGE_ROW_ACTIVITY. Present only when the row is
// classified as past activity, which is exactly the mutated reading.
