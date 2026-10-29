import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { settingsApiRoutes } from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 31 of 62: Desktop App (Tool page).
// The live Settings page at `/<org>/settings?panel=desktop-app`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Desktop App panel, over the app frame. Each story is one state the
// live page reaches from its reads.
// Desktop App is a desktop-only panel: on the web the link resolves to the
// dialog's unavailable view, which is what this page shows.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Desktop App",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.DesktopApp),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("dialog", {}, { timeout: 10_000 })
    ).toBeVisible();
  },
};
