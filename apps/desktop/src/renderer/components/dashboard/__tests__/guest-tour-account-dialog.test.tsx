/**
 * ISS-5112 (PLN-1600 Step C): the guest-mode wiring the page itself owns —
 * which flag/auth combination ends the tour in an account dialog, and whether
 * the "Harnesses found" row actually reaches the tour from local SQLite.
 *
 * The step catalog and the row's shape are pinned in
 * `tour/__tests__/build-tour-steps.test.tsx`; this suite is about the page
 * passing the right inputs. So the flag hook and the harness read are REAL —
 * `FeatureFlagAdapterProvider` resolves the actual registry key, and
 * `useTourHarnesses` runs against a stubbed `window.desktopApi` over a real
 * QueryClient — and only auth state and the flag-snapshot gate are stubbed.
 */

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { Harness } from "@repo/lib/harness/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { UNKNOWN_HARNESS_BUCKET } from "../../../../shared/shared-agent-sessions-contract";
import { GuestSignupProvider } from "../../onboarding/guest-signup-provider";
import { FirstLaunchDashboard } from "../first-launch-dashboard";
import type { TourStep, TourSummaryRow } from "../tour/tour";

type TourProps = {
  active: boolean;
  steps: TourStep[];
  onClose: (reason: "done" | "skip") => void;
  completeLabel?: string;
};

const hooks = vi.hoisted(() => ({
  Tour: vi.fn<
    (props: {
      active: boolean;
      steps: TourStep[];
      onClose: (reason: "done" | "skip") => void;
      completeLabel?: string;
    }) => void
  >(),
  TourHint: vi.fn<(props: { show: boolean }) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
}));

const gate = vi.hoisted(() => ({
  flagsResolved: true,
  authStatus: "" as string,
}));

// Partial: the harness read keys its query off the real `agentSessionKeys`.
vi.mock("@repo/app/agents/hooks/use-agent-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/agents/hooks/use-agent-sessions")
    >();
  return { ...actual, useAgentSessions: hooks.useAgentSessions };
});
// ISS-6002: the local-store readiness probe reaches the agent-monitor over IPC,
// which this suite's partial `window.desktopApi` stub does not provide. Stub ONLY
// that hook; the real dashboard state machine still runs.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => ({ ready: true, unavailable: false }),
  // ISS-6002 (review): a zero only counts once a read has landed WITH the
  // store up. This suite drives a single static query fixture, so stub the
  // freshness verdict too — it is subject-tested in dashboard-state.test.ts.
  useSessionsCountFresh: () => true,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30d",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: gate.authStatus, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => gate.flagsResolved,
}));

// Presentational children the page routes to; out of scope here.
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: () => <div data-testid="dashboard-row" />,
}));
vi.mock("@repo/app/insights/components/overview/ai-impact-card", () => ({
  AiImpactCard: () => null,
}));
vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));
vi.mock("../dashboard-read-source-badge", () => ({
  DashboardReadSourceBadge: () => null,
}));
vi.mock("../tour/tour", () => ({
  Tour: (props: TourProps) => {
    hooks.Tour(props);
    return null;
  },
}));
vi.mock("../tour/tour-hint", () => ({
  TourHint: (props: { show: boolean }) => {
    hooks.TourHint(props);
    return null;
  },
}));

const ACCOUNT_DIALOG_TITLE = "Create your account";
const OPENING_BROWSER_COPY = /Opening your browser to finish/i;
const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type HarnessRow = { harness: string; sessionCount: number };

function installUsageBridge(byHarness: HarnessRow[]): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        usage: () =>
          Promise.resolve({
            byHarness: byHarness.map((row) => ({
              ...row,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0,
            })),
          }),
      },
    },
    writable: true,
  });
}

function stubReadyDashboard(): void {
  hooks.useAgentSessions.mockReturnValue({
    data: { total: 5, items: [] },
    isLoading: false,
    // ISS-6002: the page reads the session query's own status, so a resolved
    // mock has to report one — an absent `isSuccess` now means "not settled".
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
  });
  const resolved = {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
  };
  hooks.useDeliveryInsights.mockReturnValue({ ...resolved, data: {} });
  hooks.useUtilizationInsights.mockReturnValue({
    ...resolved,
    data: { charts: {} },
  });
  hooks.useAgentsInsights.mockReturnValue({
    ...resolved,
    data: { kpis: [], charts: { modelBreakdown: [] } },
  });
}

function renderDashboard(guestOnboardingEnabled: boolean) {
  const source: InsightsDataSource = {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: vi.fn(),
    getDelivery: vi.fn(),
    getUtilization: vi.fn(),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: guestOnboardingEnabled
              ? [DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY]
              : [],
          })}
        >
          {/*
            ISS-5112 Step D: the dashboard no longer owns the account dialog — it
            asks the shared provider, which is what the four entry points share.
            Mounting the real provider keeps this a test of the production path
            rather than of a local piece of state the page stopped having.
          */}
          <GuestSignupProvider>
            <InsightsDataSourceProvider value={source}>
              {children}
            </InsightsDataSourceProvider>
          </GuestSignupProvider>
        </FeatureFlagAdapterProvider>
      </QueryClientProvider>
    ),
  });
}

/** The steps the page last handed the tour. */
function latestSteps(): TourStep[] {
  const call = hooks.Tour.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected the dashboard to render the Tour");
  }
  return call[0].steps;
}

function latestSummary(): TourSummaryRow[] {
  const intro = latestSteps()[0];
  if (!intro?.intro) {
    throw new Error("Expected the first tour step to be the intro summary");
  }
  return intro.summary;
}

/** Drive the production `closeTour` the way the tour's own controls do. */
function closeTour(reason: "done" | "skip"): void {
  act(() => latestTourProps().onClose(reason));
}

function latestTourProps(): TourProps {
  const call = hooks.Tour.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected the dashboard to render the Tour");
  }
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.flagsResolved = true;
  gate.authStatus = DesktopAuthStatus.SignedOut;
  installUsageBridge([]);
  // Reduced motion: the reveal scan is skipped so the page is deterministic.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
  stubReadyDashboard();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("guest tour completion → account dialog (ISS-5112)", () => {
  it("offers an account when a signed-out guest finishes the tour", async () => {
    renderDashboard(true);

    closeTour("done");

    expect(
      await screen.findByRole("dialog", { name: ACCOUNT_DIALOG_TITLE })
    ).toBeDefined();
  });

  it("does not interrupt a signed-in replay of the tour", () => {
    gate.authStatus = DesktopAuthStatus.Authenticated;
    renderDashboard(true);

    closeTour("done");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not offer an account with the flag off", () => {
    renderDashboard(false);

    closeTour("done");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the Scope toggle to a guest, who otherwise never learns it exists", async () => {
    renderDashboard(true);

    // The source advertises only `Me`, so `orgScopeAvailable` is false and the
    // toggle would not render at all — which is exactly why a guest never
    // discovers that an account buys them anything on this page. Queried by
    // text, matching how `dashboard-scope-toggle.test.tsx` drives the same
    // control.
    expect(await screen.findByText("Organization")).toBeDefined();
  });

  it("gates Organization behind an account instead of switching to an empty scope", async () => {
    renderDashboard(true);

    fireEvent.click(await screen.findByText("Organization"));

    // By ROLE, not by text. The card's title is a `CardTitle`, which is a
    // styling slot over a plain div — rebuilding this card on the DS slots
    // silently dropped the heading semantics the hand-rolled `h2` had, and a
    // text query cannot tell the difference. It names the gated region, so it
    // has to be in the document outline.
    const heading = await screen.findByRole("heading", {
      name: "Organization scope needs an account",
    });
    // ...and it is the name the section itself announces.
    expect(heading.closest("section")?.getAttribute("aria-labelledby")).toBe(
      heading.id
    );
  });

  it("puts ONE ask on screen for the Organization request, not two", async () => {
    // Selecting Organization used to raise the gate card AND fire the signup
    // request in the same tick, so the account dialog mounted on top of the
    // card: one request, two surfaces, two bodies, two escape labels, and the
    // card's own primary dead behind the thing covering it. The card IS the
    // ask; nothing stacks over it until its button is pressed.
    renderDashboard(true);

    fireEvent.click(await screen.findByText("Organization"));
    await screen.findByText("Organization scope needs an account");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes straight to the browser from the gate, skipping a second pitch", async () => {
    // The card already named the view, the value and the price. Following it
    // with an offer dialog making the same argument reads as being asked the
    // same question two screens running, so this intent skips the offer — and
    // since ISS-5489 removed the in-dialog provider step, "skip" now means the
    // browser opens directly.
    renderDashboard(true);

    fireEvent.click(await screen.findByText("Organization"));
    // The gate card's own button keeps its wording; only the dialog's primary
    // became "Sign Up".
    fireEvent.click(
      await screen.findByRole("button", { name: "Create account" })
    );

    const dialog = await screen.findByRole("dialog");
    // The pitch never rendered — proof the offer step was skipped rather than
    // merely passed through quickly.
    expect(
      within(dialog).queryByRole("button", { name: "Sign Up" })
    ).toBeNull();
    // Its own wording instead — stable whether the browser handoff succeeds or
    // reports a failure into the same panel.
    expect(await within(dialog).findByText(OPENING_BROWSER_COPY)).toBeDefined();
  });

  it("stands the account offer up on the dashboard title row", async () => {
    renderDashboard(true);

    // Beside Tour and the scope toggle, not in the Topbar window chrome, which
    // would carry a filled primary onto every screen an account changes
    // nothing about.
    expect(
      await screen.findByRole("button", { name: "Create account" })
    ).toBeDefined();
  });

  it("stands the title-row offer down while the gate is the ask", async () => {
    renderDashboard(true);

    fireEvent.click(await screen.findByText("Organization"));
    await screen.findByText("Organization scope needs an account");

    // Exactly one "Create account" on screen, and it is the card's. Two
    // identically-labelled primaries for one decision is the same double this
    // whole path was fixed to remove — and they lead to different places.
    const offers = screen.getAllByRole("button", { name: "Create account" });
    expect(offers).toHaveLength(1);
    expect(
      offers[0]?.closest("section")?.getAttribute("aria-labelledby")
    ).toBeTruthy();
  });

  it("keeps the title-row offer off a signed-in dashboard", () => {
    renderDashboard(false);

    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  it("lifts the gate when the guest backs out through the Scope toggle", async () => {
    // Regression guard (cr-44060). The gate is a section, not a modal, so the
    // header toggle stays live underneath it and "Me" is a real second exit
    // beside the card's own button. The toggle renders `gated ? Org : scope`,
    // so clearing only `scope` left it displaying Organization over a
    // personal-scope state with the gate still covering the page — a control
    // that visibly ignored the click it had just handled.
    renderDashboard(true);

    fireEvent.click(await screen.findByText("Organization"));
    expect(
      await screen.findByText("Organization scope needs an account")
    ).toBeDefined();

    fireEvent.click(screen.getByText("Me"));

    await waitFor(() => {
      expect(
        screen.queryByText("Organization scope needs an account")
      ).toBeNull();
    });
    // Both halves of the state, not just the visible one: clearing `scope`
    // without clearing `orgGated` left the control displaying Organization over
    // personal-scope data, which is the actual defect this guards.
    expect(screen.getByText("Me").getAttribute("data-state")).toBe("on");
  });

  it("leaves the Scope toggle hidden for a guest with the flag off", () => {
    renderDashboard(false);

    // The shipped default: the source advertises no org scope, so there is no
    // toggle and no ask. Rendered from the same synchronous condition as the
    // flag-on case above, so no wait is needed to prove its absence.
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("does not tell a lapsed session to create the account it already has", () => {
    // `refresh_failed` is an EXISTING user whose token expired, not a guest. A
    // plain not-authenticated test swept it into guest mode and offered them
    // sign-up; what they need is to sign back in.
    gate.authStatus = DesktopAuthStatus.RefreshFailed;
    renderDashboard(true);

    closeTour("done");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not stack a second prompt on a sign-in already in flight", () => {
    // A sign-in begun from Settings or the session-expired banner stays active
    // while the user navigates here, so finishing a replay mid-flight would put
    // an account dialog on top of a browser round-trip already under way.
    gate.authStatus = DesktopAuthStatus.OpeningBrowser;
    renderDashboard(true);

    closeTour("done");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats an unresolved flag snapshot as flag-off", () => {
    // The registry default and "the user turned it off" are indistinguishable
    // before the snapshot lands (ISS-5037), so nothing guest-mode fires.
    gate.flagsResolved = false;
    renderDashboard(true);

    closeTour("done");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      latestSteps().some((step) => !step.intro && step.sel === "sessions")
    ).toBe(true);
  });

  it("labels the tour's last button for the handoff it is about to make", () => {
    renderDashboard(true);

    expect(latestTourProps().completeLabel).toBe("Create account");
  });

  it("leaves the last button as 'Done' whenever nothing is handed off", () => {
    renderDashboard(false);
    expect(latestTourProps().completeLabel).toBeUndefined();

    gate.authStatus = DesktopAuthStatus.Authenticated;
    renderDashboard(true);
    expect(latestTourProps().completeLabel).toBeUndefined();
  });

  it("keeps skip on the tour hint, with no account dialog", async () => {
    renderDashboard(true);

    closeTour("skip");

    await waitFor(() =>
      expect(hooks.TourHint.mock.calls.at(-1)?.[0].show).toBe(true)
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("guest tour intro summary (ISS-5112)", () => {
  it("reads the harnesses from the local store and drops the unknown bucket", async () => {
    installUsageBridge([
      { harness: Harness.Codex, sessionCount: 12 },
      { harness: UNKNOWN_HARNESS_BUCKET, sessionCount: 40 },
      { harness: Harness.Claude, sessionCount: 31 },
    ]);
    renderDashboard(true);

    await waitFor(() =>
      expect(latestSummary().map((row) => row.label)).toEqual([
        "Sessions parsed",
        "Models in use",
        "Harnesses found",
      ])
    );
    const harnessRow = latestSummary().at(-1);
    // Most-used first, and the `unknown` bucket — the biggest count here — is
    // gone rather than presented as a tool the user installed.
    expect(harnessRow?.chips?.map((chip) => chip.label)).toEqual([
      "Claude Code",
      "Codex",
    ]);
  });

  it("stays on two rows while the harness read is still in flight", () => {
    installUsageBridge([{ harness: Harness.Claude, sessionCount: 3 }]);
    renderDashboard(true);

    // First paint, before the IPC promise settles: no row rather than a
    // "Harnesses found" heading with nothing beside it.
    expect(latestSummary().map((row) => row.label)).toEqual([
      "Sessions parsed",
      "Models in use",
    ]);
  });

  it("never issues the harness read, nor adds the row, with the flag off", async () => {
    const usage = vi.fn(() => Promise.resolve({ byHarness: [] }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { agentSessionsApi: { usage } },
      writable: true,
    });
    renderDashboard(false);

    await waitFor(() =>
      expect(hooks.Tour.mock.calls.length).toBeGreaterThan(0)
    );
    expect(usage).not.toHaveBeenCalled();
    expect(latestSummary().map((row) => row.label)).toEqual([
      "Sessions parsed",
      "Models in use",
    ]);
  });
});
