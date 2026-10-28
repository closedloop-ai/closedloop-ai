import type { BrowserSessionListResponse } from "@repo/api/src/types/browser-session";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import {
  browserSessionsFixture,
  settingsApiRoutes,
  withSettingsRoutes,
} from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 22 of 62: Connected Devices (Tool page).
// The live Settings page at `/<org>/settings?panel=connected-devices`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Connected Devices panel, over the app frame. Each story is one state the
// live page reaches from its reads.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Connected Devices",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.ConnectedDevices),
    appCore: { apiRoutes: settingsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.ConnectedDevices);
  },
};

function withSessions(overrides: Partial<BrowserSessionListResponse>) {
  return {
    appCore: {
      apiRoutes: withSettingsRoutes([
        {
          method: "GET",
          path: "/settings/browser-sessions",
          respond: () => ({ ...browserSessionsFixture, ...overrides }),
        },
      ]),
    },
  };
}

/** More sessions than one page holds. */
export const TruncatedPage: Story = {
  parameters: withSessions({ totalCount: 11 }),
};

/** The provider could not say how many sessions there are. */
export const UnknownPageExtent: Story = {
  parameters: withSessions({ totalCount: Number.MAX_SAFE_INTEGER + 2 }),
};

/** The provider could not say which session is this browser. */
export const NoIdentifiableCurrentSession: Story = {
  parameters: withSessions({
    currentSessionKnown: false,
    sessions: browserSessionsFixture.sessions.map((session) => ({
      ...session,
      isCurrentSession: false,
    })),
  }),
};
