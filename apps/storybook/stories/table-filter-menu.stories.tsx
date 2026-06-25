import { TableFilterMenu } from "@repo/design-system/components/ui/table-filter-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { BotIcon, CalendarIcon, CircleDotIcon } from "lucide-react";
import { useState } from "react";

/**
 * A `Filter` button opening a dropdown of single-select radio submenus. Callers
 * build the `groups` from their own filter state; the menu is data-agnostic.
 */
const meta = {
  title: "Design System/Data Display/Table Filter Menu",
  component: TableFilterMenu,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TableFilterMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [dateRange, setDateRange] = useState("90d");
    const [harness, setHarness] = useState("all");
    const [status, setStatus] = useState("all");

    return (
      <TableFilterMenu
        groups={[
          {
            id: "dateRange",
            label: "Date range",
            icon: <CalendarIcon className="size-4" />,
            value: dateRange,
            onValueChange: setDateRange,
            options: [
              { value: "7d", label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
              { value: "90d", label: "Last 90 days" },
              { value: "all", label: "All time" },
            ],
          },
          {
            id: "harness",
            label: "Harness",
            icon: <BotIcon className="size-4" />,
            value: harness,
            onValueChange: setHarness,
            options: [
              { value: "all", label: "All harnesses" },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ],
          },
          {
            id: "status",
            label: "Status",
            icon: <CircleDotIcon className="size-4" />,
            value: status,
            onValueChange: setStatus,
            options: [
              { value: "all", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "completed", label: "Completed" },
            ],
          },
        ]}
      />
    );
  },
};
