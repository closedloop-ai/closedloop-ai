import { SettingsActorRole } from "@repo/api/src/types/settings-actor-role";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import {
  settingsApiRoutes,
  settingsRoutes,
  withSettingsRoutes,
} from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 26 of 62: Custom Fields (Tool page).
// The live Settings page at `/<org>/settings?panel=custom-fields`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Custom Fields panel, over the app frame. Each story is one state the
// live page reaches from its reads.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Custom Fields",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.CustomFields),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.CustomFields);
  },
};

/** No custom fields defined yet. */
export const Empty: Story = {
  parameters: {
    appCore: {
      apiRoutes: withSettingsRoutes([
        { method: "GET", path: "/custom-fields", respond: () => [] },
      ]),
    },
  },
};

/** A member: the admin-only controls are not offered. */
export const Member: Story = {
  parameters: {
    appCore: { apiRoutes: settingsRoutes(SettingsActorRole.Member) },
  },
};
