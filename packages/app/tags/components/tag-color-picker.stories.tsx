import type { TagColor as TagColorType } from "@repo/api/src/types/tag";
import { TAG_COLORS, TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import { TagColorPicker } from "./tag-color-picker";

const meta: Meta<typeof TagColorPicker> = {
  title: "App Core/Tags/Tag Color Picker",
  component: TagColorPicker,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "select", options: TAG_COLORS },
    disabled: { control: "boolean" },
    onChange: { control: false, table: { category: "Events" } },
  },
  args: { disabled: false },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  args: { value: TagColor.Blue, onChange: fn() },
  render: () => <ControlledTagColorPicker />,
};

export const Disabled: Story = {
  args: { value: TagColor.Pink, onChange: fn(), disabled: true },
};

function ControlledTagColorPicker() {
  const [color, setColor] = useState<TagColorType>(TagColor.Blue);
  return <TagColorPicker onChange={setColor} value={color} />;
}
