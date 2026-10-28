import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import AuthenticatedNotFound from "@/app/(authenticated)/not-found";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";
import { LIVE_ORG_SLUG, withLiveRoute } from "./live-route";

// ISS-11361 Target sidebar, entry 58 of 62: Page Not Found (System state).
// The live 404 boundary of the authenticated segment
// (`apps/app/app/(authenticated)/not-found.tsx`), which renders inside the
// shell's content column with the sidebar intact. The URL is `/routines`, a
// route whose flag is off in production and so reaches this boundary by direct
// URL; no nav item is active because the sidebar has no Routines entry.

const STALE_PATH = "/routines";

const meta = {
  title: "Surfaces/System States/Page Not Found",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath={STALE_PATH}>
      <AuthenticatedNotFound />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: `/${LIVE_ORG_SLUG}${STALE_PATH}` },
    appCore: { apiRoutes: liveAppShellRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeVisible();
    const sidebarLinks = canvasElement.querySelectorAll(
      'a[data-active="true"]'
    );
    await expect(sidebarLinks.length).toBe(0);
  },
};
