import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * An icon button showing a sun or moon that opens a small menu with Light,
 * Dark and System choices for the app's colour theme. Place it wherever
 * someone can change how the app looks, typically in a header or sidebar. It
 * renders a plain, unanimated sun icon until the page has fully loaded in
 * the browser, which avoids a flash where the icon briefly shows the wrong
 * theme before settling on the right one.
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
} satisfies Meta<typeof ModeToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
