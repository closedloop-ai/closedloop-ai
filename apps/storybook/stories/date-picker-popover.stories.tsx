import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

/**
 * A button that opens a calendar in a popover for picking a single date,
 * showing the chosen date formatted right on the button face until a new one
 * is picked. Use it inline, in a table cell or a compact toolbar, where a
 * full calendar grid would take up too much room, and turn on icon only mode
 * to shrink the trigger down to a bare calendar glyph. A small clear control
 * removes the selected date without opening the calendar at all.
 */
const meta = {
  title: "Composites/Inputs/Date Picker Popover",
  component: DatePickerPopover,
  tags: ["autodocs"],
  argTypes: {
    placeholder: { control: "text", table: { category: "Content" } },
    dateFormat: {
      control: "text",
      description: "date-fns format string for the selected date.",
      table: { category: "Content" },
    },
    iconOnly: {
      control: "boolean",
      description: "Renders the trigger as a bare calendar icon button.",
      table: { category: "Appearance" },
    },
    className: { control: "text", table: { category: "Appearance" } },
    trigger: {
      control: false,
      description: "Replaces the default trigger button.",
      table: { category: "Appearance" },
    },
    disabled: { control: "boolean", table: { category: "State" } },
    // Date instances, not serializable arg values: the stories own them.
    value: { control: false, table: { category: "State" } },
    fromDate: { control: false, table: { category: "State" } },
    toDate: { control: false, table: { category: "State" } },
    onSelect: { control: false, table: { category: "Events" } },
  },
  args: {
    dateFormat: "MMM d, yyyy",
    disabled: false,
    iconOnly: false,
    onSelect: fn(),
    placeholder: "Select date...",
  },
} satisfies Meta<typeof DatePickerPopover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
  render: (args) => {
    const [value, setValue] = useState<Date | null>(new Date("2026-05-28"));

    return <DatePickerPopover {...args} onSelect={setValue} value={value} />;
  },
};

export const IconOnly: Story = {
  args: {
    iconOnly: true,
    onSelect: fn(),
    placeholder: "Assign a due date",
  },
  render: (args) => {
    const [value, setValue] = useState<Date | null>(null);

    return <DatePickerPopover {...args} onSelect={setValue} value={value} />;
  },
};
