import { SettingsActorRole } from "@repo/api/src/types/settings-actor-role";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import {
  failingRead,
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

// ISS-11361 Target sidebar, entry 24 of 62: General (Tool page).
// The live Settings page at `/<org>/settings?panel=organization`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the General panel, over the app frame. Each story is one state the
// live page reaches from its reads.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/General",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.OrganizationGeneral),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(
      canvasElement,
      SettingsPanelId.OrganizationGeneral
    );
  },
};

/** The Settings authorization read failed. */
export const ErrorState: Story = {
  name: "Error",
  parameters: {
    appCore: {
      apiRoutes: withSettingsRoutes([failingRead("/settings/view-model")]),
    },
  },
};

/** A member: the organization URL is not editable. */
export const MemberCannotEditUrl: Story = {
  parameters: {
    appCore: { apiRoutes: settingsRoutes(SettingsActorRole.Member) },
  },
};
