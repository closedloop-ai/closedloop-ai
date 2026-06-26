import { packs } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { PackCard } from "./pack-card";

const meta = {
  title: "App Core/Packs/Pack Card",
  component: PackCard,
  tags: ["autodocs"],
  args: {
    pack: packs[0],
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Selected: Story = {
  args: {
    selected: true,
  },
};
