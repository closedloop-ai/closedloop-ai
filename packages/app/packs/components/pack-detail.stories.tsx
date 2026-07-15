import type { Meta, StoryObj } from "@storybook/react";
import { mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PackDetail } from "./pack-detail";

const meta = {
  title: "App Core/Packs/Pack Detail",
  component: PackDetail,
  args: {
    pack: mockPackViews[0],
    context: createPacksContext(PacksMode.DesktopTeam),
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof PackDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DesktopTeam: Story = {};

export const DesktopSolo: Story = {
  args: {
    context: createPacksContext(PacksMode.DesktopSolo),
  },
};

export const WebAdmin: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
  },
};
