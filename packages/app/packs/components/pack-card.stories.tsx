import type { Meta, StoryObj } from "@storybook/react";
import { mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { PackCard } from "./pack-card";

const meta = {
  title: "App Core/Packs/Pack Card",
  component: PackCard,
  tags: ["autodocs"],
  args: {
    pack: mockPackViews[1],
    context: createPacksContext(PacksMode.DesktopTeam),
    onSelect: () => {},
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
