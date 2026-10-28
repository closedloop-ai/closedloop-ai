import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import JudgeDetailPage from "@/app/(authenticated)/[orgSlug]/judges-analytics/[metricName]/page";
import {
  JUDGE_PROMPT,
  judgeDetailFixture,
  judgesApiRoutes,
} from "./fixtures/judges-fixtures";
import { LivePage } from "./live-page";
import { LiveRoute } from "./live-route";

// ISS-11361 Target sidebar: Judge Detail (not in the live app's sidebar).
// The route's own page (`apps/app/.../judges-analytics/[metricName]/page.tsx`)
// at `/judges-analytics/plan-completeness`, in the app frame, with its
// `labs-nav-section` body gate on. Each story is one state the page reaches
// from its judge and score reads.

function answering(route: Omit<FixtureRoute, "method" | "path">) {
  return {
    appCore: {
      apiRoutes: [
        { method: "GET", path: "/judges-analytics/*", ...route },
        ...judgesApiRoutes,
      ],
      enabledFlags: [LABS_NAV_SECTION_FEATURE_FLAG_KEY],
    },
  };
}

const meta = {
  title: "Surfaces/Not In The Live App/Judges/Judge Detail",
  tags: ["experimental"],
  render: () => (
    <LiveRoute
      params={{ metricName: JUDGE_PROMPT }}
      path={`/judges-analytics/${JUDGE_PROMPT}`}
    >
      <LivePage activePath="/judges-analytics">
        <JudgeDetailPage />
      </LivePage>
    </LiveRoute>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: judgesApiRoutes,
      enabledFlags: [LABS_NAV_SECTION_FEATURE_FLAG_KEY],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (await canvas.findAllByText(judgeDetailFixture.judge.displayName)).length
    ).toBeGreaterThan(0);
  },
};

/** The judge read is still in flight. */
export const Loading: Story = {
  parameters: answering({ respond: () => new Promise(() => undefined) }),
};

/** No judge answers to this route. */
export const NotFound: Story = {
  parameters: answering({ respond: () => null, status: 404 }),
};
