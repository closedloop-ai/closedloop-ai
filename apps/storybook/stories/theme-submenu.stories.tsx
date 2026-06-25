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
 * A dropdown submenu for switching the next-themes color theme between Light,
 * Dark, and System. Drop it inside any `DropdownMenuContent`.
 */
const meta = {
  title: "Design System/Navigation & Shell/Theme Submenu",
  component: ThemeSubmenu,
  tags: ["autodocs"],
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
