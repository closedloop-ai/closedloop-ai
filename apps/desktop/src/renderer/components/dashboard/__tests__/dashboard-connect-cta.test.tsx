import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../../../feature-flags/desktop-feature-flag-provider";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
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
  useDesktopCloudReadCutover: vi.fn(),
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
  useDashboardSessionSource: () => ({ ready: true, unavailable: false }),
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
  useDesktopCloudReadCutover: hooks.useDesktopCloudReadCutover,
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

const CONNECT_GITHUB_RE = /connect github/i;
const OPENED_BANNER_RE = /Continue in the browser to connect GitHub/i;
const FAILED_BANNER_RE = /GitHub connect could not be opened/i;

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
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { eventActivity: { points: [] } } })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { modelBreakdown: [] } })
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
  githubStatus: GitHubIntegrationStatus | null = { connected: false },
  guestOnboarding = false
) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: vi.fn(async () => ({ charts: {}, kpis: [] })),
      },
      getApiKeyStatus: vi.fn(async () => ({ hasApiKey: false })),
      getGitHubIntegrationStatus: vi.fn(async () => githubStatus),
      // `isPackaged: false` is what puts the provider in unpackaged mode; a
      // packaged build disables every Labs flag regardless of the payload below.
      getRuntimeStatus: vi.fn(async () => ({
        gatewayHealthy: false,
        isPackaged: false,
      })),
      // `{ flags: [{ key, value }] }`, NOT a flat record — `readDesktopFlags`
      // ignores any other shape and falls back to the registry defaults, which
      // for a default-off flag is silently indistinguishable from "off".
      getAllFlags: vi.fn(async () => ({
        flags: [
          {
            key: DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY,
            value: guestOnboarding,
          },
        ],
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

/**
 * The same dashboard under GUEST mode, with the REAL
 * `DesktopFeatureFlagProvider` rather than the static adapter above.
 *
 * The real provider is what makes this test mean anything. `useGuestOnboarding`
 * needs BOTH the flag and `useDesktopFeatureFlagsResolved`, and the latter
 * defaults to `false` with no provider (ISS-5037) — so a static adapter alone
 * would leave guest mode OFF while appearing to switch it on, and every
 * assertion below would pass against the signed-in path it is meant to contrast
 * with.
 */
function renderGuestDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={memory.adapter}>
        <DesktopFeatureFlagProvider>
          <DashboardPage />
        </DesktopFeatureFlagProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}

describe("desktop Dashboard gated Connect GitHub CTA (FEA-3280)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopCloudReadCutover.mockReturnValue(drainedCutover());
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
    const cta = await screen.findByRole("button", { name: CONNECT_GITHUB_RE });
    expect(screen.queryByRole("link", { name: CONNECT_GITHUB_RE })).toBeNull();

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
  // wiring): the old inline handler ran an `install`-mode pre-flight
  // (`getGitHubIntegrationStatus` → `resolveGitHubConnectMode`) inside a
  // try/catch that swallowed every error and returned SILENTLY — so if that
  // status read threw, the click opened nothing at all. The unified shared flow
  // treats the pre-flight as best-effort: a rejecting status read must degrade
  // to a plain authorize connect, NOT abort. This test fails (openGitHubConnect
  // never called) against the inline handler and passes after the unification.
  it("still opens the connect flow when the install-mode pre-flight status read rejects (no silent dead click)", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, { connected: false });
    // Make the install-mode pre-flight (getGitHubIntegrationStatus) reject the
    // click-time read — the failure mode the old inline try/catch swallowed.
    (
      window.desktopApi.getGitHubIntegrationStatus as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("GitHub status unavailable"));

    renderDashboard();

    const cta = await screen.findByRole("button", { name: CONNECT_GITHUB_RE });
    fireEvent.click(cta);

    // Reliability parity with Branches: the connect IPC still fires with a
    // returnTo (falling back to authorize, no `install` flag) rather than the
    // click doing nothing.
    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({ returnTo: "/insights" })
    );
    // And the successful open surfaces a VISIBLE Opened banner — the old inline
    // handler produced no visible state on any path (the dead-click symptom).
    expect(await screen.findByText(OPENED_BANNER_RE)).toBeTruthy();
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

    const cta = await screen.findByRole("button", { name: CONNECT_GITHUB_RE });
    fireEvent.click(cta);

    await waitFor(() => expect(openGitHubConnect).toHaveBeenCalled());
    expect(await screen.findByText(FAILED_BANNER_RE)).toBeTruthy();
  });
});

/**
 * PLN-1600 Step E — verification, not construction.
 *
 * FEA-3280 already ships the whole gated-CTA mechanism, and the three tests
 * above prove it. What none of them covers is the combination guest mode
 * creates: the `guest-onboarding` flag ON and a SETTLED signed-out device. Every
 * existing case runs authenticated or flag-off, so "the CTA still works for a
 * guest" was an assumption rather than a result — and guest mode is the only
 * configuration in which a signed-out user reaches this dashboard at all.
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
    installDesktopApi(openGitHubConnect, { connected: false }, true);

    renderGuestDashboard();

    const cta = await screen.findByRole("button", { name: CONNECT_GITHUB_RE });
    expect(screen.queryByRole("link", { name: CONNECT_GITHUB_RE })).toBeNull();

    fireEvent.click(cta);

    // Signed out, so the flow signs in FIRST and then opens the connect. The
    // assertion is on the connect landing, because a flow that stopped after
    // sign-in would look identical up to that point.
    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith(
        expect.objectContaining({ returnTo: "/insights" })
      )
    );
  });

  it("does not let the guest sign-up chrome displace the connect affordance", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi(openGitHubConnect, { connected: false }, true);

    renderGuestDashboard();

    // Guest chrome is actually on — without this the test would pass just as
    // well against a flag that never resolved, which is the exact failure the
    // `{ flags: [...] }` payload shape makes easy to ship.
    expect(
      await screen.findByRole("button", { name: "Create account" })
    ).toBeTruthy();
    // …and the GitHub ask still stands beside it. Two different asks — an
    // account and a provider grant — and connecting GitHub is not signing up.
    expect(
      await screen.findByRole("button", { name: CONNECT_GITHUB_RE })
    ).toBeTruthy();
  });
});
