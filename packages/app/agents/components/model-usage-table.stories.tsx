import type { Meta, StoryObj } from "@storybook/react";
import { ModelUsageTable } from "./model-usage-table";

const meta = {
  title: "App Core/Agents/Overview/Model Usage Table",
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
