import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ArtifactListLayout } from "../patterns-v2/artifact-list-layout";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";

// ISS-12171: Plans List. The live app has no Implementation Plans list (plans
// are listed inside Project Detail and My Tasks). A page with no new version
// shows its pattern instead of a complete page until one is built (Nerys,
// 2026-10-14), so this is Patterns/Other Pages/Implementation
// Plans/Plans List in the app frame.

const meta = {
  title: "Surfaces/Other Pages/Implementation Plans/Plans List",
  tags: ["stable"],
  render: () => (
    <LivePage activePath="/implementation-plans">
      <ArtifactListLayout className="h-full" />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: liveAppShellRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The list layout's regions, in the app frame. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByTestId("page-header")).toBeVisible();
    await expect(canvas.getByTestId("toolbar-region-expanded")).toBeVisible();
    await expect(canvas.getByTestId("rows-region-expanded")).toBeVisible();
  },
};
