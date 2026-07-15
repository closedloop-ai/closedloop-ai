import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { Meta, StoryObj } from "@storybook/react";

const users = [
  {
    id: "user-1",
    firstName: "Mike",
    lastName: "Angstadt",
    avatarUrl: null,
    email: "mike@closedloop.ai",
  },
  {
    id: "user-2",
    firstName: "Annie",
    lastName: "Case",
    avatarUrl: null,
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
