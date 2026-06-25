import type { Meta, StoryObj } from "@storybook/react";
import { ComputeTargetSyncTable } from "./compute-target-sync-table";

const meta = {
  title: "App Core/Compute/Compute Target Sync Table",
  component: ComputeTargetSyncTable,
  tags: ["autodocs"],
  args: {
    rows: [
      {
        id: "target-1",
        machineName: "Mike's MacBook Pro",
        ownerLabel: "Mike Angstadt",
        online: true,
        lastSyncLabel: "3m ago",
        lastSeenLabel: "just now",
      },
      {
        id: "target-2",
        machineName: "CI Runner 04",
        ownerLabel: "Design Systems",
        online: false,
        lastSyncLabel: "Never",
        lastSeenLabel: "2h ago",
      },
    ],
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ComputeTargetSyncTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    rows: [],
  },
};
