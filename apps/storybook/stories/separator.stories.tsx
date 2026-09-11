import { Separator } from "@repo/design-system/components/ui/separator";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A thin line that divides two pieces of content, either a horizontal rule
 * or, with orientation set to vertical, a vertical rule between items
 * sitting side by side. It carries no spacing of its own, so you still
 * control the gap around it with your own layout. By default it is
 * decorative, meaning screen readers skip over it as pure visual styling.
 * Turn decorative off only when the line marks a real boundary in the
 * content, like the end of one list and the start of another, so assistive
 * tech announces it.
 */
const meta = {
  title: "Primitives/Layout/Separator",
  component: Separator,
  tags: ["autodocs"],
  argTypes: {
    orientation: {
      options: ["horizontal", "vertical"],
      control: { type: "radio" },
    },
    decorative: {
      control: "boolean",
      description:
        "Purely visual dividers stay decorative so assistive tech skips them. Turn it off when the rule marks a real content boundary.",
    },
    className: {
      control: "text",
    },
  },
  args: {
    orientation: "horizontal",
    decorative: true,
  },
} satisfies Meta<typeof Separator>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the separator.
 */
export const Horizontal: Story = {
  render: () => (
    <div className="flex gap-2">
      <div>Left</div>
      <Separator className="h-auto" orientation="vertical" />
      <div>Right</div>
    </div>
  ),
};

/**
 * A vertical separator.
 */
export const Vertical: Story = {
  render: () => (
    <div className="grid gap-2">
      <div>Top</div>
      <Separator orientation="horizontal" />
      <div>Bottom</div>
    </div>
  ),
};
