import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { UserUsageTable } from "./user-usage-table";

/**
 * Breaks down usage, sessions, and cost by person, where clicking a name
 * filters the page instead of navigating away, mirroring the Model Usage
 * Table by user.
 */
const meta = {
  title: "Composites/Agents/User Usage Table",
  component: UserUsageTable,
  tags: ["autodocs"],
  argTypes: {
    rows: { control: "object" },
    onToggleUser: { control: false, table: { category: "Events" } },
  },
  args: {
    onToggleUser: fn(),
    rows: [
      {
        id: "user-1",
        label: "Mike Angstadt",
        sessions: "142",
        input: "1.2M",
        output: "244k",
        cost: "$42.18",
        href: "/sessions?userId=user-1",
        active: true,
      },
      {
        id: "user-2",
        label: "Annie Case",
        sessions: "58",
        input: "442k",
        output: "88k",
        cost: "$15.02",
        href: "/sessions?userId=user-2",
      },
    ],
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof UserUsageTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    rows: [],
  },
};
