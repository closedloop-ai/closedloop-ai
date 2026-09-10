import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  mockCollidingPackViews,
  mockPackActivity,
  mockPackViews,
} from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PacksWorkspace } from "./packs-workspace";

const meta = {
  title: "Surfaces/Packs Workspace",
  component: PacksWorkspace,
  tags: ["autodocs"],
  argTypes: {
    activity: { control: "object", table: { category: "Data" } },
    context: {
      control: "object",
      description:
        "Surface capabilities. Build it with `createPacksContext(mode)` rather than hand-editing the capability flags.",
      table: { category: "Data" },
    },
    detailContentsSlot: { control: false, table: { category: "Content" } },
    detailHeaderActions: { control: false, table: { category: "Content" } },
    detailPack: { control: "object", table: { category: "Data" } },
    emptyState: { control: false, table: { category: "Content" } },
    footerSlot: { control: false, table: { category: "Content" } },
    installError: { control: "text", table: { category: "State" } },
    installPending: { control: "object", table: { category: "State" } },
    memberTargetsDescription: {
      control: "text",
      table: { category: "Content" },
    },
    memberTargetsError: { control: "boolean", table: { category: "State" } },
    memberTargetsInstall: { control: "object", table: { category: "State" } },
    memberTargetsLoading: { control: "boolean", table: { category: "State" } },
    onInstall: { control: false, table: { category: "Events" } },
    onManageDistribution: { control: false, table: { category: "Events" } },
    onSelectPack: { control: false, table: { category: "Events" } },
    onUninstall: { control: false, table: { category: "Events" } },
    onUpdate: { control: false, table: { category: "Events" } },
    onWithdrawDistribution: { control: false, table: { category: "Events" } },
    packs: { control: "object", table: { category: "Data" } },
    toolbarSlot: { control: false, table: { category: "Content" } },
    withdrawDistributionPending: {
      control: "boolean",
      table: { category: "State" },
    },
  },
  args: {
    packs: mockPackViews,
    activity: mockPackActivity,
    context: createPacksContext(PacksMode.DesktopTeam),
    detailPack: null,
    installError: null,
    installPending: null,
    memberTargetsError: false,
    memberTargetsInstall: null,
    memberTargetsLoading: false,
    withdrawDistributionPending: false,
    onManageDistribution: fn(),
    onSelectPack: fn(),
    onUninstall: fn(),
    onUpdate: fn(),
    onWithdrawDistribution: fn(),
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
