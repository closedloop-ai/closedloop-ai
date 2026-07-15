import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { insightsKeys, useDeliveryInsights } from "../use-insights";

const TEAM_A = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const TEAM_B = "019f0fcb-8336-7c4d-9f64-528fb9520c33";

describe("useInsights team scope", () => {
  it("disables team queries until a teamId exists", () => {
    const source = createSource();

    renderHook(
      () =>
        useDeliveryInsights(
          InsightsPeriod.Quarter,
          InsightsScope.Team,
          undefined
        ),
      { wrapper: createWrapper(source) }
    );

    expect(source.getDelivery).not.toHaveBeenCalled();
  });

  it("isolates team cache entries by teamId", async () => {
    const source = createSource();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = createWrapper(source, queryClient);

    const { rerender } = renderHook(
      ({ teamId }) =>
        useDeliveryInsights(InsightsPeriod.Quarter, InsightsScope.Team, teamId),
      {
        initialProps: { teamId: TEAM_A },
        wrapper,
      }
    );

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_A
      )
    );

    rerender({ teamId: TEAM_B });

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_B
      )
    );

    expect(
      queryClient.getQueryData(
        insightsKeys.section(
          "delivery",
          InsightsPeriod.Quarter,
          InsightsScope.Team,
          TEAM_A
        )
      )
    ).toEqual({ charts: {}, kpis: [] });
    expect(
      queryClient.getQueryData(
        insightsKeys.section(
          "delivery",
          InsightsPeriod.Quarter,
          InsightsScope.Team,
          TEAM_B
        )
      )
    ).toEqual({ charts: {}, kpis: [] });
  });
});

function createSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me, InsightsScope.Org, InsightsScope.Team],
    availableSections: [InsightsSection.Delivery],
    getDelivery: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getUtilization: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getAgents: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
  };
}

function createWrapper(
  source: InsightsDataSource,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <InsightsDataSourceProvider value={source}>
        {children}
      </InsightsDataSourceProvider>
    </QueryClientProvider>
  );
}
