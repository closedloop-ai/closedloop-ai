import { KpiFormat } from "@closedloop-ai/loops-api/insights";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import { DASHBOARD_ROWS } from "@repo/app/insights/components/overview/dashboard-tiles";
import { useUtilizationInsights } from "@repo/app/insights/hooks/use-insights";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { SESSION_COUNT_SITE_DECLARING_MODULES } from "@repo/app/shared/counts/session-count-render-site";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  DASHBOARD_KPI_TILE_COUNT_SITE,
  DesktopInsightsProvider,
} from "../desktop-insights-provider";

/**
 * ISS-10660: the render half of the session-count site guard, for the desktop
 * dashboard Sessions tile's host (`DashboardKpiTileThisDevice`).
 *
 * `packages/app/shared/counts/__tests__/session-count-site-wiring.test.ts`
 * proves this module NAMES its site; only a mount can show the count still
 * REACHES the screen through it. The shared tile renders whatever value it is
 * handed, so what this host owns is the read: in Local mode it answers the
 * Utilization section from this machine's store over IPC. This mounts the
 * provider over a stubbed `desktopApi.db.getInsights` that only the Utilization
 * section answers with a Sessions KPI, reads it through the dashboard's own
 * hook, hands it to the dashboard's real headline-KPI row, and observes the
 * count inside the rendered Sessions card. A provider that stopped serving it,
 * or served it from another section, draws nothing and reddens here — with no
 * JSX element or host symbol named.
 */

const HOST_MODULE =
  "apps/desktop/src/renderer/components/insights/desktop-insights-provider.tsx";
/** Under 1,000 so no grouping separator, and distinct from every other figure in the row. */
const LOCAL_SESSION_COUNT = 412;
const PERIOD = "30";

const { useDesktopAppCoreModeMock } = vi.hoisted(() => ({
  useDesktopAppCoreModeMock: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: vi.fn(async () => ({ ok: true })),
    state: { status: "signed_out" },
  }),
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: useDesktopAppCoreModeMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: vi.fn(async () => ({ charts: {}, kpis: [] })) }),
}));

const getInsights = vi.fn(async (section: string) =>
  section === InsightsSection.Utilization
    ? {
        // The Sessions card draws its sparkline from this series.
        charts: { eventActivity: { points: [] } },
        kpis: [
          {
            key: InsightsKpiKey.Sessions,
            label: "Sessions",
            value: LOCAL_SESSION_COUNT,
            format: KpiFormat.Number,
            sub: "agent sessions run",
            deltaPct: null,
          },
        ],
      }
    : { charts: {}, kpis: [] }
);

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");

/**
 * Reads the section through the dashboard's own hook and hands it to the
 * dashboard's own headline-KPI row (`DASHBOARD_ROWS`' stats row through
 * `DashboardRowContent`, the path both shells render). The number on screen is
 * drawn by the real Sessions tile, so pulling its catalog entry or its row id
 * reddens here too (review, tamsinb).
 */
function SessionsKpiRow() {
  const utilization = useUtilizationInsights(PERIOD, InsightsScope.Me);
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

describe("ISS-10660: the desktop insights host draws the this-device dashboard Sessions count", () => {
  it("is the module the registry names for the site it declares", () => {
    expect(DASHBOARD_KPI_TILE_COUNT_SITE).toBe(
      SESSION_COUNT_SITE.DashboardKpiTileThisDevice
    );
    expect(
      SESSION_COUNT_SITE_DECLARING_MODULES[DASHBOARD_KPI_TILE_COUNT_SITE]
    ).toContain(HOST_MODULE);
  });

  it("serves this machine's Utilization Sessions KPI to the tile's read", async () => {
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        db: { getInsights },
        getGitHubIntegrationStatus: vi.fn(async () => null),
        openGitHubConnect: vi.fn(async () => ({ ok: true })),
      },
    });

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <DesktopInsightsProvider>
          <SessionsKpiRow />
        </DesktopInsightsProvider>
      </QueryClientProvider>
    );

    expect((await findSessionsCard()).textContent).toContain(
      String(LOCAL_SESSION_COUNT)
    );
  });
});
