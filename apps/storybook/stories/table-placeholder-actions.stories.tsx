import { TableFilterMenu } from "@repo/design-system/components/ui/table-filter-menu";
import { TablePlaceholderActions } from "@repo/design-system/components/ui/table-placeholder-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { CircleDotIcon } from "lucide-react";
import { useState } from "react";

/**
 * A row of toolbar buttons like Sort, Group, and Options shown dimmed and
 * disabled, for a table adopting a new toolbar design before the underlying
 * actions actually exist.
 */
const meta = {
  title: "Composites/Data Display/Table Placeholder Actions",
  component: TablePlaceholderActions,
  tags: ["autodocs"],
  argTypes: {
    primaryLabel: {
      control: "text",
      description:
        "Label for the primary create button. Leave empty to render no primary action.",
    },
    leading: {
      control: false,
      description:
        "Functional control rendered before the dimmed placeholders, such as a real Filter menu.",
    },
  },
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
