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
 * A ready-made submenu for switching between light, dark and system color
 * themes, meant to be dropped inside an existing dropdown menu's content
 * rather than opened on its own. Reach for it instead of building a theme
 * switcher from scratch anywhere a settings or account menu already exists.
 * Its trigger icon changes to match whichever theme is active, sun, moon or
 * monitor, unless you fix it to one icon yourself.
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
