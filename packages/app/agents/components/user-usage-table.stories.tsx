import type { Meta, StoryObj } from "@storybook/react";
import { UserUsageTable } from "./user-usage-table";

const meta = {
  title: "App Core/Agents/User Usage Table",
  component: UserUsageTable,
  tags: ["autodocs"],
  args: {
    onToggleUser: () => undefined,
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
