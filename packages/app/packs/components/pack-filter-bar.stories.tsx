import { packs } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { PackFilterBar } from "./pack-filter-bar";

const harnesses = Array.from(
  new Set(packs.flatMap((pack) => pack.harnesses))
).sort();

/** What the Select actually offers: its own "All harnesses" entry, then the
 *  harnesses the catalog carries. */
const harnessOptions = ["all", ...harnesses];

const meta = {
  title: "App Core/Packs/Pack Filter Bar",
  component: PackFilterBar,
  tags: ["autodocs"],
  argTypes: {
    description: { control: "text" },
    harness: { control: "select", options: harnessOptions },
    harnesses: { control: "object" },
    onHarnessChange: { control: false, table: { category: "Events" } },
    onQueryChange: { control: false, table: { category: "Events" } },
    query: { control: "text" },
    title: { control: "text" },
  },
  args: {
    harnesses,
    query: "agent",
    harness: "all",
    onHarnessChange: fn(),
    onQueryChange: fn(),
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackFilterBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
