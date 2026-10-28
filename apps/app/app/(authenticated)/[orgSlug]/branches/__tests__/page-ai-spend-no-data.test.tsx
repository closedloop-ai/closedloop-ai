import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { BRANCH_METRIC_UNAVAILABLE_DETAIL } from "@repo/app/branches/components/approved-branch-metric-card";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { A11yTheme } from "@repo/app/test/a11y/contrast";
import { waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  cardText,
  makeAnalytics,
  makeBranchRow,
  makeCanonicalMetrics,
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
const { cohortRefetchMock } = vi.hoisted(() => ({
  cohortRefetchMock: vi.fn(),
}));

const { invalidateQueriesMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
}));
const { featureFlagEnabledMock } = vi.hoisted(() => ({
  featureFlagEnabledMock: vi.fn<(flag: string) => boolean>(() => false),
}));
const _REFRESH_BUTTON_NAME_PATTERN = /refresh/i;
const _ALICE_OWNER_PATTERN = /alice/i;
const _HIDDEN_TEXT_PATTERN = /hidden/;
const _SUMMARY_METRICS_ERROR_PATTERN = /couldn't load the summary metrics/i;
const _COHORT_CLAIM_PATTERN =
  /Updating Branches for|Couldn't update Branches for/i;
const _RETRY_BUTTON_NAME_PATTERN = /retry/i;
const _FIXED_SUMMARY_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;
const _PINNED_SUMMARY_CARD_SIZE_PATTERN = /(?:min-w|basis)-\[1[12]rem\]/;
const _SUMMARY_DERIVED_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";
// FEA-4004 retired this flag; the string is kept only so this regression can
// force the pre-PR default-hide branch on. If the removal ever regressed, the
// old code would still gate on this key and hide the merged/agent rows below,
// failing the assertions — the flag being off (as it defaults) would let the
// pre-PR show-all path pass trivially and hide the regression (whitlockk review).
const _RETIRED_BRANCHES_HIDE_CRUFT_FLAG = "branches-hide-cruft";
const _A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

// The page defaults to the "7d" time window, whose start is computed from the
// real clock (`getStartDateForRange("7d")` → now − 7 days) and filters rows by
// `lastActivityAt`. Freeze the clock a few days after the fixture's activity
// timestamp (see `makeBranchRow`) so the row deterministically stays inside the
// default window; otherwise the test starts failing once wall-clock time drifts
// more than 7 days past the fixture.
const _FROZEN_NOW = new Date("2026-07-05T12:00:00.000Z");

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

// FEA-3560: the page mirrors facet changes into the URL via navigation.replace.
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

// Stable identity, matching production: the real `useApiClient` returns a
// `useMemo`d client, and this page's backfill effect lists `apiClient` in its
// deps. A fresh object per render would re-run that effect on every render and
// make the invalidation call counts below nondeterministic.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  // ISS-7408: `usePostConnectBackfill` reads `backfill()` on every render, so a
  // stub without it throws before any assertion in this file runs.
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  // ISS-5958: the page reads the GitHub status to decide whether its gated CTA
  // says connect or reconnect. This suite is about the list, so the status stays
  // unresolved — which the resolver reports as "unknown".
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  // Stable identity, matching production: the real `useQueryClient` returns the
  // one client held in context, and this page's backfill effect lists
  // `queryClient` in its deps. See the `useApiClient` mock above.
  const queryClient = {
    invalidateQueries: invalidateQueriesMock,
  };
  return {
    ...actual,
    useQueryClient: () => queryClient,
    // ISS-7408: the hook's suite covers polling; page tests isolate its read.
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

// This page test renders without a FeatureFlagAdapterProvider, so stub the flag
// hook. Default-off for any flag-gated child; a hoisted `vi.fn()` so a test can
// opt a specific flag on.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Ready by default, so suites written before the gate
  // keep their synchronous behaviour.
  useFeatureFlagGateOptional: (flag: string) => ({
    enabled: featureFlagEnabledMock(flag),
    isReady: true,
  }),
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagGate: (flag: string) => ({
    enabled: featureFlagEnabledMock(flag),
    isReady: true,
  }),
  // ISS-4887: `SummaryCardRow` — which the Branches KPI strip renders — reads
  // its gate OPTIONALLY, so this module mock must expose both hooks or the
  // subtree throws on the missing export. Routed to the same mock so a test can
  // flip either gate through one control.
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

beforeEach(() => {
  cohortRefetchMock.mockReset();
  useBranchCohortAnalyticsMock.mockReset();
  useBranchCohortAnalyticsMock.mockReturnValue({
    data: null,
    isError: false,
    isPending: false,
    refetch: cohortRefetchMock,
  });
});

/**
 * ISS-9957/ISS-9958 — the CANONICAL row, reached through the real page.
 *
 * `packages/app/branches/components/__tests__/approved-branches-summary-cards-canonical-row.test.tsx`
 * mounts the component directly. These cases drive the same row through the web
 * host, so a page-level wiring failure — the gate never read on this surface, or
 * the two new fields dropped on the way through the cohort fold — fails here
 * rather than shipping green (davetho review).
 */
describe("BranchesPage canonical cost row (ISS-9957)", () => {
  const CANONICAL_ROW = [
    "Active branches",
    "Median PR size",
    "Total LOC pushed",
    "Merge rate",
    "LOC per $",
  ];
  const COMPLETE_RATIO: BranchMetricResult<number> = {
    state: BranchMetricAvailability.Complete,
    value: 4,
  };
  const UNAVAILABLE_RATIO: BranchMetricResult<number> = {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  };
  const PUSHED_LINES: BranchMetricResult<number> = {
    state: BranchMetricAvailability.Complete,
    value: 1000,
  };

  function analyticsWithPushedLoc(ratio: BranchMetricResult<number>) {
    return {
      ...makeAnalytics(),
      canonicalMetrics: {
        ...makeCanonicalMetrics(),
        totalLocPushed: { current: PUSHED_LINES },
        pushedLocPerDollar: { current: ratio },
      },
    };
  }

  function renderedCardLabels(): (string | null)[] {
    return Array.from(
      document.querySelectorAll("[data-slot='metric-card-label-text']")
    ).map((node) => node.textContent);
  }

  beforeEach(() => {
    vi.useRealTimers();
    headerMock.mockImplementation(renderHeaderMock);
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
    // ISS-10636 AC-5: NO flag on, which is what a real reader resolves.
    featureFlagEnabledMock.mockReturnValue(false);
  });

  afterEach(() => vi.clearAllMocks());

  it("renders the canonical row and no AI spend card anywhere in the tree", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([makeBranchRow()], { "session-1": 250 }),
        analytics: analyticsWithPushedLoc(COMPLETE_RATIO),
      })
    );

    render(<BranchesPage />);

    await waitFor(() => expect(renderedCardLabels()).toEqual(CANONICAL_ROW));
    // The producer's two new fields reach the cards, rather than arriving as an
    // absent state because the page never carried them.
    expect(cardText("Total LOC pushed")).toContain("1,000");
    expect(cardText("LOC per $")).toContain("4");
    // Split across elements or not, the retired card is gone from the page.
    expect(document.body.textContent).not.toContain(
      BRANCH_METRIC_DICTIONARY[BranchMetricId.AiSpend].label
    );
  });

  it("keeps the ratio card on screen when its value is absent under the hide gate", async () => {
    featureFlagEnabledMock.mockImplementation(
      (flag: string) => flag === METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([makeBranchRow()], { "session-1": 250 }),
        analytics: analyticsWithPushedLoc(UNAVAILABLE_RATIO),
      })
    );

    render(<BranchesPage />);

    // ISS-9958: the one card this row may never retire. Its four siblings
    // resolved, so the gate had a card to take and left this one alone.
    await waitFor(() => expect(renderedCardLabels()).toEqual(CANONICAL_ROW));
    expect(cardText("LOC per $")).toContain("No data");
  });
});

/**
 * ISS-9967 — the HOST picks the recomputing cohort binder.
 *
 * `packages/app/branches/lib/__tests__/filtered-cohort-recompute.test.ts` proves
 * the binder itself. What it cannot prove is that either shell actually reaches
 * for it: both hosts choose between four binders at their own flag read, and a
 * host that kept the fail-closed one would leave that unit green while the
 * screen still blanked. These cases drive the real page, so the choice is
 * asserted where the reader sees it.
 *
 * The facet arrives from the URL rather than the filter menu — the same path a
 * shared link restores one through — so the case exercises the host's real
 * filter derivation without driving a menu it is not testing.
 */
describe("BranchesPage recomputes its cards over a filtered cohort (ISS-9967)", () => {
  const ADA_MERGED = makeBranchRow({
    additions: 60,
    branchName: "feature/ada-merged",
    deletions: 40,
    id: "ada-merged",
    owner: "Ada",
    sessionIds: ["session-ada"],
    status: BranchStatus.Merged,
  });
  // Dropped by the facet, so the filtered rows are a strict subset of the
  // loaded ones and the fallback path is the one under test.
  const BOB_OPEN = makeBranchRow({
    branchName: "feature/bob-open",
    id: "bob-open",
    owner: "Bob",
    sessionIds: ["session-bob"],
  });

  beforeEach(() => {
    vi.useRealTimers();
    headerMock.mockImplementation(renderHeaderMock);
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams("owner=Ada"));
    // ISS-10636 AC-5: NO flag on, which is what a real reader resolves.
    featureFlagEnabledMock.mockReturnValue(false);
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([ADA_MERGED, BOB_OPEN], {
          "session-ada": 50,
          "session-bob": 500,
        }),
        // The producer's whole-list median is 1, so a card reading "1 LOC"
        // means the fallback never ran and a blank means it ran fail-closed.
        // Only the recompute yields the filtered row's own 100.
        analytics: {
          ...makeAnalytics(),
          canonicalMetrics: makeCanonicalMetrics(),
        },
      })
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("re-derives Median PR size over the rows the facet left", async () => {
    render(<BranchesPage />);

    await waitFor(() =>
      expect(cardText("Median PR size")).toContain("100 LOC")
    );
    expect(cardText("Median PR size")).not.toContain(
      BRANCH_METRIC_UNAVAILABLE_DETAIL
    );
    expect(cardText("Median PR size")).not.toContain("No data");
  });

  it("captions no card with the retired filter sentence", async () => {
    render(<BranchesPage />);

    await waitFor(() =>
      expect(cardText("Median PR size")).toContain("100 LOC")
    );
    expect(document.body.textContent).not.toContain(
      "Not available with filters applied"
    );
  });
});

/**
 * ISS-9967 — the web half of the filtered pair, over a cohort with a decided PR
 * population.
 *
 * The describe above proves the web host reaches the recomputing binder, but it
 * asserts ONE of the two recomputed cards over a single admitted row. Merge rate
 * is the card that needs a population to be a rate at all — one row makes it
 * N/A — so it needs its own fixture rather than a widened assertion on that one
 * (davetho review). The desktop twin is
 * `apps/desktop/src/renderer/components/branches/__tests__/branches-view-filtered-cohort-recompute.test.tsx`;
 * both shells mount the same cards, so each owes its own case.
 *
 * ISS-10636 removed the closed-gate counterfactual that used to sit beside the
 * surviving case. It seeded the SAME empty flag set, so once the gate was
 * retired the two cases were one input with opposite expectations — and the
 * shape it described, the fail-closed shipped binder blanking both cards, has
 * no host left to reach it. What it was really protecting is inside the case
 * below, which asserts the recomputed figures reached the cards AND that
 * `SUPPRESSED_BY_FILTER_DETAIL` did not: a page that fell back to the shipped
 * binder fails it on both halves. The caption's own render path keeps its
 * coverage in
 * `packages/app/branches/components/__tests__/branches-summary-cards-hide-unavailable.test.tsx`.
 */
describe("BranchesPage recomputes both cards over a decided cohort (ISS-9967)", () => {
  /**
   * Three merged single-PR branches sized 100/200/300 and one closed, all Ada's.
   * An ODD merged population, so the median does not depend on which convention
   * `median` takes for an even one.
   */
  const ADMITTED_MEDIAN_PR_SIZE = "200 LOC";
  const ADMITTED_MERGE_RATE = "75%";
  /**
   * The same two cards if the facet were ignored and Bob's rows bound too. Their
   * job is to DIFFER from the admitted figures — that difference is what lets
   * this fixture fail when the cohort is wrong.
   */
  const UNFILTERED_MEDIAN_PR_SIZE = "300 LOC";
  const UNFILTERED_MERGE_RATE = "83.3%";
  /** `makeCanonicalMetrics` publishes 1 for every metric; a card reading these
   * means the producer's whole-list bundle passed through unrecomputed. */
  const PRODUCER_MEDIAN_PR_SIZE = "1 LOC";
  const PRODUCER_MERGE_RATE = "1%";
  const SUPPRESSED_BY_FILTER_DETAIL = "Not available with filters applied";

  function mergedRow(id: string, owner: string, size: number) {
    return makeBranchRow({
      additions: size / 2,
      branchName: `feature/${id}`,
      deletions: size / 2,
      id,
      owner,
      prState: GitHubPRState.Merged,
      sessionIds: [`session-${id}`],
      status: BranchStatus.Merged,
    });
  }

  const ROWS = [
    mergedRow("ada-small", "Ada", 100),
    mergedRow("ada-medium", "Ada", 200),
    mergedRow("ada-large", "Ada", 300),
    makeBranchRow({
      additions: 10,
      branchName: "feature/ada-closed",
      deletions: 10,
      id: "ada-closed",
      owner: "Ada",
      prState: GitHubPRState.Closed,
      sessionIds: ["session-ada-closed"],
      status: BranchStatus.Closed,
    }),
    // Dropped by the facet, and sized so leaving them in moves both figures.
    mergedRow("bob-huge", "Bob", 2000),
    mergedRow("bob-larger", "Bob", 3000),
  ];

  function renderFiltered(enabledFlags: readonly string[]) {
    featureFlagEnabledMock.mockImplementation((flag: string) =>
      enabledFlags.includes(flag)
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse(
          ROWS,
          Object.fromEntries(ROWS.map((row) => [`session-${row.id}`, 25]))
        ),
        analytics: {
          ...makeAnalytics(),
          canonicalMetrics: makeCanonicalMetrics(),
        },
      })
    );
    render(<BranchesPage />);
  }

  beforeEach(() => {
    vi.useRealTimers();
    headerMock.mockImplementation(renderHeaderMock);
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams("owner=Ada"));
  });

  afterEach(() => vi.clearAllMocks());

  it("re-derives Median PR size and Merge rate over the rows the facet left", async () => {
    renderFiltered([]);

    await waitFor(() =>
      expect(cardText("Median PR size")).toContain(ADMITTED_MEDIAN_PR_SIZE)
    );
    expect(cardText("Merge rate")).toContain(ADMITTED_MERGE_RATE);

    // The two other populations this could have bound, each pinned so a failure
    // names which one it took.
    expect(cardText("Median PR size")).not.toContain(UNFILTERED_MEDIAN_PR_SIZE);
    expect(cardText("Median PR size")).not.toContain(PRODUCER_MEDIAN_PR_SIZE);
    expect(cardText("Merge rate")).not.toContain(UNFILTERED_MERGE_RATE);
    expect(cardText("Merge rate")).not.toContain(PRODUCER_MERGE_RATE);
    expect(document.body.textContent).not.toContain(
      SUPPRESSED_BY_FILTER_DETAIL
    );
  });
});
