import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { mockUsers } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const meta = {
  title: "Composites v1.0/Inputs/User Select Popover",
  component: UserSelectPopover,
  tags: ["deprecated", "autodocs"],
  args: {
    onSelect: () => {},
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
        value={value}
      />
    );
  },
};

export const IconOnly: Story = {
  args: {
    iconOnly: true,
    onSelect: () => {},
    users: mockUsers,
  },
  render: (args) => {
    const [value, setValue] = useState<(typeof mockUsers)[number] | null>(null);

    return (
      <UserSelectPopover
        {...args}
        onSelect={(user) => setValue(user)}
        value={value}
      />
    );
  },
};
