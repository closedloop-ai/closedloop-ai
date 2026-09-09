import type { Meta, StoryObj } from "@storybook/react";
import { ComputeTargetSyncTable } from "./compute-target-sync-table";

/**
 * ISS-4828: "Last Sync" is the last batch the cloud ACCEPTED and "Last New Data"
 * is when session rows actually LANDED, so the table always carries both — the
 * first row below is the shape that motivated the split: syncing fine, nothing
 * new to send for three days.
 *
 * ISS-5280 (review) made `lastDataLabel` required. It was optional while a flag
 * could withhold it, which meant the column could render for some rows and not
 * others; there is now one column set, so `Default` is the only shape.
 */
const meta = {
  title: "App Core/Compute/Compute Target Sync Table",
  component: ComputeTargetSyncTable,
  tags: ["autodocs"],
  argTypes: {
    rows: {
      control: "object",
      description:
        "One row per compute target. `lastSyncLabel` is the last batch the cloud accepted; `lastDataLabel` is when session rows last landed.",
    },
  },
  args: {
    rows: [
      {
        id: "target-1",
        machineName: "Mike's MacBook Pro",
        ownerLabel: "Mike Angstadt",
        online: true,
        lastSyncLabel: "3m ago",
        lastDataLabel: "3 days ago",
        lastSeenLabel: "just now",
      },
      {
        id: "target-2",
        machineName: "CI Runner 04",
        ownerLabel: "Design Systems",
        online: false,
        lastSyncLabel: "Never",
        lastDataLabel: "Never",
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
