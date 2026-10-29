import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionSortKey } from "@repo/app/agents/lib/session-sort-group";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  ContrastThreshold,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";
import { WEB_RECENT_SESSIONS_TITLE } from "../recent-sessions-copy";
import { withDashboardQueryClient } from "./dashboard-query-client";

const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

// `importOriginal` so every OTHER export of this module — `insightsKeys` and
// the scoped-retry hook the dashboard calls — survives the mock. A factory that
// enumerates only the three section hooks replaces the module wholesale, so the
// next export added there breaks this file with a mock error that says nothing
// about the change that caused it (ISS-10486 review).
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/app/insights/hooks/use-insights")
  >()),
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));

const emptySeries = { points: [], series: [] };
/** ISS-10486: the row-scale degraded sentence, whichever row it names. */
const ROW_DEGRADED_RE = /is temporarily unavailable\.$/;

const dashboardStateCases = [
  {
    expectedText: WEB_RECENT_SESSIONS_TITLE,
    label: "populated",
    setup: () => undefined,
    target: () => screen.getByText(WEB_RECENT_SESSIONS_TITLE),
  },
  {
    expectedText: "No agent sessions yet",
    label: "empty",
    setup: () =>
      hooks.useAgentSessions.mockReturnValue(
        succeeded({ items: [], total: 0 })
      ),
    target: () => screen.getByText("No agent sessions yet"),
  },
  {
    // ISS-10486: all three, because the page-level treatment is now reached only
    // when every section failed. One failed section is the row case below.
    expectedText:
      "Dashboard metrics are temporarily unavailable. Refresh to try again.",
    label: "error",
    setup: () => {
      hooks.useAgentsInsights.mockReturnValue(errored());
      hooks.useDeliveryInsights.mockReturnValue(errored());
      hooks.useUtilizationInsights.mockReturnValue(errored());
    },
    target: () =>
      screen.getByText(
        "Dashboard metrics are temporarily unavailable. Refresh to try again."
      ),
  },
  {
    // ISS-10486: the row-scale degraded treatment, drawn beside rows that still
    // hold their data. `expectedText` is null because several rows read the
    // failed section and each draws its own card.
    expectedText: null,
    label: "row degraded",
    setup: () => hooks.useAgentsInsights.mockReturnValue(errored()),
    target: () => screen.getAllByText(ROW_DEGRADED_RE)[0],
  },
  {
    expectedText: null,
    label: "loading",
    setup: () => hooks.useDeliveryInsights.mockReturnValue(pending()),
    target: () => document.querySelector('[data-slot="skeleton"]'),
  },
] as const;

describe("InsightsOverviewDashboard real a11y render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    hooks.useDeliveryInsights.mockReturnValue(
      succeeded({
        kpis: [],
        charts: { klocTrend: emptySeries, prTrend: emptySeries },
      })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      succeeded({ kpis: [], charts: { eventActivity: emptySeries } })
    );
    hooks.useAgentsInsights.mockReturnValue(
      succeeded({
        kpis: [],
        charts: { modelBreakdown: [], modelUsageOverTime: emptySeries },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      succeeded({
        items: [
          createAgentSessionListItemFixture({
            id: "session-real-render",
            name: "Real dashboard session",
          }),
        ],
        total: 1,
      })
    );
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps real populated dashboard rows and recent sessions clean in %s theme",
    async (theme) => {
      const { container } = renderDashboard(theme);

      expect(screen.getByText(WEB_RECENT_SESSIONS_TITLE)).toBeInTheDocument();
      expect(screen.getByText("Real dashboard session")).toBeInTheDocument();
      expect(hooks.useAgentSessions).toHaveBeenCalledWith(
        {
          limit: 8,
          sortBy: SessionSortKey.LastActivity,
          sortDir: "desc",
          startDate: expect.any(String),
          // FEA-3534: default Me scope threads viewerScope=self into the Recent
          // Sessions read so the card stays scoped to the authenticated user.
          viewerScope: AgentSessionViewerScope.Self,
        },
        // ISS-7514: this tree mounts a static flag adapter with the deferral gate
        // closed, so the read is issued on mount exactly as before.
        { enabled: true }
      );

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText(WEB_RECENT_SESSIONS_TITLE), {
        background: themeBackground(theme),
        label: `real dashboard recent sessions ${theme}`,
      });
      expectElementContrast(getDashboardTourText("stats", "Sessions"), {
        background: themeBackground(theme),
        label: `real dashboard metric label ${theme}`,
      });
      expectElementContrast(getDashboardTourText("prs", "PR throughput"), {
        background: themeBackground(theme),
        label: `real dashboard chart title ${theme}`,
      });
      expect(
        screen.getByText("Real dashboard session").closest("a")
      ).toHaveClass("text-foreground");
    }
  );

  it.each(dashboardStateCases)(
    "keeps real dashboard $label state critical a11y and contrast clean in both themes",
    async ({ expectedText, label, setup, target }) => {
      for (const theme of [A11yTheme.Light, A11yTheme.Dark]) {
        setup();

        const { container, unmount } = renderDashboard(theme);
        if (expectedText) {
          expect(screen.getByText(expectedText)).toBeInTheDocument();
        }

        const targetElement = target();
        expect(targetElement).toBeInstanceOf(Element);
        await expectCriticalAxeClean(container);
        expectElementContrast(targetElement as Element, {
          background: themeBackground(theme),
          label: `real dashboard ${label} ${theme}`,
          threshold:
            label === "loading"
              ? ContrastThreshold.NonText
              : ContrastThreshold.NormalText,
        });
        unmount();
      }
    }
  );
});

function renderDashboard(theme: A11yTheme) {
  // FEA-4051: dashboard rows now render navigation-port `Link` anchors, which
  // read the nav adapter through `useNavigationAdapter`. Mount the in-memory
  // adapter (mirrors production, where the shell always provides one) so the
  // rows resolve instead of throwing "requires a <NavigationProvider>".
  return render(
    withDashboardQueryClient(
      <A11yThemeRoot theme={theme}>
        <InsightsDataSourceProvider value={createInsightsDataSource()}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
          >
            <NavigationProvider
              adapter={
                createMemoryNavigation({ initialPath: "/dashboard" }).adapter
              }
            >
              <InsightsOverviewDashboard
                emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
                getSessionHref={() => "/sessions/1"}
              />
            </NavigationProvider>
          </FeatureFlagAdapterProvider>
        </InsightsDataSourceProvider>
      </A11yThemeRoot>
    )
  );
}

function getDashboardTourText(tour: string, text: string) {
  const tourRoot = document.querySelector(`[data-tour="${tour}"]`);
  if (!(tourRoot instanceof HTMLElement)) {
    throw new Error(`Missing dashboard tour root: ${tour}`);
  }
  return within(tourRoot).getByText(text);
}

function succeeded(data: unknown) {
  return {
    // ISS-10414: settled AND answering for the key that was asked for.
    isPlaceholderData: false,
    data,
    isError: false,
    isLoading: false,
    isSuccess: true,
  };
}

function pending() {
  return {
    data: undefined,
    isError: false,
    isLoading: true,
    isSuccess: false,
  };
}

function errored() {
  return {
    data: undefined,
    isError: true,
    isLoading: false,
    isSuccess: false,
  };
}

function createInsightsDataSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getTileAvailability: () => ({ state: BranchKpiState.Available }),
    getDelivery: () => Promise.reject(new Error("mocked by hook")),
    getUtilization: () => Promise.reject(new Error("mocked by hook")),
    getAgents: () => Promise.reject(new Error("mocked by hook")),
  };
}

/**
 * ISS-11261: the host-supplied empty-state sentence, on the REAL component.
 *
 * The web route's own suite mocks this component wholesale, so its stub renders
 * `emptyStateDescription` itself and the production line that consumes the prop
 * is never executed there. This case is the only thing that executes it.
 */
describe("InsightsOverviewDashboard empty-state description (ISS-11261)", () => {
  const HOST_SENTENCE = "Install Closedloop desktop to see your sessions here.";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    hooks.useDeliveryInsights.mockReturnValue(
      succeeded({
        kpis: [],
        charts: { klocTrend: emptySeries, prTrend: emptySeries },
      })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      succeeded({ kpis: [], charts: { eventActivity: emptySeries } })
    );
    hooks.useAgentsInsights.mockReturnValue(
      succeeded({ kpis: [], charts: { modelCostTrend: emptySeries } })
    );
    hooks.useAgentSessions.mockReturnValue(succeeded({ items: [], total: 0 }));
  });

  it("renders the host's sentence", () => {
    renderEmptyDashboard(HOST_SENTENCE);

    expect(screen.getByText(HOST_SENTENCE)).toBeDefined();
  });
});

/** The dashboard in its empty branch, with whatever sentence the host supplies. */
function renderEmptyDashboard(emptyStateDescription: string) {
  return render(
    withDashboardQueryClient(
      <InsightsDataSourceProvider value={createInsightsDataSource()}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <NavigationProvider
            adapter={
              createMemoryNavigation({ initialPath: "/dashboard" }).adapter
            }
          >
            <InsightsOverviewDashboard
              emptyStateDescription={emptyStateDescription}
              getSessionHref={() => "/sessions/1"}
            />
          </NavigationProvider>
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>
    )
  );
}
