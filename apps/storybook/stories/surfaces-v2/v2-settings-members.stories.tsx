import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { settingsApiRoutes } from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 25 of 62: Members (Tool page).
// The live Settings page at `/<org>/settings?panel=members`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Members panel, over the app frame. Each story is one state the
// live page reaches from its reads.
// The member list and invitations are Clerk's hosted OrganizationProfile,
// which Storybook's Clerk stand-in renders as a labelled region.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Members",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.Members),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.Members);
  },
};
