import { BranchStatus } from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { LIST_TOOLBAR_FILTER_LABEL } from "@repo/app/shared/components/list-toolbar-copy";
import { SUMMARY_CARD_STRETCH_CLASS } from "@repo/app/shared/components/summary-card-row";
import {
  ArtifactFlag,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  cardText,
  makeAnalytics,
  makeBranchRow,
  makeCanonicalMetrics,
  makeCohortRows,
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
const REFRESH_BUTTON_NAME_PATTERN = /refresh/i;
const ALICE_OWNER_PATTERN = /alice/i;
const HIDDEN_TEXT_PATTERN = /hidden/;
const SUMMARY_METRICS_ERROR_PATTERN = /couldn't load the summary metrics/i;
const COHORT_CLAIM_PATTERN =
  /Updating Branches for|Couldn't update Branches for/i;
const RETRY_BUTTON_NAME_PATTERN = /retry/i;
const FIXED_SUMMARY_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;
const PINNED_SUMMARY_CARD_SIZE_PATTERN = /(?:min-w|basis)-\[1[12]rem\]/;
/**
 * `SummaryCardRow`'s `wrapBelow` grid, which this page must NOT render: its band
 * is a non-shrinking flex item beside the table's scroll region, so a wrapped
 * second rank comes straight out of the rows (#7544).
 */
const SUMMARY_WRAPPING_GRID_PATTERN = /(?:^|\s)grid(?:$|\s)/;
// FEA-4004 retired this flag; the string is kept only so this regression can
// force the pre-PR default-hide branch on. If the removal ever regressed, the
// old code would still gate on this key and hide the merged/agent rows below,
// failing the assertions — the flag being off (as it defaults) would let the
// pre-PR show-all path pass trivially and hide the regression (whitlockk review).
const RETIRED_BRANCHES_HIDE_CRUFT_FLAG = "branches-hide-cruft";
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

// The page defaults to the "7d" time window, whose start is computed from the
// real clock (`getStartDateForRange("7d")` → now − 7 days) and filters rows by
// `lastActivityAt`. Freeze the clock a few days after the fixture's activity
// timestamp (see `makeBranchRow`) so the row deterministically stays inside the
// default window; otherwise the test starts failing once wall-clock time drifts
// more than 7 days past the fixture.
const FROZEN_NOW = new Date("2026-07-05T12:00:00.000Z");

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

describe("BranchesPage", () => {
  beforeEach(() => {
    // Fake only `Date` so the window filter is deterministic while the async
    // timers used by `waitFor`/`act` keep running on the real clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    headerMock.mockReset();
    apiPostMock.mockReset();
    searchParamsMock.mockReset();
    useBranchesPageDataMock.mockReset();
    featureFlagEnabledMock.mockReset();
    featureFlagEnabledMock.mockReturnValue(false);
    headerMock.mockImplementation(renderHeaderMock);
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([makeBranchRow()]) })
    );
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not announce a cohort notice during initial loading or failure", () => {
    featureFlagEnabledMock.mockImplementation(
      (flag: string) => flag === BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ isPending: true })
    );
    const pending = render(<BranchesPage />);
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).not.toBeInTheDocument();
    pending.unmount();

    useBranchesPageDataMock.mockReturnValue(pageDataResult({ isError: true }));
    render(<BranchesPage />);
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).not.toBeInTheDocument();
  });

  // ISS-5574: every Sessions/Branches page reported the app-wide "Closedloop.ai",
  // so several open tabs were indistinguishable. Asserts the REAL document.title
  // for this route, and that the flag-off default is untouched.
  it("names the browser tab after this surface, behind the flag", () => {
    const previousTitle = document.title;
    document.title = "Closedloop.ai";
    try {
      const flaggedOff = render(<BranchesPage />);
      expect(document.title).toBe("Closedloop.ai");
      flaggedOff.unmount();

      featureFlagEnabledMock.mockImplementation(
        (flag: string) => flag === SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
      );
      render(<BranchesPage />);
      expect(document.title).toBe("Branches | Closedloop.ai");
    } finally {
      document.title = previousTitle;
    }
  });

  it("renders HTTP-backed rows through the shared adapter and links to detail", () => {
    render(<BranchesPage />);

    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(
      screen.getByText("feature/web-branches").closest("a")
    ).toHaveAttribute("href", "/acme/branches/branch-1");
    // ISS-7362 split the PR chip's label so a tail ellipsis can no longer reach
    // the number, so the short repo name now renders in two places: the
    // Repository cell and the chip's own truncating prefix. The chip still reads
    // as one `repo#number` token.
    expect(screen.getAllByText("app")).toHaveLength(2);
    expect(
      screen.getByText("#123").closest('[data-slot="chip"]')
    ).toHaveTextContent("app#123");
    expect(screen.getByText("Active branches")).toBeInTheDocument();
    expect(useBranchesPageDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: expect.any(String) }),
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 90_000,
      }),
      { cacheScope: "org:acme" }
    );
  });

  it("binds filtered cards to the landed exact-cohort producer", async () => {
    const producerMetrics = {
      ...makeCanonicalMetrics(),
      medianPrSize: {
        current: {
          state: BranchMetricAvailability.Complete,
          value: 321,
        },
      },
    };
    searchParamsMock.mockReturnValue(new URLSearchParams("owner=github%3Aada"));
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({
            ownerIdentity: {
              availability: BranchIdentityAvailability.Complete,
              person: {
                provider: BranchPersonProvider.GitHub,
                id: "ada",
                displayName: "Ada",
              },
            },
          }),
          makeBranchRow({ id: "branch-2", owner: "Bob" }),
        ]),
      })
    );
    useBranchCohortAnalyticsMock.mockReturnValue({
      data: {
        matchedBranchIds: ["branch-1"],
        canonicalMetrics: producerMetrics,
      },
      isError: false,
      isPending: false,
      refetch: cohortRefetchMock,
    });

    render(<BranchesPage />);

    const request = useBranchCohortAnalyticsMock.mock.calls
      .map(([candidate]) => candidate)
      .find((candidate) => candidate !== null) as {
      branchIds: string[];
      startDate: string;
      endDate: string;
    };
    expect(request.branchIds).toEqual(["branch-1"]);
    // ISS-5809: the window now ends with the CURRENT UTC day, so a branch active
    // today reaches the list and the cohort request that mirrors it.
    expect(request.endDate).toBe("2026-07-05T23:59:59.999Z");
    expect(Date.parse(request.startDate)).toBeLessThan(
      Date.parse(request.endDate)
    );
    await waitFor(() => expect(cardText("Median PR size")).toContain("321"));
  });

  // FEA-4155 regression: the P0 blank-render bug was the page gating its entire
  // body behind the `branches-nav` feature flag (a 404 unless it resolved
  // enabled===true). Flags are being wound down, so once that flag resolved to a
  // real false the whole surface blanked. The surface is now always-on: with
  // EVERY flag resolving OFF (the winding-down state — `featureFlagEnabledMock`
  // defaults to `false` in beforeEach) the real branch rows and summary must
  // still render, not a 404 / empty body.
  it("renders its content with the branches feature flag OFF (FEA-4155)", () => {
    featureFlagEnabledMock.mockReturnValue(false);
    render(<BranchesPage />);

    expect(
      screen.getByText("feature/web-branches").closest("a")
    ).toHaveAttribute("href", "/acme/branches/branch-1");
    expect(screen.getByText("Active branches")).toBeInTheDocument();
    expect(featureFlagEnabledMock).not.toHaveBeenCalledWith(
      ArtifactFlag.Branches
    );
  });

  it("renders the approved List directly when every UI flag is off", () => {
    featureFlagEnabledMock.mockReturnValue(false);
    render(<BranchesPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Branches" })
    ).toHaveClass("sr-only");
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME_PATTERN })
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim())
    ).toEqual([
      "Name",
      "Owner",
      // ISS-10332: shown by default (operator ruling 5, 2026-09-21).
      "Priority",
      "Collaborators",
      "Linked sessions",
      "Changes",
      "Status",
      "Pull request",
      "Last active",
      "Repository",
      "Tags",
      "Project",
    ]);
  });

  // FEA-4177 — independent failure domains: an analytics-only failure degrades
  // the summary cards to "Unavailable" but the branches table still renders.
  it("keeps visible rows while summary retry reruns only analytics + cohort reads", () => {
    const refetchAnalyticsMock = vi.fn().mockResolvedValue(undefined);
    useBranchesPageDataMock.mockReturnValue({
      ...pageDataResult({
        list: makeListResponse([makeBranchRow()]),
        analyticsError: true,
      }),
      refetch: vi.fn(),
      refetchAnalytics: refetchAnalyticsMock,
      analyticsPending: false,
      analyticsError: true,
      analyticsQuery: {
        data: undefined,
        isPending: false,
        isError: true,
      },
      isSuccess: true,
    });

    render(<BranchesPage />);

    // The list rows still render (the required half succeeded)...
    expect(screen.getByText("feature/web-branches")).toBeInTheDocument();
    // ...while the summary KPI cards degrade to their own "Unavailable" state.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    // ...and the failure gets an honest reason + a Retry, not a silent dimmed
    // row (whitlockk review): the analytics-only half-failure must offer a way back.
    expect(screen.getByText(SUMMARY_METRICS_ERROR_PATTERN)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    );
    expect(refetchAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(cohortRefetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith(
      { queryKey: ["branches", "cohort-analytics"] },
      { throwOnError: true }
    );
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith(
      { queryKey: ["branches", "page-data"] },
      { throwOnError: true }
    );
    expect(screen.getByText("feature/web-branches")).toBeInTheDocument();
  });

  // FEA-3560 regression: navigating into a branch detail unmounts the list;
  // coming back restores the list URL but not component state. The page must
  // re-seed its facet filters from the URL on mount so the restored view shows
  // the filtered rows, not the whole corpus.
  it("seeds facet filters from the list URL on mount (detail→back restore)", () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams("owner=github%3Agrace")
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ id: "ada", branchName: "feature/by-ada" }),
          makeBranchRow({
            id: "grace",
            branchName: "feature/by-grace",
            owner: "Grace",
            ownerIdentity: {
              availability: BranchIdentityAvailability.Complete,
              person: {
                provider: BranchPersonProvider.GitHub,
                id: "grace",
                displayName: "Grace",
              },
            },
            prNumber: 124,
            prUrl: "https://github.com/acme/app/pull/124",
          }),
        ]),
      })
    );

    render(<BranchesPage />);

    expect(screen.getByText("feature/by-grace")).toBeInTheDocument();
    expect(screen.queryByText("feature/by-ada")).not.toBeInTheDocument();
  });

  it("FEA-4004: always shows merged + session-less agent branches with no hidden reveal", () => {
    // Enable the retired branches-hide-cruft flag too: against the pre-PR
    // implementation that flag drove the default-hide, so with it on the merged
    // + session-less agent rows would be hidden and the assertions below would
    // fail. Post-PR the flag is ignored, so every branch renders (whitlockk review).
    featureFlagEnabledMock.mockImplementation(
      (flag: string) =>
        flag === ArtifactFlag.Branches ||
        flag === RETIRED_BRANCHES_HIDE_CRUFT_FLAG
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([
          makeBranchRow({ id: "human", branchName: "feature/human-work" }),
          makeBranchRow({
            id: "merged",
            branchName: "feature/landed",
            status: BranchStatus.Merged,
          }),
          makeBranchRow({
            id: "agent",
            branchName: "worktree-agent-abc123",
            sessionIds: [],
          }),
        ]),
      })
    );

    render(<BranchesPage />);

    // FEA-4004 removed the "Hide Merged & Agent Branches" default-hide, so every
    // branch — merged, agent-worktree with no linked session — renders by
    // default and there is no "N hidden · Show" reveal.
    expect(screen.getByText("feature/human-work")).toBeInTheDocument();
    expect(screen.getByText("feature/landed")).toBeInTheDocument();
    expect(screen.getByText("worktree-agent-abc123")).toBeInTheDocument();
    expect(screen.queryByText(HIDDEN_TEXT_PATTERN)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show" })
    ).not.toBeInTheDocument();
  });

  /**
   * ISS-10301 re-pointed this at the surface arm of the same band; ISS-11472
   * then collapsed the two arms into the one band this asserts against.
   *
   * The assertions this case was written against — `grid grid-cols-2` plus the
   * `md:` auto-fit tracks — were `SummaryCardRow`'s `wrapBelow` grid, which this
   * page reached only through the deleted v1 host, whose `layout="stacked"` arm
   * ISS-11472 removed along with the prop. The one band left spreads
   * `SUMMARY_CARD_SURFACE_BAND_PROPS`, and #7544 is explicit that it must
   * stay ONE non-wrapping rank: `GridTableListSurface` seats it as a
   * non-shrinking flex item beside the table's scroll region, so a rank the strip
   * gains is a rank the table loses.
   *
   * Everything the name promises is still asserted, against the operands that are
   * live here: the shared per-card minimum this row publishes, the absence of a
   * fixed column tier, the five-card canonical row, and cards that ABSORB the
   * band's spare width rather than pinning to the floor. The `wrapBelow` grid
   * itself is still pinned where it is still reachable, by
   * `packages/app/shared/components/__tests__/summary-card-row.test.tsx`.
   */
  it("derives the summary grid from the shared per-card minimum", () => {
    const { container } = render(<BranchesPage />);
    const grid = [...container.querySelectorAll<HTMLElement>("div")].find(
      (node) => node.style.getPropertyValue("--summary-card-min") !== ""
    );

    expect(grid).not.toBeUndefined();
    // One rank, sized from the published floor — never the wrapping grid.
    expect(grid).toHaveClass("flex", "gap-4");
    expect(grid?.className).not.toMatch(SUMMARY_WRAPPING_GRID_PATTERN);
    expect(grid?.style.getPropertyValue("--summary-card-min")).toBe("192px");
    expect(grid?.className).not.toMatch(FIXED_SUMMARY_COLUMN_TIER_PATTERN);
    const cards = [...(grid?.querySelectorAll('[data-slot="card"]') ?? [])];
    // ISS-9970 retired the AI spend card; ISS-10636 then made ISS-9957's
    // canonical row unconditional, which puts Total LOC pushed in that slot and
    // moves LOC per $ last. Five, not four — the gate that used to select the
    // four-card row is gone, so there is no reader who sees four.
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card).toHaveClass(...SUMMARY_CARD_STRETCH_CLASS.split(" "));
      expect(card.className).not.toMatch(PINNED_SUMMARY_CARD_SIZE_PATTERN);
    }
  });

  it("bounds pagination inside a horizontal overflow owner", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse(
          Array.from({ length: 30 }, (_value, index) =>
            makeBranchRow({
              id: `branch-${index}`,
              branchName: `feature/web-branches-${index}`,
            })
          )
        ),
      })
    );

    render(<BranchesPage />);

    const pagination = screen.getByRole("navigation", { name: "pagination" });
    const scrollOwner = screen.getByRole("region", { name: "Branches" });
    expect(scrollOwner).toHaveAttribute("tabindex", "0");
    expect(scrollOwner).toHaveClass("overflow-auto");
    expect(pagination).toHaveClass("min-w-max");
    expect(pagination.parentElement).toHaveClass("overflow-x-auto");
  });

  it("keeps loading, error, empty, and filtered-empty states distinct", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ isFetching: true, isPending: true })
    );
    const { rerender } = render(<BranchesPage />);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();

    useBranchesPageDataMock.mockReturnValue(pageDataResult({ isError: true }));
    rerender(<BranchesPage />);
    // The error-without-rows case is an honest error surface with a Retry action,
    // never a bare "no branches" empty (review #3663).
    expect(screen.getByText("Couldn't load branches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    // An empty read UNDER the default 30-day window is a windowed-away
    // filtered-empty (offering "Show all time"), NOT the onboarding "no branches
    // at all" copy — the server already applied startDate (whitlockk review #3663).
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([]) })
    );
    rerender(<BranchesPage />);
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeInTheDocument();
  });

  it("shows the genuine 'No branches yet' onboarding copy only once the window is widened to all-time", () => {
    // Empty list, default 30-day window → filtered-empty with a "Show all time"
    // action. Widening to all-time removes the window, so the same empty read
    // now honestly reads as onboarding (whitlockk review #3663).
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([]) })
    );
    render(<BranchesPage />);

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    );

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching branches")).not.toBeInTheDocument();
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps branches route critical a11y and contrast clean in %s theme",
    async (theme) => {
      const { container } = render(
        <A11yThemeRoot theme={theme}>
          <BranchesPage />
        </A11yThemeRoot>
      );

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText("Active branches"), {
        background: themeBackground(theme),
        label: `branches populated row ${theme}`,
      });
    }
  );

  it.each([
    [
      "loading",
      () =>
        useBranchesPageDataMock.mockReturnValue(
          pageDataResult({ isFetching: true, isPending: true })
        ),
      "Loading branches…",
    ],
    [
      "error",
      () =>
        useBranchesPageDataMock.mockReturnValue(
          pageDataResult({ isError: true })
        ),
      "Couldn't load branches",
    ],
    [
      // Empty read under the default 30d window → windowed-away filtered-empty.
      "empty",
      () =>
        useBranchesPageDataMock.mockReturnValue(
          pageDataResult({ list: makeListResponse([]) })
        ),
      "No matching branches",
    ],
    [
      "filtered-empty",
      () =>
        useBranchesPageDataMock.mockReturnValue(
          pageDataResult({
            list: makeListResponse([
              makeBranchRow({ lastActivityAt: "2026-01-01T00:00:00.000Z" }),
            ]),
          })
        ),
      "No matching branches",
    ],
    ["populated", () => undefined, "Active branches"],
  ])(
    "keeps branches %s state a11y and contrast clean",
    async (_state, setup, expectedText) => {
      for (const theme of A11Y_THEMES) {
        setup();

        const { container, unmount } = render(
          <A11yThemeRoot theme={theme}>
            <BranchesPage />
          </A11yThemeRoot>
        );

        const target = screen.getByText(expectedText);
        await expectCriticalAxeClean(container);
        expectElementContrast(target, {
          background: themeBackground(theme),
          label: `branches ${expectedText} ${theme}`,
        });
        unmount();
      }
    }
  );
});

// FEA-3629 v2 — the #3281 gap. #3281 wired the top-bar summary cards to
// `deriveFilteredBranchAnalytics(analytics, data.items, filters)` — the RAW
// server corpus — so applying a facet re-derived the KPIs over rows the table
// was HIDING (windowed-out), not the VISIBLE set. The cards then disagreed with
// the filtered table (the user-visible "stats don't refresh correctly" bug).
// The fix re-projects over `selectVisibleWireRows`, so this test drives a REAL
// facet with a windowed-out row present in `data.items` and asserts every card
// reflects only the visible rows. It FAILS against #3281's wiring (the
// windowed-out row leaks into the re-derived cohort) and passes with the fix.
describe("BranchesPage summary cards reflect the filtered, VISIBLE table (FEA-3629 v2)", () => {
  const VISIBLE_OPEN = makeBranchRow({
    id: "visible-open",
    branchName: "feature/visible-open",
    owner: "alice",
    status: BranchStatus.Open,
    estimatedCostUsd: 40,
    sessionIds: ["s-open"],
    additions: 10,
    deletions: 5,
  });
  // Same owner, but its activity is far OUTSIDE the default 30-day window, so the
  // client-side window drops it from the visible table while it still rides in
  // `data.items`. A raw-corpus derivation would fold it into the
  // owner-filtered cohort.
  const OUT_OF_WINDOW = makeBranchRow({
    id: "out-of-window",
    branchName: "feature/out-of-window",
    owner: "alice",
    status: BranchStatus.Open,
    estimatedCostUsd: 1000,
    sessionIds: ["s-out"],
    additions: 500,
    deletions: 500,
    lastActivityAt: "2020-01-01T00:00:00.000Z",
  });
  const VISIBLE_OTHER_OWNER = makeBranchRow({
    id: "visible-other-owner",
    branchName: "feature/visible-other-owner",
    owner: "bob",
    sessionIds: ["s-other"],
  });

  beforeEach(() => {
    vi.useRealTimers();
    headerMock.mockImplementation(renderHeaderMock);
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
    featureFlagEnabledMock.mockReturnValue(true);
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse(
          [VISIBLE_OPEN, VISIBLE_OTHER_OWNER, OUT_OF_WINDOW],
          { "s-open": 40, "s-other": 20, "s-out": 1000 }
        ),
        // Full-corpus base (all-time), so a card still showing it after
        // filtering proves the cards never re-derived at all.
        analytics: makeAnalytics(),
      })
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("scopes the cohort to the visible rows only, excluding a windowed-out row", async () => {
    const user = userEvent.setup();
    mockExactCohortSpend(40);
    render(<BranchesPage />);

    // The out-of-window row is dropped from the table by the default 30d window.
    expect(screen.getByText("feature/visible-open")).toBeInTheDocument();
    expect(screen.queryByText("feature/out-of-window")).not.toBeInTheDocument();

    // Apply an owner = alice facet (both rows are alice; only the in-window one
    // is visible). #3281 would sum $40 + $1000 = $1,040 over the raw corpus.
    await user.click(
      screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );
    await user.hover(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Filter...")).toBeVisible()
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: ALICE_OWNER_PATTERN })
    );

    // ISS-9970 retired the AI spend card, so a rendered dollar figure is no
    // longer available as the probe. What #3281 actually broke is the SCOPE of
    // the cohort, and that is still live: the request must carry only the
    // visible row, never the windowed-out one it used to fold in.
    await waitFor(() =>
      expect(latestCohortRequest()?.branchIds).toEqual(["visible-open"])
    );
  });

  it("requests the exact 101-branch filtered cohort", async () => {
    const aliceRows = makeCohortRows(101, "alice");
    const bobRow = makeBranchRow({
      id: "bob-only",
      branchName: "feature/bob-only",
      owner: "bob",
      sessionIds: ["session-bob-only"],
    });
    const sessionCostUsd = Object.fromEntries(
      aliceRows.map((row) => [row.sessionIds[0] as string, 1])
    );
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([...aliceRows, bobRow], sessionCostUsd),
        analytics: makeAnalytics(),
      })
    );
    mockExactCohortSpend(321);

    const user = userEvent.setup();
    render(<BranchesPage />);
    await user.click(
      screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );
    await user.hover(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Filter...")).toBeVisible()
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: ALICE_OWNER_PATTERN })
    );

    await waitFor(() => {
      const request = latestCohortRequest();
      expect(request?.branchIds).toHaveLength(101);
    });
  }, 15_000);

  it("surfaces an exact-cohort transport failure as unavailable", async () => {
    const user = userEvent.setup();
    useBranchCohortAnalyticsMock.mockImplementation(
      (request: BranchAnalyticsCohortRequest | null) => ({
        data: null,
        isError: request !== null,
        isPending: false,
        refetch: cohortRefetchMock,
      })
    );

    render(<BranchesPage />);
    await user.click(
      screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );
    await user.hover(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Filter...")).toBeVisible()
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: ALICE_OWNER_PATTERN })
    );

    await waitFor(() =>
      expect(
        screen.getByText(SUMMARY_METRICS_ERROR_PATTERN)
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });
});

function latestCohortRequest(): BranchAnalyticsCohortRequest | null {
  const calls = useBranchCohortAnalyticsMock.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const request = calls[index]?.[0] as
      | BranchAnalyticsCohortRequest
      | null
      | undefined;
    if (request) {
      return request;
    }
  }
  return null;
}

function mockExactCohortSpend(value: number): void {
  useBranchCohortAnalyticsMock.mockImplementation(
    (request: BranchAnalyticsCohortRequest | null) => ({
      data: request
        ? {
            matchedBranchIds: request.branchIds,
            canonicalMetrics: {
              ...makeCanonicalMetrics(),
              cohortSize: request.branchIds.length,
              aiSpendUsd: {
                current: {
                  state: BranchMetricAvailability.Complete,
                  value,
                },
              },
            },
          }
        : null,
      isError: false,
      isPending: false,
      refetch: cohortRefetchMock,
    })
  );
}
