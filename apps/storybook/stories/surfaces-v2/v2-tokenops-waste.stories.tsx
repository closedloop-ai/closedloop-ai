import { TokenOpsWidget } from "@repo/api/src/types/session-analytics";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import Page from "@/app/(authenticated)/[orgSlug]/insights/tokenops-waste/page";
import {
  tokenOpsWasteApiRoutes,
  tokenOpsWasteFixture,
} from "./fixtures/session-analytics-fixtures";
import { LivePage } from "./live-page";
import { expectActiveNavItem } from "./live-route";

// ISS-11361 Target sidebar, entry 15 of 62: TokenOps waste (Analytics dashboard).
// The live route's own page (`apps/app/...//insights/tokenops-waste/page.tsx`: the
// `labs-nav-section` route gate and its page client) in the app frame. Each
// story is one state the page reaches from `GET /insights/tokenops-waste`.

const LIVE_FLAGS = [LABS_NAV_SECTION_FEATURE_FLAG_KEY];

function answering(route: Omit<FixtureRoute, "method" | "path">) {
  return {
    appCore: {
      apiRoutes: [
        { method: "GET", path: "/insights/tokenops-waste", ...route },
        ...tokenOpsWasteApiRoutes,
      ],
      enabledFlags: LIVE_FLAGS,
    },
  };
}

const meta = {
  title: "Surfaces/Labs/TokenOps waste",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/insights/tokenops-waste">
      <Page />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: tokenOpsWasteApiRoutes, enabledFlags: LIVE_FLAGS },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expectActiveNavItem(canvas, "TokenOps waste");
  },
};

/** The rollup read is still in flight. */
export const Loading: Story = {
  parameters: answering({ respond: () => new Promise(() => undefined) }),
};

/** The rollup read failed, so every widget settles unavailable. */
export const Unavailable: Story = {
  parameters: answering({ respond: () => null, status: 500 }),
};

/** The producer could not compute some widgets; the rest render. */
export const PartiallyUnavailable: Story = {
  parameters: answering({
    respond: () => ({
      ...tokenOpsWasteFixture,
      unavailableWidgets: [TokenOpsWidget.Models],
    }),
  }),
};
