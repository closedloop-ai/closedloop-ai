import type { TagColor as TagColorType } from "@repo/api/src/types/tag";
import { TAG_COLORS, TagColor } from "@repo/api/src/types/tag";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { TagColorPicker } from "./tag-color-picker";

/** Interactive wrapper for the shared presentation seam. */
function ControlledTagColorPicker({
  value,
  ...args
}: ComponentProps<typeof TagColorPicker>) {
  const [color, setColor] = useState<TagColorType>(value);
  return <TagColorPicker {...args} onChange={setColor} value={color} />;
}

const meta = {
  title: "Primitives v1.0/Inputs/Tag Color Picker",
  tags: ["deprecated"],
  component: TagColorPicker,
  argTypes: {
    // Verified: `control: "select"` is the valid shorthand form (equivalent
    // to `control: { type: "select" }`) and `options` is meant to sit
    // alongside `control`, not nested inside it — this shape is correct and
    // does render a working dropdown of the 16 `TagColor` values.
    value: { control: "select", options: TAG_COLORS },
    // `onChange` is a callback with no actions addon wired into this repo's
    // `.storybook/main.ts`, so left alone it renders the broken "Setup
    // controls" placeholder. `ControlledTagColorPicker` also always
    // overrides it with its own `setColor`, so a panel control could never
    // do anything even if one existed.
    onChange: { control: false },
  },
  // key remounts the story when the Controls panel changes `value`,
  // re-seeding local state — same pattern as Favorite Button.
  render: (args) => (
    <ControlledTagColorPicker key={remountKey(args.value)} {...args} />
  ),
} satisfies Meta<typeof TagColorPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  args: { value: TagColor.Blue, onChange: () => undefined },
};

export const Disabled: Story = {
  args: { value: TagColor.Pink, onChange: () => undefined, disabled: true },
};
