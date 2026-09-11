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
  /**
   * Omitted by the `NoCount` story: a caller holding only a PAGE of a larger
   * set passes no count, and the header then renders label + icon with no
   * number beside it.
   */
  count?: number;
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

/**
 * A clickable row that sits above a group of related table or list rows,
 * showing a chevron, an icon for what the rows are grouped by (status,
 * priority or assignee), the group's label, and how many rows are in it. Use
 * it specifically for grouped list or table headers, not general page
 * sections, where Section Header is the right choice instead. Leave the
 * count out when you only hold one page of a larger set: showing a number
 * there would read as the group's whole size when it is really just what
 * happened to load.
 */
const meta = {
  title: "Primitives/Layout/Group Section Header",
  component: GroupSectionHeaderDemo,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    count: {
      control: { type: "number", min: 0, max: 999, step: 1 },
      description:
        "Rows in this group. Clear it when the caller only holds one page of a larger set.",
    },
    defaultOpen: {
      control: "boolean",
      description:
        "Open state the demo seeds its own state with on first render.",
    },
    tone: {
      options: ["status", "priority", "assignee"],
      control: { type: "radio" },
      description: "Picks the grouping-dimension icon shown beside the label.",
    },
  },
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

/**
 * #4480 review: `count` is optional. With it omitted the header renders the
 * chevron, the icon and the label, and NO number — the honest presentation when
 * the caller holds only a page of a server-paginated set, where a bare number
 * would read as the whole population. Compare with {@link Default}, which
 * passes a count.
 */
export const NoCount: Story = {
  args: {
    count: undefined,
    label: "Active",
  },
};
