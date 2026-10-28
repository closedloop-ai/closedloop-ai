import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { mixedAgentSessionListFixtures } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { DASHBOARD_PAGE_TITLE } from "@repo/app/insights/lib/dashboard-header-copy";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import DashboardPage from "@/app/(authenticated)/[orgSlug]/dashboard/page";
import {
  dashboardApiRoutes,
  dashboardUtilizationFixture,
} from "./fixtures/dashboard-fixtures";
import {
  guidedTourSnapshotFixture,
  sessionListResponse,
} from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 1 of 62: Dashboard (Analytics dashboard).
// The live route's own page (`apps/app/.../dashboard/page.tsx`) in the app
// frame, so every element the live dashboard has is here. Each story is one
// state the live page reaches from its API reads; no controls, because the
// page takes no props.

/** `dashboardApiRoutes` with some reads answered differently. */
function withRoutes(overrides: FixtureRoute[]): FixtureRoute[] {
  return [...overrides, ...dashboardApiRoutes];
}

function failing(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => null, status: 500 };
}

const meta = {
  title: "Surfaces/Dashboard",
  tags: ["stable"],
  render: () => (
    <LivePage activePath="/dashboard">
      <DashboardPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: dashboardApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: DASHBOARD_PAGE_TITLE,
      })
    ).toBeVisible();
    await expect(
      await canvas.findByRole("link", { name: "Dashboard" })
    ).toHaveAttribute("data-active", "true");
  },
};

/** A workspace with no synced sessions yet. */
export const Empty: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        {
          method: "GET",
          path: "/insights/utilization",
          respond: () => ({
            ...dashboardUtilizationFixture,
            kpis: dashboardUtilizationFixture.kpis.map((kpi) => ({
              ...kpi,
              value: 0,
              deltaPct: null,
            })),
          }),
        },
        {
          method: "GET",
          path: "/agent-sessions",
          respond: () => sessionListResponse([]),
        },
      ]),
    },
  },
};

/**
 * ISS-11927: sessions exist, but every one predates the selected range (the
 * default 7d). The body is the Sessions list's date-range empty (ISS-11913),
 * reused verbatim, and "Show all time" widens the range to draw the rows.
 */
export const NoMatches: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        {
          method: "GET",
          path: "/insights/utilization",
          // The selected range counts no sessions; all time counts them all.
          respond: ({ searchParams }) =>
            searchParams.get("period") === "all"
              ? dashboardUtilizationFixture
              : {
                  ...dashboardUtilizationFixture,
                  kpis: dashboardUtilizationFixture.kpis.map((kpi) => ({
                    ...kpi,
                    value: 0,
                    deltaPct: null,
                  })),
                },
        },
        {
          method: "GET",
          path: "/agent-sessions",
          // The Recent Sessions read is windowed; the all-time count is not.
          respond: ({ searchParams }) =>
            searchParams.has("startDate")
              ? sessionListResponse([])
              : sessionListResponse(mixedAgentSessionListFixtures),
        },
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No matching sessions")).toBeVisible();
    await expect(canvas.queryByText("No agent sessions yet")).toBeNull();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Show all time" })
    );
    await waitFor(() =>
      expect(canvas.queryByText("No matching sessions")).toBeNull()
    );
  },
};

/** Every Insights read failed. */
export const Unavailable: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        failing("/insights/delivery"),
        failing("/insights/utilization"),
        failing("/insights/agents"),
      ]),
    },
  },
};

/** The Recent Synced Sessions read failed; the rest of the page loaded. */
export const RecentSessionsUnavailable: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([failing("/agent-sessions")]) },
  },
};

/** A new workspace's guided onboarding reaches the dashboard tour. */
export const GuidedTour: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        {
          method: "GET",
          path: "/onboarding/guided/snapshot",
          respond: () =>
            guidedTourSnapshotFixture(OnboardingPhase.DashboardTour),
        },
      ]),
    },
  },
};
