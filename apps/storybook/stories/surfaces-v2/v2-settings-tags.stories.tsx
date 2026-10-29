import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { settingsApiRoutes } from "./fixtures/settings-fixtures";
import { withLiveRoute } from "./live-route";
import {
  expectSettingsPanel,
  SettingsLivePage,
  settingsPanelRoute,
} from "./settings-live-page";

// ISS-11361 Target sidebar, entry 27 of 62: Tags (Tool page).
// The live Settings page at `/<org>/settings?panel=tags`
// (`apps/app/.../[orgSlug]/settings/page.tsx`): the Settings dialog, with its
// rail and the Tags panel, over the app frame. Each story is one state the
// live page reaches from its reads.
// The Tags panel exists only where the `artifact-tags` flag is on, so this
// page shows it on; `ArtifactTagsOff` is the same link where it is off.

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Tags",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SettingsLivePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: settingsPanelRoute(SettingsPanelId.Tags),
    appCore: {
      apiRoutes: settingsApiRoutes,
      enabledFlags: [ARTIFACT_TAGS_FEATURE_FLAG_KEY],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectSettingsPanel(canvasElement, SettingsPanelId.Tags);
  },
};

/** `artifact-tags` is off: the link names no panel, so the dialog says so. */
export const ArtifactTagsOff: Story = {
  parameters: { appCore: { apiRoutes: settingsApiRoutes, enabledFlags: [] } },
};
