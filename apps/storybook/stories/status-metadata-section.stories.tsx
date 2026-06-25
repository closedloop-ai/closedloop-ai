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
  { value: "draft", label: "Draft", iconStatus: "backlog" as const },
  {
    value: "in_progress",
    label: "In Progress",
    iconStatus: "in-progress" as const,
  },
  { value: "done", label: "Done", iconStatus: "complete" as const },
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
