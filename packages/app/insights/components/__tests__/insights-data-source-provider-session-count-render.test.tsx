import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { useUtilizationInsights } from "@repo/app/insights/hooks/use-insights";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import {
  SESSION_COUNT_MODELED_READ,
  SESSION_COUNT_SITE,
} from "@repo/app/shared/counts/session-count-population-reconciliation";
import { SESSION_COUNT_SITE_DECLARING_MODULES } from "@repo/app/shared/counts/session-count-render-site";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_KPI_TILE_COUNT_SITE,
  WebInsightsDataSourceProvider,
} from "../insights-data-source-provider";
import { DashboardRowContent } from "../overview/dashboard-rows";
import { DASHBOARD_ROWS } from "../overview/dashboard-tiles";

/**
 * ISS-10660: the render half of the session-count site guard, for the web
 * dashboard Sessions tile's host.
 *
 * `../../../shared/counts/__tests__/session-count-site-wiring.test.ts` proves
 * this module NAMES `DashboardKpiTileOrg`; only a mount can show the count still
 * REACHES the screen through it. The shared tile renders whatever value it is
 * handed, so what this host owns is the read that hands it one: mount the
 * provider over a stubbed transport, read the Utilization section through the
 * same hook the dashboard uses, hand it to the dashboard's real headline-KPI
 * row, and observe the count inside the rendered Sessions card. A
 * provider that stopped serving `getUtilization`, or served it from another
 * section, draws no number and reddens here — with no JSX element or host
 * symbol named.
 *
 * Org scope on purpose, read from `SESSION_COUNT_MODELED_READ`: it is the scope
 * the registry models for this site, and the request assertion below pins it to
 * `scope=org` on the wire, so the registry's statement and this read cannot
 * drift apart.
 */

const HOST_MODULE =
  "packages/app/insights/components/insights-data-source-provider.tsx";
/** Under 1,000 so no grouping separator, and distinct from every other figure in the row. */
const ORG_SESSION_COUNT = 397;
const PERIOD = "30";

const apiGet = vi.fn(async (path: string) =>
  path.includes("/insights/utilization")
    ? {
        // The Sessions card draws its sparkline from this series.
        charts: { eventActivity: { points: [] } },
        kpis: [
          {
            key: InsightsKpiKey.Sessions,
            label: "Sessions",
            value: ORG_SESSION_COUNT,
            format: KpiFormat.Number,
            sub: "agent sessions run",
            deltaPct: null,
          },
        ],
      }
    : { charts: {}, kpis: [] }
);

// The factory defers to `apiGet` inside a closure, so it is read at render
// time, after this module's top level has run.
vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({ data: { connected: true } }),
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeams: () => ({ data: [] }),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: apiGet }),
}));

const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");

/**
 * Reads the section through the dashboard's own hook and hands it to the
 * dashboard's own headline-KPI row (`DASHBOARD_ROWS`' stats row through
 * `DashboardRowContent`, the path both shells render). The number on screen is
 * drawn by the real Sessions tile, so pulling its catalog entry or its row id
 * reddens here too (review, tamsinb).
 */
function SessionsKpiRow() {
  const utilization = useUtilizationInsights(
    PERIOD,
    SESSION_COUNT_MODELED_READ.orgAggregationScope
  );
  if (!(statsRow && utilization.data)) {
    return null;
  }
  return (
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        gates={{ agentCollaborationNetwork: true }}
        getTileAvailability={undefined}
        heatmap={undefined}
        modelSeries={undefined}
        row={statsRow}
        sections={{ [InsightsSection.Utilization]: utilization.data }}
      />
    </FeatureFlagAdapterProvider>
  );
}

/** The rendered Sessions card: its title's nearest design-system card. */
async function findSessionsCard(): Promise<HTMLElement> {
  const title = await screen.findByText("Sessions");
  const card = title.closest<HTMLElement>('[data-slot="card"]');
  if (!card) {
    throw new Error("the Sessions title rendered outside a card");
  }
  return card;
}

describe("ISS-10660: the web insights host draws the org dashboard Sessions count", () => {
  it("is the module the registry names for the site it declares", () => {
    expect(DASHBOARD_KPI_TILE_COUNT_SITE).toBe(
      SESSION_COUNT_SITE.DashboardKpiTileOrg
    );
    expect(
      SESSION_COUNT_SITE_DECLARING_MODULES[DASHBOARD_KPI_TILE_COUNT_SITE]
    ).toContain(HOST_MODULE);
  });

  it("serves the Utilization Sessions KPI to the tile's read", async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <WebInsightsDataSourceProvider>
          <SessionsKpiRow />
        </WebInsightsDataSourceProvider>
      </QueryClientProvider>
    );

    expect(await findSessionsCard()).toHaveTextContent(
      String(ORG_SESSION_COUNT)
    );
    expect(apiGet).toHaveBeenCalledWith(
      expect.stringContaining("/insights/utilization?period=30&scope=org")
    );
  });
});
