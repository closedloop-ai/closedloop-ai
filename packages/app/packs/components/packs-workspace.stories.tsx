import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  mockCollidingPackViews,
  mockPackActivity,
  mockPackViews,
} from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PacksWorkspace } from "./packs-workspace";

const SEARCH_PACKS_LABEL = /search packs/i;
const POSTHOG_CARD_NAME = /posthog/i;
// A pack the "posthog" query must filter OUT, which is what makes the search
// assertion mean something.
const SELF_LEARNING_CARD_NAME = /self.learning/i;

/**
 * The searchable catalog of packs, the starting point for finding and
 * installing one, unlike Pack Detail which only shows a pack you've already
 * selected.
 */
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
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // No team rail in this mode, so the catalog grid is the only place these
    // names can appear.
    //
    // The non-matching card is asserted GONE before the click. Without that
    // the test proved nothing about the search: the PostHog card is on screen
    // before anything is typed, so clicking it would pass whether or not the
    // query filtered the grid at all.
    const other = await canvas.findByRole("button", {
      name: SELF_LEARNING_CARD_NAME,
    });
    await userEvent.type(
      await canvas.findByRole("textbox", { name: SEARCH_PACKS_LABEL }),
      "posthog"
    );
    await waitFor(() => expect(other).not.toBeInTheDocument());

    await userEvent.click(
      await canvas.findByRole("button", { name: POSTHOG_CARD_NAME })
    );
    await expect(args.onSelectPack).toHaveBeenCalledWith("posthog");
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
