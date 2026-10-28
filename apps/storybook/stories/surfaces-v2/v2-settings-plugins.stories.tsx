import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { settingsApiRoutes } from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 23 of 62: Plugins (Tool page).
// The live Settings page at `/<org>/settings?panel=plugins`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Plugins panel, over the app frame. Each story is one state the
// live page reaches from its reads.
// The Google Drive and Pensero cards are behind flags that are off by default,
// so they are not shown.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Plugins",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.Plugins),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.Plugins);
  },
};
