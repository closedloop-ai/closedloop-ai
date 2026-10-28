import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ActivityPanel } from "../../../desktop/src/renderer/components/activity/ActivityPanel";
import { pageTitleForNav } from "../../../desktop/src/renderer/navigation/nav-config";
import { NavId } from "../../../desktop/src/renderer/navigation/route-table";
import { activityEventsFixture } from "./test/desktop-only-fixtures";
import { DesktopPage, expectActiveDesktopNavItem } from "./test/desktop-page";

// ISS-11361 Target sidebar: Requests (Desktop only).
// The desktop app's Requests page (`activity/ActivityPanel`, rendered by
// `App.tsx` for `#/requests`) in the desktop shell's own frame: the gateway
// request log (`desktopApi.getActivityEvents`). The live-refresh flag is off
// by default, so the read-failure states it adds are not shown.

type RequestsData = {
  events: () => Promise<unknown[]>;
};

const POPULATED: RequestsData = {
  events: () => Promise.resolve(activityEventsFixture),
};

function requestsBridge({ events }: RequestsData) {
  return {
    getActivityEvents: events,
    clearActivityEvents: () => Promise.resolve(),
  };
}

const meta = {
  title: "Surfaces/Desktop Only/Requests",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <DesktopPage
      bridge={requestsBridge(
        (parameters.requests as RequestsData | undefined) ?? POPULATED
      )}
      navId={NavId.Requests}
    >
      <ActivityPanel />
    </DesktopPage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
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
        name: pageTitleForNav(NavId.Requests),
      })
    ).toBeVisible();
    await expectActiveDesktopNavItem(
      canvasElement,
      pageTitleForNav(NavId.Requests)
    );
  },
};

/** The first read is still in flight. */
export const Loading: Story = {
  parameters: {
    requests: {
      ...POPULATED,
      events: () =>
        new Promise<never>(() => {
          // Never settles.
        }),
    },
  },
};

/** No requests logged. */
export const Empty: Story = {
  parameters: {
    requests: { events: () => Promise.resolve([]) },
  },
};
