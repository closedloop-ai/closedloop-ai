import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * An icon button that opens a menu for Light, Dark and System color themes,
 * rendering a plain sun icon at first load to avoid a flash of the wrong
 * theme.
 */
const meta = {
  title: "Primitives/Navigation/Mode Toggle",
  component: ModeToggle,
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Extra classes merged onto the icon trigger button.",
    },
  },
  args: {
    className: "",
  },
  // Switching the theme is what this component IS, so it opts out of the
  // toolbar pinning in `.storybook/preview.tsx`. Pinned, its menu items set a
  // theme that nothing applies and the control demonstrates nothing. The
  // trade is that this story follows its own selection rather than the toolbar.
  parameters: {
    themeInteractive: true,
  },
} satisfies Meta<typeof ModeToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
