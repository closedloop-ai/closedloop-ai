import type { Meta, StoryObj } from "@storybook/react";
import { mockPackActivity, mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PacksWorkspace } from "./packs-workspace";

const meta = {
  title: "App Core/Packs/Packs Workspace",
  component: PacksWorkspace,
  args: {
    packs: mockPackViews,
    activity: mockPackActivity,
    context: createPacksContext(PacksMode.DesktopTeam),
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof PacksWorkspace>;

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
