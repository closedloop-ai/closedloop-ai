import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const meta = {
  title: "Composites v1.0/Inputs/Date Picker Popover",
  component: DatePickerPopover,
  tags: ["deprecated", "autodocs"],
  args: {
    onSelect: () => {},
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
    onSelect: () => {},
    placeholder: "Assign a due date",
  },
  render: (args) => {
    const [value, setValue] = useState<Date | null>(null);

    return <DatePickerPopover {...args} onSelect={setValue} value={value} />;
  },
};
