import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon, Clock3Icon, UserIcon } from "lucide-react";
import { useState } from "react";

function GroupSectionHeaderDemo({
  label,
  count,
  defaultOpen,
  tone,
}: {
  label: string;
  count: number;
  defaultOpen: boolean;
  tone: "status" | "priority" | "assignee";
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  let icon = <UserIcon className="h-4 w-4 text-muted-foreground" />;

  if (tone === "status") {
    icon = <AlertCircleIcon className="h-4 w-4 text-muted-foreground" />;
  } else if (tone === "priority") {
    icon = <Clock3Icon className="h-4 w-4 text-muted-foreground" />;
  }

  return (
    <div className="w-[420px] rounded-md border">
      <GroupSectionHeader
        count={count}
        icon={icon}
        isOpen={isOpen}
        label={label}
        onToggle={() => setIsOpen((current) => !current)}
      />
    </div>
  );
}

const meta = {
  title: "Design System/Primitives/Group Section Header",
  component: GroupSectionHeaderDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    label: "In Review",
    count: 7,
    defaultOpen: true,
    tone: "status",
  },
} satisfies Meta<typeof GroupSectionHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AssigneeSection: Story = {
  args: {
    label: "Assigned to Alex",
    tone: "assignee",
  },
};

export const Closed: Story = {
  args: {
    defaultOpen: false,
    label: "Medium Priority",
    tone: "priority",
  },
};
