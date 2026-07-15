import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TileDescriptor } from "../../lib/tile-catalog";
import { getTile } from "../../lib/tile-catalog";
import { InsightsPage } from "../insights-page";

const { dashboardGridProps } = vi.hoisted(() => ({
  dashboardGridProps: {
    current: null as {
      getTileAvailability?: (tile: TileDescriptor) => { state: BranchKpiState };
    } | null,
  },
}));

vi.mock("../dashboard-grid", () => ({
  DashboardGrid: (props: {
    getTileAvailability?: (tile: TileDescriptor) => { state: BranchKpiState };
  }) => {
    dashboardGridProps.current = props;
    return <div data-testid="dashboard-grid" />;
  },
}));

vi.mock("../metric-picker", () => ({
  MetricPicker: () => null,
}));

vi.mock("../../hooks/use-dashboard-pins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-dashboard-pins")>()),
  useDashboardPins: () => ({
    getTileSettings: vi.fn(),
    isPinned: vi.fn(),
    layout: {},
    pinTile: vi.fn(),
    replaceTile: vi.fn(),
    settings: {},
    tiles: ["kpi:merged"],
    unpinTile: vi.fn(),
  }),
}));

const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const CONNECT_GITHUB_BUTTON_NAME = /connect github/i;

describe("InsightsPage team scope", () => {
  beforeEach(() => {
    dashboardGridProps.current = null;
  });

  it("passes the selected team id through the rendered page data path", async () => {
    const source = createSource();

    renderInsightsPage(source);

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_ID
      )
    );
  });

  it("fails closed for old sources that omit availability support", async () => {
    const source = createSource({
      availableScopes: [InsightsScope.Org],
    });

    renderInsightsPage(source);

    await waitFor(() => expect(source.getDelivery).toHaveBeenCalled());

    const tile = getTile("kpi:merged");
    if (!tile) {
      throw new Error("Expected merged Insights tile to exist");
    }
    expect(dashboardGridProps.current?.getTileAvailability?.(tile)).toEqual({
      state: BranchKpiState.Unavailable,
    });
  });

  it("renders the Delivery section banner when a visible Delivery tile is gated", async () => {
    const onConnectGitHub = vi.fn();
    const source = createSource({
      availableScopes: [InsightsScope.Org],
      getTileAvailability: vi.fn().mockReturnValue({
        state: BranchKpiState.Gated,
      }),
      onConnectGitHub,
    });

    renderInsightsPage(source);

    expect(
      await screen.findByText("Delivery GitHub metrics need a connection")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME })
    );

    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
  });
});

function renderInsightsPage(source: InsightsDataSource) {
  return render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/insights" }).adapter}
    >
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <QueryClientProvider client={createQueryClient()}>
          <InsightsDataSourceProvider value={source}>
            <InsightsPage storageNamespace="test" />
          </InsightsDataSourceProvider>
        </QueryClientProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function createSource(
  overrides: Partial<InsightsDataSource> = {}
): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Team],
    availableSections: [InsightsSection.Delivery],
    availableTeams: [{ id: TEAM_ID, name: "Platform" }],
    getDelivery: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getUtilization: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getAgents: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    ...overrides,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}
