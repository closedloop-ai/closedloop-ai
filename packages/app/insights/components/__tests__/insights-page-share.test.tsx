import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeSharedDashboard,
  encodeSharedDashboard,
  SHARE_DASHBOARD_PARAM,
} from "../../lib/share-dashboard";
import { DEFAULT_DASHBOARD_TILE_IDS } from "../../lib/tile-catalog";
import {
  InsightsPage,
  SHARE_DASHBOARD_FEATURE_FLAG_KEY,
} from "../insights-page";

const { dashboardGridProps } = vi.hoisted(() => ({
  dashboardGridProps: {
    current: null as { pins?: { tiles: string[] } } | null,
  },
}));

vi.mock("../dashboard-grid", () => ({
  DashboardGrid: (props: { pins?: { tiles: string[] } }) => {
    dashboardGridProps.current = props;
    return <div data-testid="dashboard-grid" />;
  },
}));

vi.mock("../metric-picker", () => ({
  MetricPicker: () => null,
}));

const STORAGE_NAMESPACE = "share-test";
const STORAGE_KEY = `closedloop:insights-dashboard:v1:${STORAGE_NAMESPACE}`;
const SHARE_BUTTON_NAME = /share/i;
const NAVIGATE_BUTTON_NAME = /navigate/i;

beforeEach(() => {
  localStorage.clear();
  dashboardGridProps.current = null;
  window.history.replaceState({}, "", "/insights");
});

// stubClipboard defines navigator.clipboard, which jsdom does not reset between
// tests; restore it so the patch never leaks into unrelated specs (AGENTS.md
// Test Practices).
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

// jsdom's navigator has no clipboard by default; install a spy for the copy
// path (navigator.share stays absent, so handleShare falls back to clipboard).
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

// Minimal in-provider control to drive same-route navigation through the
// navigation port (the memory adapter) so we can assert the URL-reactive
// clearing of the shared dashboard.
function NavigateButton({ to }: { to: string }) {
  const navigation = useNavigation();
  return (
    <button
      onClick={() => navigation.replace(to, { scroll: false })}
      type="button"
    >
      navigate
    </button>
  );
}

describe("InsightsPage dashboard share", () => {
  it("serializes the customized dashboard into the copied ?dash= link", async () => {
    const writeText = stubClipboard();

    renderPage({ shareDashboardEnabled: true });
    await waitFor(() => expect(dashboardGridProps.current).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: SHARE_BUTTON_NAME }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const shareUrl = new URL(writeText.mock.calls[0][0]);
    const decoded = decodeSharedDashboard(
      shareUrl.searchParams.get(SHARE_DASHBOARD_PARAM)
    );
    expect(decoded?.tiles).toEqual([...DEFAULT_DASHBOARD_TILE_IDS]);
  });

  it("omits the ?dash= param when the emergent flag is off", async () => {
    const writeText = stubClipboard();

    renderPage({ shareDashboardEnabled: false });
    await waitFor(() => expect(dashboardGridProps.current).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: SHARE_BUTTON_NAME }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const shareUrl = new URL(writeText.mock.calls[0][0]);
    expect(shareUrl.searchParams.has(SHARE_DASHBOARD_PARAM)).toBe(false);
  });

  it("hydrates the dashboard from an inbound ?dash= link", async () => {
    const token = encodeSharedDashboard({
      tiles: ["kpi:merged", "chart:prTrend"],
      layout: {},
      settings: {},
    });
    window.history.replaceState(
      {},
      "",
      `/insights?${SHARE_DASHBOARD_PARAM}=${token}`
    );

    renderPage({ shareDashboardEnabled: true });

    await waitFor(() =>
      expect(dashboardGridProps.current?.pins?.tiles).toEqual([
        "kpi:merged",
        "chart:prTrend",
      ])
    );
  });

  it("clears the shared dashboard when same-route navigation drops the ?dash= param", async () => {
    const token = encodeSharedDashboard({
      tiles: ["kpi:merged", "chart:prTrend"],
      layout: {},
      settings: {},
    });
    window.history.replaceState(
      {},
      "",
      `/insights?${SHARE_DASHBOARD_PARAM}=${token}`
    );

    renderPage({ shareDashboardEnabled: true });

    await waitFor(() =>
      expect(dashboardGridProps.current?.pins?.tiles).toEqual([
        "kpi:merged",
        "chart:prTrend",
      ])
    );

    // Same-route navigation back to /insights with no ?dash=: the stale snapshot
    // must clear and the grid fall back to the recipient's default dashboard,
    // rather than staying pinned to the shared snapshot until a full reload.
    fireEvent.click(screen.getByRole("button", { name: NAVIGATE_BUTTON_NAME }));

    await waitFor(() =>
      expect(dashboardGridProps.current?.pins?.tiles).toEqual([
        ...DEFAULT_DASHBOARD_TILE_IDS,
      ])
    );
  });

  it("ignores an inbound ?dash= link while the emergent flag is off", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 7,
        tiles: ["kpi:sessions"],
        layout: {},
        settings: {},
      })
    );
    const token = encodeSharedDashboard({
      tiles: ["kpi:merged"],
      layout: {},
      settings: {},
    });
    window.history.replaceState(
      {},
      "",
      `/insights?${SHARE_DASHBOARD_PARAM}=${token}`
    );

    renderPage({ shareDashboardEnabled: false });

    await waitFor(() => expect(dashboardGridProps.current).not.toBeNull());
    expect(dashboardGridProps.current?.pins?.tiles).toEqual(["kpi:sessions"]);
  });
});

function renderPage({
  shareDashboardEnabled,
}: {
  shareDashboardEnabled: boolean;
}) {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: shareDashboardEnabled
      ? [SHARE_DASHBOARD_FEATURE_FLAG_KEY]
      : [],
  });
  // Seed the memory navigation from the URL the test set via history so the
  // shared-dashboard read (which now goes through the navigation port) sees the
  // inbound ?dash= token, and later navigation stays reactive.
  const navigation = createMemoryNavigation({
    initialPath: `${window.location.pathname}${window.location.search}`,
  });
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      <FeatureFlagAdapterProvider adapter={adapter}>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <InsightsDataSourceProvider value={createSource()}>
            <NavigateButton to="/insights" />
            <InsightsPage storageNamespace={STORAGE_NAMESPACE} />
          </InsightsDataSourceProvider>
        </QueryClientProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function createSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getDelivery: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getUtilization: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getAgents: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
  };
}
