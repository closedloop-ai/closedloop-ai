import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import InsightsPage from "@/app/(authenticated)/[orgSlug]/insights/page";
import { insightsApiRoutes } from "./fixtures/insights-fixtures";
import { LivePage } from "./live-page";
import { expectActiveNavItem } from "./live-route";

// ISS-11361 Target sidebar, entry 13 of 62: Insights (Analytics dashboard).
// The live route's own page (`apps/app/.../insights/page.tsx`: the
// `labs-nav-section` and Insights route gates and `InsightsPageClient`) in the
// app frame, with both gates on as in the live app. Each story is one state the
// page reaches from its three section reads.

const LIVE_FLAGS = [
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  INSIGHTS_FEATURE_FLAG_KEY,
];

function withRoutes(overrides: FixtureRoute[]) {
  return {
    appCore: {
      apiRoutes: [...overrides, ...insightsApiRoutes],
      enabledFlags: LIVE_FLAGS,
    },
  };
}

const SECTIONS = [
  "/insights/delivery",
  "/insights/utilization",
  "/insights/agents",
];

const meta = {
  title: "Surfaces/Labs/Insights",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/insights">
      <InsightsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: insightsApiRoutes, enabledFlags: LIVE_FLAGS },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expectActiveNavItem(canvas, "Insights");
  },
};

/** The section reads are still in flight. */
export const Loading: Story = {
  parameters: withRoutes(
    SECTIONS.map((path) => ({
      method: "GET",
      path,
      respond: () => new Promise(() => undefined),
    }))
  ),
};

/** Every section read failed. */
export const Unavailable: Story = {
  parameters: withRoutes(
    SECTIONS.map((path) => ({
      method: "GET",
      path,
      respond: () => null,
      status: 500,
    }))
  ),
};
