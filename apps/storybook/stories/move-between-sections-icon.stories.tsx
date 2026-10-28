import { MoveBetweenSectionsIcon } from "@repo/design-system/components/ui/move-between-sections-icon";
import type { Meta, StoryObj } from "@storybook/react";

/** Opposing arrows used to move a row between grouped table sections. */
const meta = {
  title: "Primitives v1.0/Data Display/Move Between Sections Icon",
  component: MoveBetweenSectionsIcon,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    size: { control: "number" },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof MoveBetweenSectionsIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { size: 12 },
};

export const ButtonContext: Story = {
  args: { size: 12 },
  render: (args) => (
    <button
      aria-label="Move between sections"
      style={{
        alignItems: "center",
        background: "rgba(37, 39, 40, 0.03)",
        border: 0,
        borderRadius: 6,
        color: "rgb(29, 31, 33)",
        display: "flex",
        height: 28,
        justifyContent: "center",
        width: 28,
      }}
      type="button"
    >
      <MoveBetweenSectionsIcon {...args} />
    </button>
  ),
};
