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
  title: "Composites v1.0/Navigation/Theme Submenu",
  component: ThemeSubmenu,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
    // Switching the theme is what this component IS, so it opts out of the
    // toolbar pinning in `.storybook/preview.tsx`. See mode-toggle.stories.tsx.
    themeInteractive: true,
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

/**
 * A text-only trigger dressed in a host's own row rhythm and panel treatment —
 * for a menu whose other rows carry no glyphs, where one row wearing the only
 * icon reads as a mistake. This is exactly what the v2 workspace menu mounts.
 */
export const TextOnlyTrigger: Story = {
  args: {
    contentClassName: "rounded-xl p-1.5 shadow-xl",
    icon: null,
    itemClassName: "py-2.5",
  },
};
