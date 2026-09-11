import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A round image used to represent a person, with a fallback (usually
 * initials) shown while the image loads or if it fails. The size comes from
 * the className you pass rather than a size prop, so match it to the row or
 * panel it sits in. It has no built-in status dot or tooltip; add those
 * around it if you need them.
 */
const meta: Meta<typeof Avatar> = {
  title: "Primitives/Data Display/Avatar",
  component: Avatar,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description:
        "Set by the story render: an AvatarImage with an AvatarFallback behind it.",
    },
    asChild: { control: false },
    className: {
      control: "text",
      description:
        "Sizing lever. The root ships `size-8`, so pass a size utility such as `size-12` to resize.",
    },
  },
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage src="https://github.com/shadcn.png" />
      <AvatarFallback>CN</AvatarFallback>
    </Avatar>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the avatar.
 */
export const Default: Story = {};
