import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Composites v1.0/Navigation/Mode Toggle",
  component: ModeToggle,
  tags: ["deprecated", "autodocs"],
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
