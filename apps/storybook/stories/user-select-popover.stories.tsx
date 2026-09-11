import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { mockUsers } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, screen, userEvent, within } from "storybook/test";

// Hoisted per biome's useTopLevelRegex: this only needs to compile once, not
// on every play-function run.
const JORDAN_LEE_OPTION_NAME = /Jordan Lee/i;

/**
 * A button opening a small searchable popover for picking one person to
 * assign or reassign, showing avatars and names, with an icon only mode for
 * table cells.
 */
const meta = {
  title: "Composites/Overlays/User Select Popover",
  component: UserSelectPopover,
  tags: ["autodocs"],
  argTypes: {
    users: {
      control: "object",
      table: { category: "Content" },
      description: "The list the picker searches over.",
    },
    placeholder: {
      control: "text",
      table: { category: "Content" },
    },
    // Both stories hold the selection in local state and pass it themselves, so
    // a panel control here would be inert.
    value: { control: false, table: { category: "State" } },
    trigger: {
      control: false,
      table: { category: "Content" },
      description: "Custom trigger element. Defaults to an add-person button.",
    },
    iconOnly: {
      control: "boolean",
      table: { category: "Appearance" },
      description: "Render the trigger as a bare icon button, for inline use.",
    },
    disabled: {
      control: "boolean",
      table: { category: "State" },
    },
    isLoading: {
      control: "boolean",
      table: { category: "State" },
      description:
        "Swaps the empty-state copy while the user list is still loading.",
    },
    ariaLabel: {
      control: "text",
      table: { category: "Accessibility" },
      description:
        'Field name announced with the value, e.g. "Assignee: Ada Lovelace".',
    },
    id: {
      control: "text",
      table: { category: "Accessibility" },
      description: "Trigger id, so a sibling label can point at it.",
    },
    className: { control: false, table: { category: "Appearance" } },
    onSelect: { control: false, table: { category: "Events" } },
  },
  args: {
    ariaLabel: "Assignee",
    disabled: false,
    iconOnly: false,
    isLoading: false,
    onSelect: fn(),
    placeholder: "Select user...",
    users: mockUsers,
  },
} satisfies Meta<typeof UserSelectPopover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
  render: (args) => {
    const [value, setValue] = useState<(typeof mockUsers)[number] | null>(
      mockUsers[0] ?? null
    );

    return (
      <UserSelectPopover
        {...args}
        onSelect={(user) => setValue(user)}
        users={mockUsers}
        value={value}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Assignee: Avery Carter" })
    );
    // The search list is a Radix popover portaled to the document body.
    await userEvent.click(
      await screen.findByRole("option", { name: JORDAN_LEE_OPTION_NAME })
    );
    await expect(
      canvas.getByRole("combobox", { name: "Assignee: Jordan Lee" })
    ).toBeInTheDocument();
  },
};

export const IconOnly: Story = {
  args: {
    iconOnly: true,
    onSelect: fn(),
    users: mockUsers,
  },
  render: (args) => {
    const [value, setValue] = useState<(typeof mockUsers)[number] | null>(null);

    return (
      <UserSelectPopover
        {...args}
        onSelect={(user) => setValue(user)}
        users={mockUsers}
        value={value}
      />
    );
  },
};
