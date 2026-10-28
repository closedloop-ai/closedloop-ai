import {
  GitHubDataConnectionSource,
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { listSurfacePageNounsNamedIn } from "../../../shared-branches/__tests__/connect-status-page-noun-fixture";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import { DesktopGitHubConnectState } from "../../branches/use-desktop-github-connect";
import { DashboardPage } from "../DashboardPage";

// FEA-3280: the desktop Dashboard's gated GitHub KPI card must wire its
// "Connect GitHub" CTA to the desktop connect flow (sign-in → openGitHubConnect
// IPC), not a dead click. This mounts the REAL render path
// (DesktopInsightsProvider → FirstLaunchDashboard → DashboardRowContent →
// ConnectGitHubIndicator) — the FEA-3273 branches fix's sibling for the
// Dashboard surface — so a regression to a dead link is caught end to end.
//
// The DesktopInsightsProvider (real, unmocked) owns the gating + the connect
// handler; only the leaf data hooks are stubbed so the dashboard reaches its
// ready state with a GitHub-gated KPI card without a live SQLite backend.

const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useDesktopAuth: vi.fn(),
  useApiClient: vi.fn(),
  useDesktopAppCoreMode: vi.fn(),
  useDesktopLocalReadReason: vi.fn(),
}));

// Partial: ISS-5112's harness read keys its query off the real
// `agentSessionKeys`, so only the hook is replaced.
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
  useDashboardSessionSource: () => ({
    ready: true,
    importInProgress: false,
    unavailable: false,
  }),
  // ISS-6002 (review): a zero only counts once a read has landed WITH the
  // store up. This suite drives a single static query fixture, so stub the
  // freshness verdict too — it is subject-tested in dashboard-state.test.ts.
  useSessionsCountFresh: () => true,
}));
// PLN-1138 Phase 3: DesktopInsightsProvider now reads useApiClient (the D-G
// cloud transport) + useDesktopAppCoreMode. This test exercises the local-mode
// connect CTA, so both are stubbed — the cloud client is never invoked in Local
// mode (the insights hooks above are mocked anyway).
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: hooks.useApiClient,
}));
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: hooks.useDesktopAppCoreMode,
  // ISS-5477: the read-source badge under this tree also asks WHY the active
  // source is in play. Neither suite exercises that, so it gets the drained
  // decision (no explanatory detail rendered).
  useDesktopLocalReadReason: hooks.useDesktopLocalReadReason,
}));
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/insights/hooks/use-insights")
    >();
  return {
    ...actual,
    useDeliveryInsights: hooks.useDeliveryInsights,
    useUtilizationInsights: hooks.useUtilizationInsights,
    useAgentsInsights: hooks.useAgentsInsights,
  };
});
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
  useDesktopAuth: hooks.useDesktopAuth,
}));

const CONNECT_GITHUB_RE = /connect (?:to )?github/i;
/**
 * Kept as a NEGATIVE guard. ISS-5958 D1 gave a signed-out reader a distinct
 * "Sign up with GitHub" verb, because the flow creates an account before it can
 * open GitHub's authorize page. ISS-7866 reverses that: the
 * `pre-auth-desktop-onboarding` prototype draws the pre-auth dashboard with
 * "Connect GitHub" on every gated card, and the cost of the split was that one
 * reader at one moment met two verbs for one wall depending on which screen
 * they were on. The account step is still real — it is named by the flow, not
 * by the card. This regex now asserts the old verb is GONE.
 */
const SIGN_UP_GITHUB_RE = /sign up with github/i;
/**
 * How many asks a disconnected dashboard carries, one per GitHub-dependent
 * widget: the three stats-row KPIs (`kpi:merged`, `kpi:kloc`, `kpi:pr-size`,
 * ISS-7866), the three AI Impact metrics that divide by GitHub data, and the
 * merged-PRs-by-repository chart (ISS-12638). Pinned as a count so a widget that
 * silently stops gating fails here rather than quietly letting a query pick
 * whichever CTA happens to come first.
 */
const GATED_DASHBOARD_CTA_COUNT = 3 + 3 + 1;
/**
 * The gated-metric explanation. ISS-7866 moved it OUT of the `card` variant — a
 * gated card renders the verb alone — so this now only ever appears on the
 * `centered` and `banner` variants, and its absence on a card is a contract.
 */
const GATED_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation;
/** Rendered by the ready dashboard in every connection state. */
const READY_DASHBOARD_RE = /Last 30 days/i;
const OPENED_BANNER_RE = /Continue in the browser to connect GitHub/i;
const FAILED_BANNER_RE = /GitHub connect could not be opened/i;
/**
 * The WHOLE failed-connect sentence, read from the one copy map the renderer
 * uses. `FAILED_BANNER_RE` above matches only the state half, so it stayed green
 * through every wording of the continuation — including the one that told a
 * Dashboard reader that BRANCHES would refresh (ISS-11326).
 */
const FAILED_BANNER_MESSAGE =
  desktopGitHubConnectMessage(
    DesktopGitHubConnectState.Failed,
    DesktopGitHubConnectSurface.List
  )?.message ?? "";
/**
 * ISS-11326: the STALLED list wording. The Dashboard has its tiles on screen
 * beneath the banner, so it takes the populated one; asserting this is absent
 * pins which variant the provider passes.
 */
const STALLED_LIST_FAILED_MESSAGE =
  desktopGitHubConnectMessage(
    DesktopGitHubConnectState.Failed,
    DesktopGitHubConnectSurface.StalledList
  )?.message ?? "";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function insightResult(data: unknown) {
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    data,
  };
}

// Ready-state analytics: all three sections resolved so the dashboard leaves
// its loading treatment and renders the tile rows.
function stubAnalyticsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { prTrend: { points: [] } } })
  );
  // The desktop's local engine always returns the heatmap and the autonomy
  // trend, even when empty. ISS-9993 drops a row whose data is absent, so
  // without them the activity row this suite reads would not render.
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({
      kpis: [],
      charts: {
        eventActivity: { points: [] },
        activityHeatmap: { days: [], cells: [] },
      },
    })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      kpis: [],
      charts: { modelBreakdown: [], autonomyTrend: { series: [], points: [] } },
    })
  );
  hooks.useAgentSessions.mockReturnValue({
    data: { total: 12, items: [] },
    isLoading: false,
    // ISS-6002: the page reads the session query's own status, so a resolved
    // mock has to report one — an absent `isSuccess` now means "not settled".
    isSuccess: true,
    isError: false,
    dataUpdatedAt: 1,
  });
}

function installDesktopApi(
  openGitHubConnect: ReturnType<typeof vi.fn>,
  githubStatus: GitHubIntegrationStatus | null = { connected: false }
) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: vi.fn(async () => ({ charts: {}, kpis: [] })),
      },
      getApiKeyStatus: vi.fn(async () => ({ hasApiKey: false })),
      getGitHubIntegrationStatus: vi.fn(async () => githubStatus),
      getRuntimeStatus: vi.fn(async () => ({
        gatewayHealthy: false,
        isPackaged: false,
      })),
      openGitHubConnect,
    },
  });
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={memory.adapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <DashboardPage />
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}

describe("desktop Dashboard gated Connect GitHub CTA (FEA-3280)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopLocalReadReason.mockReturnValue(undefined);
    // Reduced motion → skip the first-launch reveal scan (tick starts at 100)
    // so the ready state renders immediately and deterministically.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useDesktopAuth.mockReturnValue({
      beginSignIn: vi.fn(async () => ({ ok: true })),
      state: { status: "authenticated" },
    });
    hooks.useApiClient.mockReturnValue({ get: vi.fn() });
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);
    stubAnalyticsLoaded();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("fires the desktop connect flow (openGitHubConnect) — not a dead link — when a gated KPI card's CTA is clicked", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    // GitHub disconnected → the merged-PR / KLOC KPIs resolve to Gated and the
    // card renders the connect affordance.
    installDesktopApi(openGitHubConnect, { connected: false });

    renderDashboard();

    // The gated KPI card must render a live "Connect GitHub" CTA button — not
    // an inert in-app <Link> (the dead click this fix removes).
    const ctas = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    expect(ctas).toHaveLength(GATED_DASHBOARD_CTA_COUNT);
    const cta = ctas[0];
    expect(
      screen.queryAllByRole("link", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(0);

    fireEvent.click(cta);

    // The desktop connect flow runs (sign-in already authenticated → straight to
    // the GitHub-App connect IPC).
    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith(
        expect.objectContaining({ returnTo: "/insights" })
      )
    );
  });

  // FEA-3280 regression guard for the RUNTIME dead click (not just the render
  // wiring): the old inline handler read `getGitHubIntegrationStatus` at click
  // time inside a try/catch that swallowed every error and returned SILENTLY —
  // so if that status read threw, the click opened nothing at all. A failing
  // status read must never reach the click path. This test fails
  // (openGitHubConnect never called) against the inline handler.
  it("still opens the connect flow when the GitHub status read rejects (no silent dead click)", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, { connected: false });
    // The failure mode the old inline try/catch swallowed.
    (
      window.desktopApi.getGitHubIntegrationStatus as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("GitHub status unavailable"));

    renderDashboard();

    const [cta] = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    fireEvent.click(cta);

    // Reliability parity with Branches: the connect IPC still fires with a
    // returnTo rather than the click doing nothing.
    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({ returnTo: "/insights" })
    );
    // And the successful open surfaces a VISIBLE Opened banner — the old inline
    // handler produced no visible state on any path (the dead-click symptom).
    expect(await screen.findByText(OPENED_BANNER_RE)).toBeTruthy();
  });

  // ISS-5958 D3 follow-on: a fresh org with no App installation used to send
  // `install: true` from here, dropping the user into the org App-installation
  // flow from a button labelled "Connect GitHub". The CTA is now always a
  // personal authorize, on every surface.
  it("never opens the App-installation flow, even with no App installation", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, {
      connected: false,
      githubDataConnection: {
        connected: false,
        sources: [],
        oauthRequiredReasons: [GitHubOAuthRequiredReason.NoAppInstallation],
      },
    });

    renderDashboard();

    const [installCta] = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    fireEvent.click(installCta);

    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({ returnTo: "/insights" })
    );
  });

  // A connect IPC that fails must surface a VISIBLE state the user can retry
  // from, never a silent no-op. The old inline handler returned silently on
  // `{ ok: false }`; the unified flow renders the shared Failed banner.
  it("surfaces a visible Failed banner (not a silent no-op) when the connect IPC returns not-ok", async () => {
    const openGitHubConnect = vi.fn(async () => ({
      ok: false as const,
      reason: "open_failed" as const,
    }));
    installDesktopApi(openGitHubConnect, { connected: false });

    renderDashboard();

    const [cta] = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    fireEvent.click(cta);

    await waitFor(() => expect(openGitHubConnect).toHaveBeenCalled());
    expect(await screen.findByText(FAILED_BANNER_RE)).toBeTruthy();
  });

  /**
   * ISS-11326: the Dashboard mounts the same `DesktopInsightsProvider` banner
   * Insights does, so it is a third page this one sentence renders on and may not
   * name any of them. What it pins is the WHOLE canonical sentence — the
   * pre-existing `FAILED_BANNER_RE` above matches only the state half, so it
   * stayed green through every wording of the continuation, the wrong one
   * included — and the variant, via the stalled wording's absence.
   */
  it("renders the whole populated-list sentence, naming no page", async () => {
    const openGitHubConnect = vi.fn(async () => ({
      ok: false as const,
      reason: "open_failed" as const,
    }));
    installDesktopApi(openGitHubConnect, { connected: false });

    renderDashboard();

    const [cta] = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    fireEvent.click(cta);

    await waitFor(() => expect(openGitHubConnect).toHaveBeenCalled());
    expect(FAILED_BANNER_MESSAGE.trim().length).toBeGreaterThan(0);
    const rendered =
      (await screen.findByText(FAILED_BANNER_MESSAGE)).textContent ?? "";

    expect(rendered).toContain(FAILED_BANNER_MESSAGE);
    expect(listSurfacePageNounsNamedIn(rendered)).toEqual([]);
    expect(STALLED_LIST_FAILED_MESSAGE).not.toBe(FAILED_BANNER_MESSAGE);
    expect(screen.queryByText(STALLED_LIST_FAILED_MESSAGE)).toBeNull();
  });
});

/**
 * PLN-1694 M3 (item 10) — ISS-5489 FR-5, the auth-method branch.
 *
 * "Signed in with GitHub → GitHub CTAs are absent; GitHub-dependent metrics
 * populate." That claim is a chain, and two of its three links were already
 * proven elsewhere: signing in with GitHub is `oauth_github`, whose user OAuth
 * grant alone answers `connected` with no App installation
 * (`apps/api/app/integrations/github/data-connection-status.test.ts`), and a
 * connected desktop-local source promotes GitHub-truth tiles out of `Gated`
 * (`packages/app/insights/lib/__tests__/tile-availability.test.ts`).
 *
 * The untested link was this surface. Every desktop case above installs
 * `{ connected: false }`, so "the affordance disappears once GitHub is
 * connected" — the actual words of FR-5 — was an assumption about the one
 * screen a returning user lands on.
 *
 * Asserted from the CONNECTED side only, deliberately. FR-5's other half
 * ("signed in without GitHub → CTAs remain as the empty state") is exactly what
 * ISS-5958's interim rule removes — that CTA is to render for unauthenticated
 * users only — so pinning it here would make this test the thing that has to be
 * deleted to ship that issue. The plan's instruction was to reconcile with that
 * rule rather than encode a second policy, and the disconnected half is already
 * held at the tile level by the availability suite above, which is where it
 * belongs: whether a gated metric may invent a value does not depend on which
 * affordance sits in the hole.
 */
describe("GitHub auth branching on the desktop Dashboard (ISS-5489 FR-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopLocalReadReason.mockReturnValue(undefined);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useDesktopAuth.mockReturnValue({
      beginSignIn: vi.fn(async () => ({ ok: true })),
      state: { status: DesktopAuthStatus.Authenticated },
    });
    hooks.useApiClient.mockReturnValue({ get: vi.fn() });
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);
    stubAnalyticsLoaded();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("drops every Connect GitHub affordance once the grant makes GitHub connected", async () => {
    // The exact shape a GitHub sign-in produces, and the reason this case is
    // worth a test rather than a glance: there is no App installation, so the
    // LEGACY `connected` field is false. Only the additive data-connection
    // predicate says the grant can serve GitHub data — which is what
    // `resolveGitHubDataConnected` prefers, and what ISS-5958 v3 had to correct
    // an earlier draft about. A surface still reading the legacy field would
    // show a returning GitHub user the connect ask they just satisfied.
    installDesktopApi(
      vi.fn(async () => ({ ok: true })),
      {
        connected: false,
        githubDataConnection: {
          connected: true,
          oauthRequiredReasons: [],
          sources: [GitHubDataConnectionSource.UserOAuth],
        },
      }
    );

    renderDashboard();

    // Wait on something the READY dashboard renders, so this cannot pass by
    // asserting an absence against a page that had not rendered yet — which is
    // how a test like this quietly stops testing anything.
    await screen.findByText(READY_DASHBOARD_RE);

    expect(
      screen.queryAllByRole("button", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(0);
    expect(
      screen.queryAllByRole("link", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(0);
    // Not just the control: no gated affordance in any variant. The sentence
    // never appears on a card after ISS-7866, so this also catches a page-shell
    // or banner variant leaking onto a connected dashboard.
    expect(screen.queryByText(GATED_EXPLANATION, { exact: false })).toBeNull();
  });

  it("is gated by the connection, not by the harness — the same mount shows it disconnected", async () => {
    // The counterweight. Without it the assertion above would pass just as well
    // against a dashboard that never rendered the affordance at all, under any
    // connection state.
    installDesktopApi(
      vi.fn(async () => ({ ok: true })),
      { connected: false }
    );

    renderDashboard();

    await screen.findByText(READY_DASHBOARD_RE);
    // ISS-7866: the counterweight is the CONTROL, not the sentence — a gated
    // card carries the verb alone now, so asserting the explanation here would
    // assert something the card no longer renders in any connection state.
    expect(
      await screen.findAllByRole("button", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(GATED_DASHBOARD_CTA_COUNT);
  });
});

/**
 * PLN-1600 Step E — verification, not construction.
 *
 * FEA-3280 already ships the whole gated-CTA mechanism, and its own suite in
 * this file proves it. What none of those cases covers is a SETTLED signed-out
 * device: every existing case runs authenticated, so "the CTA still works for a
 * guest" was an assumption rather than a result. Since ISS-7995 the auth state
 * is the whole of guest mode, so that is what every assertion below turns on.
 *
 * The risk being closed is specific. Under the old blocking overlay a
 * signed-out device never saw these tiles, so nothing downstream of the gate had
 * to hold up for one; Step D then added an Organization gate that replaces the
 * dashboard body outright. If either had swallowed the connect affordance, the
 * first signed-out user to hit the flag would have found a Connect GitHub button
 * that was gone, or dead.
 */
describe("gated Connect GitHub CTA under guest mode (PLN-1600 Step E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    // A SETTLED signed-out device: the one auth state `canOfferAccount` treats
    // as a guest. `beginSignIn` is what the connect flow runs first when the
    // device is not authenticated.
    hooks.useDesktopAuth.mockReturnValue({
      beginSignIn: vi.fn(async () => ({ ok: true })),
      cancelSignIn: vi.fn(async () => undefined),
      state: { status: DesktopAuthStatus.SignedOut },
    });
    hooks.useApiClient.mockReturnValue({ get: vi.fn() });
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);
    stubAnalyticsLoaded();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("still renders and fires the connect flow for a signed-out guest", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, { connected: false });

    renderDashboard();

    const ctas = await screen.findAllByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    expect(ctas).toHaveLength(GATED_DASHBOARD_CTA_COUNT);
    const cta = ctas[0];
    expect(
      screen.queryAllByRole("link", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(0);
    // The retired signed-out verb must be absent (ISS-7866 reversing ISS-5958
    // D1): a signed-out reader now meets the SAME verb as a signed-in one, so a
    // reintroduced "Sign up with GitHub" would put two words on one wall again.
    expect(
      screen.queryAllByRole("button", { name: SIGN_UP_GITHUB_RE })
    ).toHaveLength(0);

    fireEvent.click(cta);

    // Signed out, so the flow signs in FIRST — holding the browser's account
    // for the user to confirm (ISS-11345) — and then opens the connect. The
    // assertion is on the connect landing, because a flow that stopped after
    // sign-in would look identical up to that point.
    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith(
        expect.objectContaining({ returnTo: "/insights" })
      )
    );
    expect(
      hooks.useDesktopAuth.mock.results[0]?.value.beginSignIn
    ).toHaveBeenCalledWith(undefined, undefined, undefined, {
      confirmAccount: true,
    });
  });

  it("does not let the guest sign-up chrome displace the connect affordance", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, { connected: false });

    renderDashboard();

    // ISS-10942 moved the guest account offer off this page and into the
    // sidebar's Getting started module, so the dashboard's own guest chrome is
    // no longer what stands beside the GitHub ask. The ask itself is unchanged.
    expect(
      await screen.findAllByRole("button", { name: CONNECT_GITHUB_RE })
    ).toHaveLength(GATED_DASHBOARD_CTA_COUNT);
    // And the retired signed-out verb stays gone: this is the one screen where
    // a "Sign up with GitHub" control would look most at home, and therefore
    // the most likely place for the ISS-5958 D1 split to creep back in.
    expect(
      screen.queryAllByRole("button", { name: SIGN_UP_GITHUB_RE })
    ).toHaveLength(0);
  });
});
