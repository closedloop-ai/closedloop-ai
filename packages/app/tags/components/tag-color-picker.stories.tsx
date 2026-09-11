import type { TagColor as TagColorType } from "@repo/api/src/types/tag";
import { TAG_COLORS, TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import { TagColorPicker } from "./tag-color-picker";

/**
 * A round color swatch button that opens a popover grid of preset colors,
 * and clicking one sets a tag's color and closes the picker. Reach for it
 * wherever a tag needs a color, rather than Select, since it shows every
 * choice as an actual swatch instead of a list of names. The palette is
 * fixed to a set list of named colors: there is no field for a custom value,
 * and the trigger itself is filled with the currently chosen color so you
 * can see it without opening the popover.
 */
const meta: Meta<typeof TagColorPicker> = {
  title: "Primitives/Inputs/Tag Color Picker",
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
