import type { TagColor as TagColorType } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import { TagColorPicker } from "./tag-color-picker";

const meta: Meta<typeof TagColorPicker> = {
  title: "App Core/Tags/Tag Color Picker",
  component: TagColorPicker,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders>
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  args: { value: TagColor.Blue, onChange: () => undefined },
  render: () => <ControlledTagColorPicker />,
};

export const Disabled: Story = {
  args: { value: TagColor.Pink, onChange: () => undefined, disabled: true },
};

function ControlledTagColorPicker() {
  const [color, setColor] = useState<TagColorType>(TagColor.Blue);
  return <TagColorPicker onChange={setColor} value={color} />;
}
