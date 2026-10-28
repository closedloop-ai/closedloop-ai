import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import {
  settingsApiRoutes,
  withSettingsRoutes,
} from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 28 of 62: Compliance (Tool page).
// The live Settings page at `/<org>/settings?panel=compliance`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Compliance panel, over the app frame. Each story is one state the
// live page reaches from its reads.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Compliance",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.Compliance),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.Compliance);
  },
};

/** Every distributed component is installed and in use. */
export const NoGaps: Story = {
  parameters: {
    appCore: {
      apiRoutes: withSettingsRoutes([
        {
          method: "GET",
          path: "/agent-components/compliance",
          respond: () => ({ items: [], total: 0 }),
        },
      ]),
    },
  },
};
