import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusMetadataSection } from "@repo/design-system/components/ui/status-metadata-section";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent, within } from "storybook/test";

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

const DONE_OPTION_NAME = /done/i;

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

/**
 * A small panel pairing a status dropdown with an assignee picker, the two
 * fields most issues and documents need together.
 */
const meta = {
  title: "Composites/Inputs/Status Metadata Section",
  component: StatusMetadataSection,
  tags: ["autodocs"],
  argTypes: {
    layout: {
      options: ["horizontal", "vertical"],
      control: { type: "radio" },
    },
    status: {
      options: options.map((option) => option.value),
      control: { type: "select" },
      description:
        "Value of the selected option. Must match one of the `options` values or the trigger renders empty.",
    },
    // `options` carries rendered status icons, and a `User` without `name`
    // crashes the assignee popover on mount, so none of these three survives a
    // hand edit in a JSON editor.
    options: { control: false },
    assignee: { control: false },
    teamMembers: { control: false },
    className: { control: "text" },
    onStatusChange: { control: false, table: { category: "Events" } },
    onAssigneeChange: { control: false, table: { category: "Events" } },
  },
  args: {
    assignee: users[0],
    layout: "vertical",
    onAssigneeChange: fn(),
    onStatusChange: fn(),
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

export const Vertical: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox", { name: "Status" }));
    await userEvent.click(
      await screen.findByRole("option", { name: DONE_OPTION_NAME })
    );
    await expect(args.onStatusChange).toHaveBeenCalledWith("done");
  },
};

export const Horizontal: Story = {
  args: {
    layout: "horizontal",
  },
};
