import type { TagColor as TagColorType } from "@repo/api/src/types/tag";
import { TAG_COLORS, TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, screen, userEvent, within } from "storybook/test";
import { TagColorPicker } from "./tag-color-picker";

/**
 * A round color swatch button that opens a popover grid of preset colors,
 * used instead of Select since it shows every choice as an actual swatch
 * rather than a list of names.
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Color: blue" }));
    // The swatch grid is a Radix popover portaled to the document body.
    await userEvent.click(await screen.findByRole("button", { name: "green" }));
    await expect(
      canvas.getByRole("button", { name: "Color: green" })
    ).toBeInTheDocument();
  },
};

export const Disabled: Story = {
  args: { value: TagColor.Pink, onChange: fn(), disabled: true },
};

function ControlledTagColorPicker() {
  const [color, setColor] = useState<TagColorType>(TagColor.Blue);
  return <TagColorPicker onChange={setColor} value={color} />;
}
