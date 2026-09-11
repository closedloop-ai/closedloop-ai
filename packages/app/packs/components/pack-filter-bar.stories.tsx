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

/**
 * A small toolbar for narrowing down a pack catalog: a text search box and a
 * dropdown to filter by harness, sitting inside a titled card. Use it above
 * a pack list or grid whenever someone needs to search or filter before
 * opening a pack's detail or install flow. The title and description text
 * are both configurable, so the same bar can be relabeled for different
 * catalog contexts.
 */
const meta = {
  title: "Composites/Packs/Pack Filter Bar",
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
