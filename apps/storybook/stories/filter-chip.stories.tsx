import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

function InteractiveFilterChipSet() {
  const [chips, setChips] = useState([
    {
      id: "status",
      label: "Status: In Progress",
    },
    {
      id: "assignee",
      label: "Assignee: Avery Carter",
      children: (
        <>
          <DropdownMenuLabel>Refine selection</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Avery Carter</DropdownMenuItem>
          <DropdownMenuItem>Jordan Lee</DropdownMenuItem>
          <DropdownMenuItem>Samir Patel</DropdownMenuItem>
        </>
      ),
    },
    {
      id: "priority",
      label: "Priority: High",
    },
  ]);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            onRemove={() =>
              setChips((current) =>
                current.filter((candidate) => candidate.id !== chip.id)
              )
            }
          >
            {chip.children}
          </FilterChip>
        ))}
      </div>
      <Button
        onClick={() =>
          setChips([
            {
              id: "status",
              label: "Status: In Progress",
            },
            {
              id: "assignee",
              label: "Assignee: Avery Carter",
              children: (
                <>
                  <DropdownMenuLabel>Refine selection</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>Avery Carter</DropdownMenuItem>
                  <DropdownMenuItem>Jordan Lee</DropdownMenuItem>
                  <DropdownMenuItem>Samir Patel</DropdownMenuItem>
                </>
              ),
            },
            {
              id: "priority",
              label: "Priority: High",
            },
          ])
        }
        size="sm"
        variant="outline"
      >
        Reset chips
      </Button>
    </div>
  );
}

/**
 * A small pill showing one active filter with an x to remove it, the single
 * building block Active Filters Bar arranges into a whole row from a table's
 * filter state.
 */
const meta = {
  title: "Composites/Data Display/Filter Chip",
  component: FilterChip,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    children: {
      control: false,
      description:
        "Dropdown menu contents. When present the label becomes a menu trigger.",
    },
    dropdownClassName: {
      control: "text",
      description: "Classes applied to the dropdown content, not the chip.",
    },
    className: { control: "text" },
    onRemove: { control: false, table: { category: "Events" } },
  },
  args: {
    label: "Status: Active",
    onRemove: fn(),
  },
} satisfies Meta<typeof FilterChip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Status: Active filter" })
    );
    await expect(args.onRemove).toHaveBeenCalled();
  },
};

export const WithDropdown: Story = {
  args: {
    dropdownClassName: "w-72",
    label: "Owner: Avery Carter",
    children: (
      <>
        <DropdownMenuLabel>Refine selection</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Avery Carter</DropdownMenuItem>
        <DropdownMenuItem>Jordan Lee</DropdownMenuItem>
        <DropdownMenuItem>Samir Patel</DropdownMenuItem>
      </>
    ),
  },
};

export const LongLabel: Story = {
  args: {
    label:
      "Repository: ~/projects/symphony-alpha/apps/app/components/document-table",
  },
};

export const InteractiveRemovals: Story = {
  render: () => <InteractiveFilterChipSet />,
};
