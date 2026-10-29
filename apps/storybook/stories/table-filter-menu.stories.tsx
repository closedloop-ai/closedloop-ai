import { TableFilterMenu } from "@repo/design-system/components/ui/table-filter-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { BotIcon, CalendarIcon, CircleDotIcon } from "lucide-react";
import { useState } from "react";

/**
 * A `Filter` button opening a dropdown of single-select radio submenus. Callers
 * build the `groups` from their own filter state; the menu is data-agnostic.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Filter Menu",
  tags: ["deprecated"],
  component: TableFilterMenu,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TableFilterMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Satisfies the story's `args` type. The story renders through its own
 * stateful harness, so nothing reads this at runtime.
 */
const DUMMY_FILTER_MENU_ARGS = { groups: [] };

export const Default: Story = {
  args: DUMMY_FILTER_MENU_ARGS,
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
