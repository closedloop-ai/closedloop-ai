import { BranchStatus } from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortRequest } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";
import {
  cardText,
  makeAnalytics,
  makeAnalyticsWithCanonicalSpend,
  makeBranchRow,
  makeCanonicalMetrics,
  makeCohortRows,
  makeListResponse,
  pageDataResult,
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
const RETRY_BUTTON_NAME_PATTERN = /retry/i;
const FIXED_SUMMARY_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;
const PINNED_SUMMARY_CARD_SIZE_PATTERN = /(?:min-w|basis)-\[1[12]rem\]/;
const SUMMARY_DERIVED_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";
// FEA-4004 retired this flag; the string is kept only so this regression can
// force the pre-PR default-hide branch on. If the removal ever regressed, the
// old code would still gate on this key and hide the merged/agent rows below,
// failing the assertions — the flag being off (as it defaults) would let the
// pre-PR show-all path pass trivially and hide the regression (wongk review).
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
  githubKeys: { all: ["github"] },
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
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

// This page test renders without a FeatureFlagAdapterProvider, so stub the flag
// hook. Default-off for any flag-gated child; a hoisted `vi.fn()` so a test can
// opt a specific flag on.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
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
    expect(screen.getByText("app")).toBeInTheDocument();
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
      aiSpendUsd: {
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
    await waitFor(() => expect(cardText("AI spend")).toContain("$321"));
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
      "Collaborators",
      "Linked sessions",
      "Changes",
      "Status",
      "Pull request",
      "Last active",
      "Repository",
      "Tags",
    ]);
  });

  // FEA-4177 — independent failure domains: an analytics-only failure degrades
  // the summary cards to "Unavailable" but the branches table still renders.
  it("renders the table when only the analytics half fails and retries every Branches query", () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([makeBranchRow()]),
        analyticsError: true,
      })
    );

    render(<BranchesPage />);

    // The list rows still render (the required half succeeded)...
    expect(screen.getByText("feature/web-branches")).toBeInTheDocument();
    // ...while the summary KPI cards degrade to their own "Unavailable" state.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    // ...and the failure gets an honest reason + a Retry, not a silent dimmed
    // row (wongk review): the analytics-only half-failure must offer a way back.
    expect(screen.getByText(SUMMARY_METRICS_ERROR_PATTERN)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith(
      { queryKey: ["branches", "page-data"] },
      { throwOnError: true }
    );
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
    // fail. Post-PR the flag is ignored, so every branch renders (wongk review).
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

  it("derives the summary grid from the shared per-card minimum", () => {
    const { container } = render(<BranchesPage />);
    const grid = container.querySelector<HTMLElement>(
      `[class~="${SUMMARY_DERIVED_TRACKS_CLASS}"]`
    );

    expect(grid).not.toBeNull();
    expect(grid).toHaveClass(
      "grid-cols-2",
      "gap-4",
      "max-md:[&>*:last-child:nth-child(odd)]:col-span-2"
    );
    expect(grid?.style.getPropertyValue("--summary-card-min")).toBe("192px");
    expect(grid?.className).not.toMatch(FIXED_SUMMARY_COLUMN_TIER_PATTERN);
    const cards = [...(grid?.querySelectorAll('[data-slot="card"]') ?? [])];
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card).toHaveClass("w-full");
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
    // at all" copy — the server already applied startDate (wongk review #3663).
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([]) })
    );
    rerender(<BranchesPage />);
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all time" })
    ).toBeInTheDocument();
  });

  it("shows the genuine 'No branches yet' onboarding copy only once the window is widened to all-time", () => {
    // Empty list, default 30-day window → filtered-empty with a "Show all time"
    // action. Widening to all-time removes the window, so the same empty read
    // now honestly reads as onboarding (wongk review #3663).
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({ list: makeListResponse([]) })
    );
    render(<BranchesPage />);

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching branches")).not.toBeInTheDocument();
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps branches route critical a11y and contrast clean in %s theme", async (theme) => {
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
  });

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
  ])("keeps branches %s state a11y and contrast clean", async (_state, setup, expectedText) => {
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
  });

  it("starts backfill and invalidates branches after a connected return", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));

    render(<BranchesPage />);

    expect(
      screen.getByText("GitHub is connected. Branch data is refreshing.")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/integrations/github/backfill",
        { mode: GitHubBackfillMode.Apply },
        // ISS-5013: Apply mode runs the backfill synchronously, so it opts out
        // of the default client deadline with an explicit longer one.
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      )
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["branches"],
    });
  });

  // ISS-5013 (thadeusb): the abandon path the `.finally()` was added for. The
  // effect invalidates `branchesKeys.all` eagerly BEFORE the POST, so a bare
  // `toHaveBeenCalledWith` cannot tell `.finally()` from `.then()` — only the
  // SECOND branches invalidation proves the settle-path fired. Before the client
  // deadline the POST hung and nothing settled, so this path did not exist; now
  // it rejects at LONG_RUNNING_API_TIMEOUT_MS with rows possibly written
  // server-side, and a success-only invalidation would leave the list asserting
  // "nothing here" about an org that has branches.
  it("invalidates branches even when the backfill is abandoned at the deadline", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));
    apiPostMock.mockRejectedValue(new Error("timed out"));
    // `invalidateQueriesMock` is hoisted and not reset in `beforeEach`, so clear
    // the calls this assertion counts.
    invalidateQueriesMock.mockClear();

    render(<BranchesPage />);

    await waitFor(() =>
      expect(
        invalidateQueriesMock.mock.calls.filter(
          ([arg]) => arg?.queryKey?.[0] === "branches"
        )
      ).toHaveLength(2)
    );
    expect(
      screen.queryByText(
        "Branch refresh failed. Retry from the Refresh button."
      )
    ).not.toBeInTheDocument();
  });
});

// FEA-3629 v2 — the #3281 gap. #3281 wired the top-bar summary cards to
// `deriveFilteredBranchAnalytics(analytics, data.items, filters)` — the RAW
// server corpus — so applying a facet re-derived the KPIs over rows the table
// was HIDING (windowed-out), not the VISIBLE set. The cards then disagreed with
// the filtered table (the user-visible "stats don't refresh correctly" bug).
// The fix re-projects over `selectVisibleWireRows`, so this test drives a REAL
// facet with a windowed-out row present in `data.items` and asserts every card
// reflects only the visible rows. It FAILS against #3281's wiring (the
// windowed-out row's $1000 leaks into AI spend) and passes with the fix.
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
  // `data.items`. A raw-corpus derivation would fold its $1000 into the
  // owner-filtered AI spend.
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
        // Full-corpus base: AI spend 999 (all-time), so a card still showing it
        // after filtering proves the cards never re-derived at all.
        analytics: makeAnalytics(),
      })
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("re-derives AI spend over the visible rows only, excluding a windowed-out row", async () => {
    const user = userEvent.setup();
    mockExactCohortSpend(40);
    render(<BranchesPage />);

    // The out-of-window row is dropped from the table by the default 30d window.
    expect(screen.getByText("feature/visible-open")).toBeInTheDocument();
    expect(screen.queryByText("feature/out-of-window")).not.toBeInTheDocument();

    // Apply an owner = alice facet (both rows are alice; only the in-window one
    // is visible). #3281 would sum $40 + $1000 = $1,040 over the raw corpus.
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.hover(screen.getByRole("menuitem", { name: "Owner" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Filter...")).toBeVisible()
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: ALICE_OWNER_PATTERN })
    );

    // AI spend must equal the visible $40 (→ "$40"), never the all-time $999
    // base and never the raw-corpus $1,040 that #3281 shipped.
    await waitFor(() => expect(cardText("AI spend")).toContain("$40"));
    expect(cardText("AI spend")).not.toContain("999");
    expect(cardText("AI spend")).not.toContain("1,040");
  });

  it("uses exact producer spend for a 101-branch filtered cohort", async () => {
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
    await user.click(screen.getByRole("button", { name: "Filter" }));
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
      expect(cardText("AI spend")).toContain("$321");
    });
    expect(cardText("AI spend")).not.toContain("$101");
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
    await user.click(screen.getByRole("button", { name: "Filter" }));
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

// ISS-4737 — a filtered subset whose priced sessions sum to exactly $0 must
// render the AI-spend card's no-data state, not "$0". The client re-projection
// used to gate availability on "the subset holds at least one priced session",
// so a zero-priced session produced an Available $0 that told the user the work
// was free while the server producer reported the same corpus as no-data. This
// drives the real page → real summary cards, so it asserts what the user sees.
describe("BranchesPage AI spend renders no-data for a zero-sum priced subset (ISS-4737)", () => {
  const ZERO_PRICED = makeBranchRow({
    id: "zero-priced",
    branchName: "feature/zero-priced",
    owner: "alice",
    status: BranchStatus.Open,
    estimatedCostUsd: 0,
    sessionIds: ["s-zero"],
  });

  beforeEach(() => {
    vi.useRealTimers();
    headerMock.mockImplementation(renderHeaderMock);
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
    featureFlagEnabledMock.mockReturnValue(true);
  });

  afterEach(() => vi.clearAllMocks());

  it("renders 'No data' when the authoritative per-session cost map prices the subset at zero", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        // s-zero IS priced — it carries an authoritative entry — but its cost is
        // exactly zero, so the subset has no spend figure to report.
        list: makeListResponse([ZERO_PRICED], { "s-zero": 0 }),
        analytics: makeAnalyticsWithCanonicalSpend({
          state: BranchMetricAvailability.NoData,
          value: null,
        }),
      })
    );

    render(<BranchesPage />);

    await waitFor(() => expect(cardText("AI spend")).toContain("No data"));
    expect(cardText("AI spend")).not.toContain("$0");
    // Never the unfiltered corpus figure either — the card IS re-derived.
    expect(cardText("AI spend")).not.toContain("999");
  });

  it("renders a real positive total for the same subset once a session prices above zero", async () => {
    useBranchesPageDataMock.mockReturnValue(
      pageDataResult({
        list: makeListResponse([ZERO_PRICED], { "s-zero": 12 }),
        analytics: makeAnalyticsWithCanonicalSpend({
          state: BranchMetricAvailability.Complete,
          value: 12,
        }),
      })
    );

    render(<BranchesPage />);

    await waitFor(() => expect(cardText("AI spend")).toContain("$12"));
    expect(cardText("AI spend")).not.toContain("No data");
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
