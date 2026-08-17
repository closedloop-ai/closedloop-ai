import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { Meta, StoryObj } from "@storybook/react";

// `User` requires `name` — `UserSelectPopover` renders it and derives the avatar
// fallback from it via `getInitials(value.name)`. This fixture previously carried
// `firstName`/`lastName` instead, which crashed both stories on mount and was
// invisible because nothing typechecked or executed this file.
const users: User[] = [
  {
    id: "user-1",
    name: "Mike Angstadt",
    email: "mike@closedloop.ai",
  },
  {
    id: "user-2",
    name: "Annie Case",
    email: "annie@closedloop.ai",
  },
];

const options = [
  {
    value: "draft",
    label: "Draft",
    icon: <StatusIcon size={16} status="backlog" />,
  },
  {
    value: "in_progress",
    label: "In Progress",
    icon: <StatusIcon size={16} status="in-progress" />,
  },
  {
    value: "done",
    label: "Done",
    icon: <StatusIcon size={16} status="complete" />,
  },
];

const meta = {
  title: "Design System/Configuration & Admin/Status Metadata Section",
  component: StatusMetadataSection,
  tags: ["autodocs"],
  args: {
    assignee: users[0],
    onAssigneeChange: () => undefined,
    onStatusChange: () => undefined,
    options,
    status: "in_progress",
    teamMembers: users,
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof StatusMetadataSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Vertical: Story = {};

export const Horizontal: Story = {
  args: {
    layout: "horizontal",
  },
};
