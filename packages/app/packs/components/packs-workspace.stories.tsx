import type { Meta, StoryObj } from "@storybook/react";
import {
  mockCollidingPackViews,
  mockPackActivity,
  mockPackViews,
} from "../lib/pack-view-mock";
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

// Same-named packs across every disambiguation axis (category, version, and the
// publisher last resort), so the qualifier under each colliding name can be read
// side by side — how that secondary line reads is mostly a judgment call, so it
// needs a surface to look at (FEA-3972).
export const CollidingNames: Story = {
  args: {
    packs: mockCollidingPackViews,
    activity: [],
    context: createPacksContext(PacksMode.WebAdmin),
  },
};
