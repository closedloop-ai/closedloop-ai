import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { settingsApiRoutes } from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 32 of 62: Other Labs Settings (Tool page).
// The live Settings page at `/<org>/settings?panel=other-labs`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Other Labs Settings panel, over the app frame. Each story is one state the
// live page reaches from its reads.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Other Labs Settings",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.OtherLabs),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.OtherLabs);
  },
};
