import { LOC_PER_DOLLAR_MERGED_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { SESSIONS_COST_METRIC_CARD_LABEL } from "@repo/app/agents/components/sessions/cost-metric-card";
import {
  SESSIONS_SIGN_IN_BANNER_EXPLANATION,
  SESSIONS_SIGN_IN_EXPLANATION,
} from "@repo/app/agents/components/sessions/sessions-sign-in-indicator";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { SessionsView } from "../SessionsView";

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
}));

// Mutable desktop-auth mock so a test can flip the durable-session status
// (default authenticated → the neutral-empty delivery cards; a signed-out
// override → the sign-in CTA) and assert its `beginSignIn` wiring.
const auth = vi.hoisted(() => ({
  status: "authenticated" as string,
  beginSignIn: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

// ISS-4901: mutable flag set so one test can exercise the flag-ON scroll
// affordance. EMPTY by default, so every other test here still sees the
// dark-launch default (off) exactly as before.
const enabledFlags = vi.hoisted(() => new Set<string>());

// ISS-4901: the shipped `scrollbar-overlay` utility (design-system globals.css)
// the gated Sessions scroll region opts into.
const SCROLLBAR_CUE_CLASS = "scrollbar-overlay";

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: () => <div data-testid="sessions-table-body" />,
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: () => <div data-testid="sessions-toolbar" />,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
}));

// FEA-3574 review (wongk): the desktop reads the LOCAL usage totals directly via
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

// ISS-4890/4906/4901 + ISS-4887: the shared table and summary strip read their
// gates OPTIONALLY, so this module mock must expose BOTH hooks or the whole
// subtree throws on the missing export. Both resolve against the mutable set
// above, which is empty (⇒ every flag off) unless a test opts in.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
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

/**
 * The shared row's `md+` auto-fit track template. Written out here rather than
 * read off the component so a change to the template has to be made deliberately
 * rather than silently agreeing with itself (same convention as `@repo/app`'s own
 * summary-card-row tests).
 */
const AUTO_FIT_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";

// ISS-5366: these assertions describe the DESKTOP strip, so the renderer has to
// report the `md+` tier. jsdom's `matchMedia` answers `matches: false` to every
// query, which since ISS-5366 puts `useSummaryCardDensity` in its below-`md`
// fixed-rank regime (the row pins `grid-cols-2` there, so the tier asks whether
// each pinned cell clears the comfortable floor rather than whether all five
// cards close one rank) and resolves COMPACT — publishing a 192px floor for a
// pane that is nothing like a phone. Declared rather than inherited.
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
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  // FEA-4126: the KPI row is the shared `SessionsSummaryCards` composite — FIVE
  // cards (Sessions, Total Tokens, Cost, PRs Shipped, LOC / $ (Merged)), reverting
  // FEA-3574's six-card set (which re-added Median PR Size and wrapped to a second
  // row at the desktop viewport) back to the FEA-3937 layout. Median PR Size stays
  // on the Branches bar; the clipping FEA-3985 fixed stays fixed because this is a
  // wrapping grid, not a fixed non-wrapping row.
  //
  // ISS-4787 follow-up: the strip's columns are DERIVED from the shared
  // `--summary-card-min` floor, never pinned at a count. The old hard `lg:3 → xl:5`
  // tiers put each card at roughly 205px beside the 16rem rail on the 1380px window
  // the defect was reported at, and still under that floor at today's wider default
  // — so the longest label the strip shipped when this was written
  // ("Non-subscription Cost") broke onto a third line and its value dropped a
  // whole line-height below the rest of the rank, which is exactly what the strip's
  // two-line label reservation exists to prevent. Neither the widened default nor
  // the later shortening of that label to "cost" retires this guard: the shorter
  // label BUYS slack, and the wider window only moved the cards nearer the floor
  // they still miss.
  it("derives the summary bar's columns from the shared per-card minimum", async () => {
    render(<SessionsView />);

    // Keep the async status effect alive (mirrors the pagination test) so
    // window.desktopApi is still defined when the effect runs.
    await screen.findByRole("navigation", { name: "pagination" });

    const totalTokens = screen.getByText("Total Tokens");
    // Walk up to the grid container that owns the metric cards.
    let gridRow: HTMLElement | null = totalTokens;
    while (gridRow && !gridRow.classList.contains("grid")) {
      gridRow = gridRow.parentElement;
    }
    if (!gridRow) {
      throw new Error("Sessions KPI grid row was not found");
    }
    // The strip lays out through the shared row's own `wrapBelow` grid, whose
    // md+ tracks are floored at the `--summary-card-min` it publishes on this
    // same element (asserted at the source in `@repo/app`'s summary-card-row
    // tests) rather than a hard column count.
    expect(gridRow.classList.contains(AUTO_FIT_TRACKS_CLASS)).toBe(true);
    // ISS-5366: the COMPACT floor, not the 260px comfortable one. This asserted
    // 260 while `summary-strip-density` was a Labs toggle that resolved OFF in
    // the renderer suites; retiring the gate makes the track-width tier
    // unconditional, and at this pane's measured track five comfortable cards
    // cannot close one rank while five compact ones can — which is exactly the
    // rank ISS-5068 bought. So the published floor legitimately steps down, and
    // pinning 260 would now be pinning the pre-retirement layout.
    expect(gridRow.style.getPropertyValue("--summary-card-min")).toBe("192px");
    // Stage review: one layout owner, so the desktop strip cannot drift from the
    // row on its narrow treatment or its gutter the way the removed
    // `SUMMARY_CARD_GRID_CLASS` host class had.
    expect(gridRow.classList.contains("grid-cols-2")).toBe(true);
    expect(gridRow.classList.contains("gap-4")).toBe(true);
    // No hard column count above the stacked tier — a fixed count is what let the
    // cards fall under the floor in the first place.
    expect(gridRow.className).not.toMatch(FIXED_COLUMN_TIER_PATTERN);
  });

  it("renders the five-card set: no Median PR Size on the Sessions bar (FEA-4126 guard)", async () => {
    render(<SessionsView />);
    await screen.findByRole("navigation", { name: "pagination" });

    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Total Tokens")).toBeTruthy();
    // ISS-4401: the desktop Sessions Cost card carries the per-surface
    // "cost" label (not a bare "Cost"), distinguishing its
    // not-subscription-covered figure from the Dashboard's inclusive total.
    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.getByText("PRs Shipped")).toBeTruthy();
    // FEA-4126 regression guard: Median PR Size was removed from the Sessions bar
    // (reversing FEA-3574's re-add) and lives only on Branches. This has regressed
    // once — if the label returns to the desktop Sessions bar, fail.
    expect(screen.queryByText("Median PR size")).toBeNull();
    // ISS-4866 / ISS-5366: the merged-scope label, now unconditional on this
    // surface too. Read from the canonical constant rather than re-declared, so
    // the desktop assertion and the card cannot drift apart.
    expect(screen.getByText(LOC_PER_DOLLAR_MERGED_LABEL)).toBeTruthy();
    // 1000 + 250 = 1,250 tokens, summed and abbreviated with `formatTokenCount`
    // ("1.25k") so the headline matches every other token display in the product.
    expect(screen.getByText("1.25k")).toBeTruthy();
    // Authenticated + local producer omits merged-PR metrics → the three
    // delivery cards land in the neutral-empty state (state 3): dashed, no CTA.
    expect(screen.queryByText(SESSIONS_SIGN_IN_EXPLANATION)).toBeNull();
  });

  // FEA-3574 (review): the signed-out desktop path wires the durable auth status
  // into the delivery cards' state-2 empty and threads `beginSignIn` through as
  // the handler. FEA-4037: the ask is now a SINGLE prompt above the row (one per
  // surface), not three per-card CTAs. Flip the auth mock to `SignedOut` and
  // assert the one banner renders and clicking it fires the mocked `beginSignIn`.
  it("renders ONE sign-in prompt above the row and fires beginSignIn when signed out", async () => {
    auth.status = DesktopAuthStatus.SignedOut;

    render(<SessionsView />);
    await screen.findByRole("navigation", { name: "pagination" });

    // FEA-4037: a single banner ask, not the same CTA repeated on three cards.
    expect(screen.getByText(SESSIONS_SIGN_IN_BANNER_EXPLANATION)).toBeTruthy();
    expect(screen.queryByText(SESSIONS_SIGN_IN_EXPLANATION)).toBeNull();
    const signInButtons = screen.getAllByRole("button", { name: "Sign in" });
    expect(signInButtons).toHaveLength(1);

    fireEvent.click(signInButtons[0]);
    expect(auth.beginSignIn).toHaveBeenCalledTimes(1);
  });

  // FEA-3574 (review, ZVH): a FAILED `beginSignIn` ({ ok: false, reason }) must
  // surface a retryable error instead of leaving the prompt unchanged. FEA-4037:
  // the error now renders ONCE on the single banner, not per card.
  it("surfaces a retryable error once on the prompt when beginSignIn fails", async () => {
    auth.status = DesktopAuthStatus.SignedOut;
    auth.beginSignIn.mockResolvedValue({ ok: false, reason: "open_failed" });

    render(<SessionsView />);
    await screen.findByRole("navigation", { name: "pagination" });

    const signInButtons = screen.getAllByRole("button", { name: "Sign in" });
    fireEvent.click(signInButtons[0]);

    // The failure copy renders ONCE (on the banner, via the shared
    // signInFailureMessage("open_failed")), and the CTA remains as the retry.
    await waitFor(() =>
      expect(
        screen.getAllByText("Couldn't open your browser. Try again.")
      ).toHaveLength(1)
    );
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  });

  // FEA-3574 (review): a TRANSIENT auth status (mid-OAuth `Exchanging`, or the
  // pre-restore `Loading`) is NOT signed out — the CTA must not flash there or a
  // restoring user is told to sign in and all three buttons stay live mid-flow.
  it("does not render the sign-in CTA during a transient auth status", async () => {
    auth.status = DesktopAuthStatus.Exchanging;

    render(<SessionsView />);
    await screen.findByRole("navigation", { name: "pagination" });

    expect(screen.queryByText(SESSIONS_SIGN_IN_EXPLANATION)).toBeNull();
    expect(screen.queryByText(SESSIONS_SIGN_IN_BANNER_EXPLANATION)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
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

    expect(() => render(<SessionsView />)).not.toThrow();
    // Flush the passive effect + any queued microtasks so a late throw would
    // surface here rather than as an unhandled rejection.
    await act(async () => {
      await Promise.resolve();
    });

    // With no local monitor the summary bar is in its loading/placeholder
    // state (no card labels yet), so assert the always-mounted toolbar to prove
    // the component rendered cleanly rather than a state-dependent card label.
    expect(await screen.findByTestId("sessions-toolbar")).toBeTruthy();
  });

  it("keeps footer pagination inside a horizontal overflow owner", async () => {
    render(<SessionsView />);

    const pagination = await screen.findByRole("navigation", {
      name: "pagination",
    });

    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
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

      const { unmount } = render(<SessionsView />);
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
  // content area, so MORE of the table lives past the fold — and it scrolls with
  // the same at-rest-invisible overlay scrollbar. Both surfaces must gate the cue
  // on the SAME key, or it appears on one and not the other.
  describe("horizontal scroll affordance (ISS-4901)", () => {
    const scrollRegion = () =>
      document.querySelector<HTMLElement>(".min-h-0.flex-1.overflow-auto");

    it("renders no scroll cue with the Labs toggle off", () => {
      render(<SessionsView />);
      expect(scrollRegion()?.className).not.toContain(SCROLLBAR_CUE_CLASS);
    });

    it("puts the scroll cue on the bounded scroll region with the Labs toggle on", () => {
      enabledFlags.add(DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY);
      render(<SessionsView />);

      // On the element that actually scrolls — a scrollbar utility on a
      // non-scrolling ancestor styles nothing — and alongside, not instead of,
      // the region's own sizing classes.
      const region = scrollRegion();
      expect(region?.className).toContain("min-h-0 flex-1 overflow-auto");
      expect(region?.className).toContain(SCROLLBAR_CUE_CLASS);
    });
  });
});
