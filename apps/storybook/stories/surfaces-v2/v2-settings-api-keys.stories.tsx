import { SettingsActorRole } from "@repo/api/src/types/settings-actor-role";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import {
  settingsApiRoutes,
  settingsRoutes,
} from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 29 of 62: API Keys (Tool page).
// The live Settings page at `/<org>/settings?panel=api-keys`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the API Keys panel, over the app frame. Each story is one state the
// live page reaches from its reads.
// The Pensero card is behind a flag that is off by default, so it is not shown.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/API Keys",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.ApiKeys),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.ApiKeys);
  },
};

/** A member: the admin-only controls are not offered. */
export const Member: Story = {
  parameters: {
    appCore: { apiRoutes: settingsRoutes(SettingsActorRole.Member) },
  },
};
