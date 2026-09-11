import type { Meta, StoryObj } from "@storybook/react";
import { ModelUsageTable } from "./model-usage-table";

/**
 * A plain table breaking down usage by model: how many sessions used it, how
 * many input, output, and cached tokens it processed, and what it cost. Each
 * row is one model, already formatted into display strings, so this
 * component only lays the data out. Its sibling, the User Usage Table, is
 * the same shape but grouped by person instead of model; when there is
 * nothing to show, this one renders a dedicated empty state rather than a
 * table with no rows.
 */
const meta = {
  title: "Composites/Agents/Model Usage Table",
  component: ModelUsageTable,
  tags: ["autodocs"],
  argTypes: {
    rows: {
      control: "object",
      description:
        "Pre-formatted usage rows. An empty array is the empty state, not a table with no body.",
    },
  },
  args: {
    rows: [
      {
        model: "gpt-5.5",
        sessions: "84",
        input: "1.1M",
        output: "221k",
        cache: "880k",
        cost: "$38.11",
      },
      {
        model: "claude-sonnet-4.6",
        sessions: "41",
        input: "422k",
        output: "73k",
        cache: "112k",
        cost: "$12.87",
      },
    ],
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ModelUsageTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    rows: [],
  },
};
