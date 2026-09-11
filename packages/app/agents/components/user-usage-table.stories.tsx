import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { UserUsageTable } from "./user-usage-table";

/**
 * A table breaking down usage by person: sessions run, input and output
 * tokens, and cost, one row per user. Clicking a name toggles that person as
 * a filter elsewhere on the page rather than navigating away, and a Filtered
 * badge appears on the row while it is active; a separate View sessions
 * link, when present, does navigate to that person's sessions. It shares its
 * layout with the Model Usage Table but groups by user instead of model, and
 * shows its own empty state when there is no activity to show.
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
