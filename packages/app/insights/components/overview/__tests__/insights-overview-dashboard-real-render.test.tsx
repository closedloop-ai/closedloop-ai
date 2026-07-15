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
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";

const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));

const emptySeries = { points: [], series: [] };
const dashboardStateCases = [
  {
    expectedText: "Recent Sessions",
    label: "populated",
    setup: () => undefined,
    target: () => screen.getByText("Recent Sessions"),
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
    expectedText:
      "Dashboard metrics are temporarily unavailable. Refresh to try again.",
    label: "error",
    setup: () => hooks.useAgentsInsights.mockReturnValue(errored()),
    target: () =>
      screen.getByText(
        "Dashboard metrics are temporarily unavailable. Refresh to try again."
      ),
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

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps real populated dashboard rows and recent sessions clean in %s theme", async (theme) => {
    const { container } = renderDashboard(theme);

    expect(screen.getByText("Recent Sessions")).toBeInTheDocument();
    expect(screen.getByText("Real dashboard session")).toBeInTheDocument();
    expect(hooks.useAgentSessions).toHaveBeenCalledWith({
      limit: 8,
      sortBy: SessionSortKey.LastActivity,
      sortDir: "desc",
      startDate: expect.any(String),
    });

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Recent Sessions"), {
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
    expect(screen.getByText("Real dashboard session").closest("a")).toHaveClass(
      "text-foreground"
    );
  });

  it.each(
    dashboardStateCases
  )("keeps real dashboard $label state critical a11y and contrast clean in both themes", async ({
    expectedText,
    label,
    setup,
    target,
  }) => {
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
  });
});

function renderDashboard(theme: A11yTheme) {
  return render(
    <A11yThemeRoot theme={theme}>
      <InsightsDataSourceProvider value={createInsightsDataSource()}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsOverviewDashboard getSessionHref={() => "/sessions/1"} />
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>
    </A11yThemeRoot>
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
