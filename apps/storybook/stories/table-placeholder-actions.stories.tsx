import { TableFilterMenu } from "@repo/design-system/components/ui/table-filter-menu";
import { TablePlaceholderActions } from "@repo/design-system/components/ui/table-placeholder-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { CircleDotIcon } from "lucide-react";
import { useState } from "react";

/**
 * Dimmed, not-yet-wired toolbar affordances (Sort / Group / Options / optional
 * "New …"). Pass a functional control such as a Filter menu via `leading`.
 */
const meta = {
  title: "Design System/Data Display/Table Placeholder Actions",
  component: TablePlaceholderActions,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TablePlaceholderActions>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithPrimary: Story = {
  args: { primaryLabel: "New session" },
};

export const WithLeadingFilter: Story = {
  render: () => {
    const [status, setStatus] = useState("all");

    return (
      <TablePlaceholderActions
        leading={
          <TableFilterMenu
            groups={[
              {
                id: "status",
                label: "Status",
                icon: <CircleDotIcon className="size-4" />,
                value: status,
                onValueChange: setStatus,
                options: [
                  { value: "all", label: "All statuses" },
                  { value: "active", label: "Active" },
                ],
              },
            ]}
          />
        }
      />
    );
  },
};
