import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { format } from "date-fns";
import { useState } from "react";
import { expect, fn, screen, userEvent, within } from "storybook/test";

// Hoisted per biome's useTopLevelRegex: this only needs to compile once, not
// on every play-function run.
const TODAY_BUTTON_NAME = /^Today,/;

/**
 * A button that opens a calendar in a popover for picking a single date,
 * used inline where a full calendar grid would take up too much room.
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
    // Local-time constructor, not a bare ISO date string: `new
    // Date("2026-05-28")` parses as UTC midnight, which the play function
    // below then renders one day back in any timezone behind UTC, flaky
    // depending on where the sweep runs.
    const [value, setValue] = useState<Date | null>(new Date(2026, 4, 28));

    return <DatePickerPopover {...args} onSelect={setValue} value={value} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox"));
    // The calendar opens on the CURRENT month regardless of the selected
    // value, so this targets "Today" rather than a fixed date, stable no
    // matter which day the sweep runs on.
    await userEvent.click(
      await screen.findByRole("button", { name: TODAY_BUTTON_NAME })
    );
    await expect(canvas.getByRole("combobox")).toHaveTextContent(
      format(new Date(), "MMM d, yyyy")
    );
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
