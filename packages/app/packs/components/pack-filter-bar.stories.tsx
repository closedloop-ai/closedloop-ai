import { packs } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { PackFilterBar } from "./pack-filter-bar";

const harnesses = Array.from(
  new Set(packs.flatMap((pack) => pack.harnesses))
).sort();

const meta = {
  title: "App Core/Packs/Pack Filter Bar",
  component: PackFilterBar,
  tags: ["autodocs"],
  args: {
    harnesses,
    query: "agent",
    harness: "all",
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackFilterBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
