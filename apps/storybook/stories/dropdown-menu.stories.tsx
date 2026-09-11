import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { Mail, Plus, PlusCircle, Search, UserPlus } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A menu of actions or options that opens from a button, built from items,
 * checkboxes, radio groups and nested submenus. Reach for it whenever you
 * need a structured list of choices behind a trigger; reach for the Popover
 * instead when what opens is free-form content rather than a list of
 * actions, and reach for a Tooltip when it only needs to show information on
 * hover. It blocks interaction with the rest of the page by default while it
 * is open, and several of this system's other menus, like the table view and
 * column menus, are built on top of it rather than being separate
 * primitives.
 */
const meta: Meta<typeof DropdownMenu> = {
  title: "Primitives/Overlays/Dropdown Menu",
  component: DropdownMenu,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description: "Trigger and content, supplied by the story render.",
    },
    dir: {
      options: ["ltr", "rtl"],
      control: { type: "radio" },
      description: "Reading direction the menu navigates in.",
    },
    open: {
      control: false,
      description:
        "Controlled open state. Left uncontrolled here so the trigger still works; use defaultOpen to start open.",
    },
    defaultOpen: { control: "boolean" },
    modal: {
      control: "boolean",
      description: "Blocks interaction with the page behind the open menu.",
    },
    onOpenChange: { control: false, table: { category: "Events" } },
  },
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Profile</DropdownMenuItem>
        <DropdownMenuItem>Billing</DropdownMenuItem>
        <DropdownMenuItem>Team</DropdownMenuItem>
        <DropdownMenuItem>Subscription</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  parameters: {
    layout: "centered",
  },
  args: {
    dir: "ltr",
    defaultOpen: false,
    modal: true,
    onOpenChange: fn(),
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the dropdown menu.
 */
export const Default: Story = {};

/**
 * A dropdown menu with shortcuts.
 */
export const WithShortcuts: Story = {
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuLabel>Controls</DropdownMenuLabel>
        <DropdownMenuItem>
          Back
          <DropdownMenuShortcut>⌘[</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          Forward
          <DropdownMenuShortcut>⌘]</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * A dropdown menu with submenus.
 */
export const WithSubmenus: Story = {
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuItem>
          <Search className="mr-2 size-4" />
          <span>Search</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Plus className="mr-2 size-4" />
            <span>New Team</span>
            <DropdownMenuShortcut>⌘+T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserPlus className="mr-2 size-4" />
              <span>Invite users</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                <DropdownMenuItem>
                  <Mail className="mr-2 size-4" />
                  <span>Email</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <PlusCircle className="mr-2 size-4" />
                  <span>More...</span>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * A dropdown menu with radio items.
 */
export const WithRadioItems: Story = {
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuLabel inset>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value="warning">
          <DropdownMenuRadioItem value="info">Info</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="warning">Warning</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="error">Error</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/**
 * A dropdown menu with checkboxes.
 */
export const WithCheckboxes: Story = {
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <DropdownMenuCheckboxItem checked>
          Autosave
          <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem>Show Comments</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
