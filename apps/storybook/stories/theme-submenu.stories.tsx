import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ThemeSubmenu } from "@repo/design-system/components/ui/theme-submenu";
import type { Meta, StoryObj } from "@storybook/react";
import { SunMoonIcon } from "lucide-react";

/**
 * A ready-made submenu for switching light, dark and system themes, meant to
 * drop inside an existing dropdown menu instead of building a theme switcher
 * from scratch.
 */
const meta = {
  title: "Primitives/Navigation/Theme Submenu",
  component: ThemeSubmenu,
  tags: ["autodocs"],
  argTypes: {
    icon: {
      control: false,
      table: { category: "Content" },
      description:
        "Fixed trigger icon. Left unset, the trigger follows the active theme (sun, moon, or monitor).",
    },
  },
  parameters: {
    layout: "centered",
  },
  render: (args) => (
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeSubmenu {...args} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
} satisfies Meta<typeof ThemeSubmenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Default trigger icon reflects the active theme (sun / moon / monitor).
 */
export const Default: Story = {};

/**
 * A fixed sun-moon trigger icon that does not change with the active theme.
 */
export const FixedTriggerIcon: Story = {
  args: {
    icon: <SunMoonIcon className="size-4" />,
  },
};
