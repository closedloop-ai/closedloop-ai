import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PackCard } from "./pack-card";

const meta = {
  title: "Composites/Packs/Pack Card",
  component: PackCard,
  tags: ["autodocs"],
  args: {
    pack: mockPackViews[1],
    context: createPacksContext(PacksMode.DesktopTeam),
    onSelect: fn(),
    selected: false,
    trending: false,
  },
  argTypes: {
    // The surface mode plus the capability booleans it resolves to. Editing a
    // capability changes what the card offers.
    context: { control: "object" },
    disambiguator: { control: "text" },
    // Omitted from `args` on purpose: its PRESENCE is what switches the primary
    // action from a GitHub redirect to a local install.
    onInstall: { control: false, table: { category: "Events" } },
    onSelect: { control: false, table: { category: "Events" } },
    pack: { control: "object" },
    selected: { control: "boolean" },
    trending: { control: "boolean" },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {};

export const Installed: Story = {
  args: {
    pack: mockPackViews[0],
  },
};

// The catalog-relative "trending" marker (FEA-3236). The workspace decides which
// packs qualify over the full catalog (`trendingPackIds`) and passes it in; the
// card just renders it, so the story sets the flag directly.
export const Trending: Story = {
  args: {
    trending: true,
  },
};

export const WebAdmin: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
  },
};
