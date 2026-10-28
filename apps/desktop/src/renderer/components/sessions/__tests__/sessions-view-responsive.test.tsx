import {
  GRID_TABLE_METRIC_BAND_TEST_ID,
  GRID_TABLE_SCROLL_BAND_TEST_ID,
} from "@closedloop-ai/design-system/components/ui/grid-table-list-surface";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import {
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "@repo/app/agents/components/sessions/sessions-summary-card-visibility";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { summaryBandRankProbe } from "@repo/app/shared/testing/summary-band-rank-probe";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";
import { V1_SUMMARY_BAND_SELECTOR } from "./fixtures/summary-band-selector";

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
}));

// ISS-7866: signed out, this strip renders the SAME connect ask as the
// dashboard, the Insights grid and Branches. It used to render a Sessions-only
// "Sign in" control, so one reader at one moment met two different verbs for one
// wall depending on which screen they were on. Read from the canonical copy map
// rather than re-spelled, so a wording change cannot pass here and fail there.
const CONNECT_CTA_LABEL =
  GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].cardCtaLabel ??
  GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].ctaLabel;
// The `card` variant carries its own inline sentence (ISS-11476). THIS sentence
// belongs to the `centered` and `banner` variants; on a card it made the gated
// tile taller than its live neighbours and buried the card's own label.
const GATED_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].gatedMetricExplanation;

// Mutable desktop-auth mock so a test can flip the durable-session status
// (default authenticated → the neutral-empty delivery cards; a signed-out
// override → the gated connect ask). `beginSignIn` is no longer wired to these
// cards at all; the mock keeps it because the auth provider's shape requires it.
const auth = vi.hoisted(() => ({
  status: "authenticated" as string,
  beginSignIn: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

// Mutable flag set for gates this suite does not mount through the real Desktop
// provider.
const enabledFlags = vi.hoisted(() => new Set<string>());

// ISS-4901: the shipped `scrollbar-overlay` utility (design-system globals.css)
// the gated Sessions scroll region opts into.
const SCROLLBAR_CUE_CLASS = "scrollbar-overlay";

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  // ISS-7249: Retry cancels the exact list read before refetching it.
  useCancelAgentSessionsPageData: () => () => undefined,
}));

// FEA-3574 review (whitlockk): the desktop reads the LOCAL usage totals directly via
// this hook (a real `useQuery`) to keep the always-available cards SQLite-backed
// in Cloud mode. Stub it so these layout/Local-mode tests don't need a
// `QueryClientProvider`; the local-source topology is covered in the cloud-mode
// suite and the shared sessions-summary-cards tests.
vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => ({ data: undefined, isError: false }),
}));

// Stub the org-scoped connected-agent probe (PRD-536 §5) so these SessionsView
// tests don't stand up the real API-client/auth providers just to render.
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

// FEA-3574: SessionsView now reads the durable-session auth state to drive the
// cloud-only delivery cards' per-card auth state. Stub the desktop auth provider
// so these layout tests don't have to mount the real DesktopAuthProvider; the
// status + `beginSignIn` are read from the mutable `auth` ref so a test can flip
// to the signed-out state and assert the CTA fires its handler.
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: auth.status },
    beginSignIn: auth.beginSignIn,
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

// The shared table and summary strip read some gates OPTIONALLY, so this module
// mock must expose BOTH hooks or the whole subtree throws on the missing export.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: (key: string) => ({
    enabled: enabledFlags.has(key),
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: enabledFlags.has(key),
    isReady: true,
  }),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => navigation,
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

/**
 * Any responsive tier that pins a COUNT of columns (`lg:grid-cols-3`,
 * `xl:grid-cols-5`, …). The unprefixed `grid-cols-1` stacked tier is fine — it can
 * never squeeze a card — so the pattern requires a breakpoint prefix.
 */
const FIXED_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;

// ISS-5366: these assertions describe the DESKTOP strip, so the renderer has to
// report the `md+` tier. jsdom's `matchMedia` answers `matches: false` to every
// query, which since ISS-5366 puts `useSummaryCardDensity` in its below-`md`
// fixed-rank regime (the row pins `grid-cols-2` there, so the tier asks whether
// each pinned cell clears the comfortable floor rather than whether all five
// cards close one rank). Declared rather than inherited. (The Sessions strip
// pins Compact since ISS-10540, so its floor no longer depends on the tier;
// the column derivation still does.)
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe("SessionsView responsive layout", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    enabledFlags.clear();
    // Reset the mutable auth ref to the default authenticated status; a test that
    // needs the signed-out CTA overrides `auth.status` before rendering.
    auth.status = DesktopAuthStatus.Authenticated;
    auth.beginSignIn.mockResolvedValue({ ok: true });
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    // FEA-4157: the table + summary cards read from ONE combined
    // `useAgentSessionsPageData` ({ list, usage }); the facet-option toolbar read
    // stays on `useAgentSessionUsage`.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 50,
          readSource: undefined,
        },
        usage: {
          totalSessions: 50,
          totalInputTokens: 1000,
          totalOutputTokens: 250,
          earliestSessionAt: "2026-07-01T00:00:00.000Z",
          latestSessionAt: "2026-07-02T00:00:00.000Z",
          byRepository: [],
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        earliestSessionAt: "2026-07-01T00:00:00.000Z",
        latestSessionAt: "2026-07-02T00:00:00.000Z",
        byRepository: [],
      },
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi.fn().mockResolvedValue({
          localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
        }),
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  // ISS-10314: both list hosts use the shared fixed-width horizontal strip.
  // The launched Electron regression verifies actual 390px geometry and clicks;
  // this fixture protects card sizing and the row owner through the host render.
  it("keeps the summary bar horizontally scrollable with the shared per-card minimum", async () => {
    render(<SessionsView />, { wrapper: SessionsViewTestProviders });
    await screen.findByRole("navigation", { name: "pagination" });

    const totalTokens = screen.getByText("Total Tokens");
    let row: HTMLElement | null = totalTokens;
    while (row && !row.style.getPropertyValue("--summary-card-min")) {
      row = row.parentElement;
    }
    if (!row) {
      throw new Error("Sessions shared summary row was not found");
    }
    expect(row.style.getPropertyValue("--summary-card-min")).toBe("192px");
    expect(row.classList.contains("flex")).toBe(true);
    expect(row.classList.contains("overflow-x-auto")).toBe(true);
    expect(row.classList.contains("gap-4")).toBe(true);
    expect(row.classList.contains("grid")).toBe(false);
    expect(row.className).not.toMatch(FIXED_COLUMN_TIER_PATTERN);
  });

  it("lays ONE Sessions strip whose every card spans the band (ISS-11472)", async () => {
    // whitlockk review on #8082: the specs above check card count, rank and floor,
    // so removing `grow` from the shared band props again stayed green. This is
    // the band-edge assertion for the DESKTOP shell — the web shell's twin is
    // `apps/app/app/(authenticated)/[orgSlug]/sessions/__tests__/toolbar-options-menu-mounted.test.tsx`.
    // Counted rather than probed for absence: `strips` is an equality against 1
    // (a shell that rendered no strip fails), and `cards` is floored above zero
    // beside the stretch equality so the per-card check cannot pass vacuously.
    const { container } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
    await screen.findByRole("navigation", { name: "pagination" });

    const probe = summaryBandRankProbe(container);
    expect(probe.strips).toBe(1);
    expect(probe.cards).toBeGreaterThan(0);
    expect(probe.stretchingCards).toBe(probe.cards);
  });

  it("renders the five-card set: no Median PR Size on the Sessions bar (FEA-4126 guard)", async () => {
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
    await screen.findByRole("navigation", { name: "pagination" });

    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Total Tokens")).toBeTruthy();
    // Operator ruling 2026-09-20: the desktop Sessions Cost card carries ruling
    // 7's alias. Desktop is the surface that licensed it — the 1400px default
    // window lays 207px cards, inside the width band where the canonical phrase
    // orphans its info trigger onto a second line and costs every sibling card a
    // blank one. The basis and the tooltip are unchanged.
    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();
    expect(screen.getByText("PRs Shipped")).toBeTruthy();
    // FEA-4126 regression guard: Median PR Size was removed from the Sessions bar
    // (reversing FEA-3574's re-add) and lives only on Branches. This has regressed
    // once — if the label returns to the desktop Sessions bar, fail.
    expect(screen.queryByText("Median PR size")).toBeNull();
    // ISS-4866 / ISS-5366: the merged-scope label, now unconditional on this
    // surface too. Read from the canonical constant rather than re-declared, so
    // the desktop assertion and the card cannot drift apart.
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeTruthy();
    // 1000 + 250 = 1,250 tokens, summed and abbreviated with `formatTokenCount`
    // ("1.25k") so the headline matches every other token display in the product.
    expect(screen.getByText("1.25k")).toBeTruthy();
    // Authenticated + local producer omits merged-PR metrics → the delivery
    // cards land in the neutral empty: dashed, no ask. Re-pointed by ISS-7866
    // from the retired sign-in copy to the connect ask, which is now the only
    // ask these cards can render; the contract is unchanged — an authenticated
    // reader with nothing to show is not prompted.
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeNull();
    expect(screen.queryByText(GATED_EXPLANATION)).toBeNull();
  });

  // The signed-out desktop path wires the durable auth status into the delivery
  // cards' gated empty. ISS-7869 moved the ask back ONTO the cards, undoing
  // FEA-4037's hoist; ISS-7866 changed WHAT it asks, from a Sessions-only sign-in
  // control to the one connect ask every GitHub-truth surface renders.
  //
  // The `beginSignIn` click that used to close this case is deliberately gone:
  // that handler is no longer connected to these cards, so asserting it would
  // pin a wire that does not exist. Its replacement — the click reaching the
  // desktop connect target, and a FAILED handoff staying visible — is pinned in
  // `sessions-summary-cards-with-github-connect.test.tsx`, at the seam that owns
  // that wiring.
  it("renders the connect ask inside each delivery card when signed out", async () => {
    auth.status = DesktopAuthStatus.SignedOut;

    const { container } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
    await screen.findByRole("navigation", { name: "pagination" });

    const connectButtons = screen.getAllByRole("button", {
      name: CONNECT_CTA_LABEL,
    });
    expect(connectButtons).toHaveLength(2);
    // The load-bearing half of the un-hoist: each control sits INSIDE a card. A
    // hoisted banner would satisfy the count above just as well, and a hoisted
    // banner is exactly what this surface shipped before.
    for (const button of connectButtons) {
      const card = button.closest('[data-slot="card"]');
      expect(card).not.toBeNull();
      // The value is WITHDRAWN, not dashed: signed out we cannot see the cloud
      // merged-PR layer these describe, and the gated glyph now matches the
      // dashboard's rather than this strip's old bold em-dash.
      expect(card?.textContent).toContain("No data");
    }
    expect(container.querySelectorAll('[data-slot="card"]').length).toBe(5);
    // The card variant carries the verb ALONE — no explanation sentence, which
    // is what keeps a gated card the same height as its live neighbours.
    expect(screen.queryByText(GATED_EXPLANATION)).toBeNull();
    // A GATED CARD STILL SAYS WHICH METRIC IT IS. This is the defect that opened
    // ISS-7866 — "Merged PRs: CTA (the title of the card is missing. that's a
    // bug.)" — caused by a host replacing the whole `MetricCard` with a bare
    // affordance instead of filling its caption slot. A reader who cannot name
    // the locked metric cannot decide whether unlocking it is worth anything.
    expect(screen.getByText("PRs Shipped")).toBeTruthy();
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeTruthy();
  });

  // A TRANSIENT auth status (mid-OAuth `Exchanging`, or the pre-restore
  // `Loading`) is NOT signed out — the ask must not flash there, or a restoring
  // user is prompted on startup and the controls stay live mid-flow.
  //
  // ISS-7866 re-pointed this from the sign-in CTA to the connect CTA, and it now
  // pins the bug that motivated the change: the view resolved `authenticated`
  // with the transient-aware predicate while the connect wrapper re-derived a
  // strict `=== "authenticated"`. Mid-handoff the two disagreed, so the cards
  // read as signed in while the connect action resolved to a signed-out SignUp
  // — some cards asking and others not, out of ONE auth state. This fails if
  // either half starts deriving its own value again.
  it("does not render the connect ask during a transient auth status", async () => {
    auth.status = DesktopAuthStatus.Exchanging;

    const { container } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
    await screen.findByRole("navigation", { name: "pagination" });

    expect(
      screen.queryByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeNull();
    expect(screen.queryByText(GATED_EXPLANATION)).toBeNull();
    // Still a full strip, just an unprompted one — proving the absence above is
    // the gate declining to ask, not the cards failing to render.
    expect(container.querySelectorAll('[data-slot="card"]').length).toBe(5);
  });

  // Regression: the local-session-source status effect subscribes via
  // `window.desktopApi.onDbChanged?.(…)`, which optional-chains only the METHOD.
  // If the preload global itself is absent when the effect runs (a sibling
  // renderer suite tore it down, or a preload race), the un-guarded
  // `window.desktopApi.onDbChanged` throws `reading 'onDbChanged'` inside a React
  // passive effect and fails the whole suite. Rendering with NO desktopApi must
  // mount cleanly (the effect no-ops) rather than throw.
  it("mounts without throwing when window.desktopApi is absent at effect time", async () => {
    Reflect.deleteProperty(window, "desktopApi");

    expect(() =>
      render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      })
    ).not.toThrow();
    // Flush the passive effect + any queued microtasks so a late throw would
    // surface here rather than as an unhandled rejection.
    await act(async () => {
      await Promise.resolve();
    });

    // With no local monitor the summary bar is in its loading/placeholder
    // state (no card labels yet), so assert the always-mounted list region to
    // prove the component rendered cleanly rather than a state-dependent card
    // label. ISS-8909 moved that gate from the retired v1 toolbar stand-in to
    // the v2 surface's own render anchor.
    expect(
      await screen.findByTestId(SESSIONS_HISTORY_LIST_TEST_ID)
    ).toBeTruthy();
  });

  it("keeps footer pagination inside a horizontal overflow owner", async () => {
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    const pagination = await screen.findByRole("navigation", {
      name: "pagination",
    });

    await waitFor(() =>
      expect(screen.queryByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).toBeTruthy()
    );
    expect(pagination.classList.contains("min-w-max")).toBe(true);
    if (!pagination.parentElement) {
      throw new Error("Desktop sessions pagination overflow owner was missing");
    }
    expect(pagination.parentElement.classList.contains("overflow-x-auto")).toBe(
      true
    );
  });

  // Regression: the local-session-source status effect drives an async
  // `getAgentMonitorUrl()` refresh via both a 500ms `setInterval` (while status
  // is `starting`) and an `onDbChanged` subscription. If those keep firing
  // after unmount they dereference `window.desktopApi`, which the desktop
  // teardown removes — throwing inside a React passive effect. This is the
  // recurring cross-test `getAgentMonitorUrl` flake AND a real production leak.
  // Assert the component makes NO `window.desktopApi` access after unmount even
  // when a pending interval fires against a removed global.
  it("does not touch window.desktopApi after unmount when the refresh interval fires", async () => {
    vi.useFakeTimers();
    try {
      const getAgentMonitorUrl = vi.fn().mockResolvedValue({
        // Stay in `starting` so the 500ms refresh interval stays armed and the
        // status-driven effect keeps rescheduling — the exact leak condition.
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.starting,
      });
      let dbChangedListener: (() => void) | undefined;
      const onDbChanged = vi.fn((listener: () => void) => {
        dbChangedListener = listener;
        return () => undefined;
      });
      Object.defineProperty(window, "desktopApi", {
        configurable: true,
        value: { getAgentMonitorUrl, onDbChanged },
      });

      const { unmount } = render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });
      // Let the initial synchronous refresh + its promise resolve run.
      await act(async () => {
        await Promise.resolve();
      });

      unmount();
      const callsAtUnmount = getAgentMonitorUrl.mock.calls.length;

      // Simulate the desktop preload teardown removing the API, then let the
      // still-armed 500ms interval fire several times. The guarded refresh must
      // no-op rather than throw on the removed global.
      Reflect.deleteProperty(window, "desktopApi");
      expect(() => {
        vi.advanceTimersByTime(2000);
        // A late onDbChanged callback captured before unmount must also no-op.
        dbChangedListener?.();
      }).not.toThrow();

      // No new getAgentMonitorUrl access happened after unmount.
      expect(getAgentMonitorUrl.mock.calls.length).toBe(callsAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  // ISS-4901 at the DESKTOP host. The renderer's pane is narrower than the web
  // content area, so MORE of the table lives past the fold and it scrolls with
  // the same at-rest-invisible overlay scrollbar.
  describe("horizontal scroll affordance (ISS-4901)", () => {
    // ISS-8909: the element that actually scrolls is now the v2 surface's own
    // table band, addressed by its shipped test id rather than by the v1 host's
    // class list (the band carries `min-w-0` too, so a class-shaped selector
    // both misses it and says nothing about which element scrolls).
    const scrollRegion = () =>
      screen.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);

    it("puts the scroll cue on the bounded scroll region", () => {
      render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });

      // On the element that actually scrolls — a scrollbar utility on a
      // non-scrolling ancestor styles nothing — and alongside, not instead of,
      // the region's own bounding classes.
      const region = scrollRegion();
      expect(region.className).toContain("overflow-auto");
      expect(region.className).toContain("min-h-0");
      expect(region.className).toContain("flex-1");
      expect(region.className).toContain(SCROLLBAR_CUE_CLASS);
    });
  });

  // FEA-4217 at the DESKTOP host (whitlockk review). Two host decisions the shared
  // component cannot make for itself, both gated on the shared Grid Parity Labs
  // key: which hidden set reaches the strip, and whether the padded band around
  // it stays mounted. (The export row is a CLOUD-mode decision; this surface is
  // Local by default, so it is asserted in `sessions-view-cloud-mode`.)
  describe("summary-card host wiring (FEA-4217)", () => {
    /**
     * ISS-9107: under the Grid Parity gate the flag now selects the v2 branch,
     * where the SURFACE owns the padded band the v1 `SessionsSummaryBand` used
     * to draw. The host decision under test is unchanged — which hidden set
     * reaches the strip, and whether the band survives being emptied — so this
     * reads the band that actually renders on that path.
     */
    const summaryBand = () =>
      document.querySelector<HTMLElement>(
        `${V1_SUMMARY_BAND_SELECTOR}, [data-testid="${GRID_TABLE_METRIC_BAND_TEST_ID}"]`
      );

    function hideCards(...cardIds: readonly string[]) {
      hooks.useSessionsViewState.mockReturnValue({
        hiddenSummaryCards: new Set<string>(cardIds),
        isViewReady: true,
        setSort: vi.fn(),
        sortDir: "desc",
        sortKey: null,
        toggleColumn: vi.fn(),
        toggleSummaryCard: vi.fn(),
        visibleColumns: new Set<string>(["name"]),
      });
    }

    it("paints only the cards the reader kept, and keeps the band around them", () => {
      hideCards(SessionsSummaryCardId.Cost, SessionsSummaryCardId.LocPerDollar);

      const { container } = render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });

      expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(
        SESSIONS_SUMMARY_CARD_IDS.length - 2
      );
      expect(summaryBand()).not.toBeNull();
    });

    it("drops the padded band itself when every card is hidden, not just the cards", () => {
      // The strip already rendered nothing here. The band did not: its own
      // `pt-4 pb-3` and sticky box stayed between the toolbar and the table, so
      // the empty band the reader removed simply moved up one level.
      hideCards(...SESSIONS_SUMMARY_CARD_IDS);

      const { container } = render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });

      expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
      expect(summaryBand()).toBeNull();
    });

    it("drops the band but keeps the coaching tips when every card is hidden", () => {
      // ISS-9107: on v1 the tips were the band's other occupant, so the band
      // survived being emptied of cards. Under the gate the flag now selects v2,
      // where the tips render in their own wrapper ABOVE the surface and the
      // surface's metric band is dropped once every card is hidden. Both halves
      // are asserted so the rename is a statement, not a deletion.
      hideCards(...SESSIONS_SUMMARY_CARD_IDS);
      enabledFlags.add(DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY);

      render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });

      expect(screen.getByTestId("agent-coaching-tips")).not.toBeNull();
      expect(summaryBand()).toBeNull();
    });
  });
});
