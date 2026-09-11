import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PackCard } from "./pack-card";

/**
 * A catalog card for one pack: its name, publisher, star rating, and a short
 * description, with a button at the bottom to install it, open it on GitHub,
 * or show a checkmark if it's already installed. Click anywhere on the card
 * to open the pack's full detail view. Use it to browse a catalog of packs
 * rather than a plain list, since the rating and install state are visible
 * at a glance. A trending badge and a small stack of teammates' avatars can
 * also appear on it, but only when the surface decides a pack is genuinely
 * worth calling out or team usage is relevant to show.
 */
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
