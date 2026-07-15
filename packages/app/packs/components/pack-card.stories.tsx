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

export const WebAdmin: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
  },
};
