import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon, Clock3Icon, UserIcon } from "lucide-react";
import { useState } from "react";

function GroupSectionHeaderDemo({
  label,
  count,
  isContinued,
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
  /**
   * Set by the `Continued` story: a section too large for one page repeats its
   * header on the next, and the marker keeps that from reading as a second
   * section of the same name.
   */
  isContinued?: boolean;
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
        isContinued={isContinued}
        isOpen={isOpen}
        label={label}
        onToggle={() => setIsOpen((current) => !current)}
      />
    </div>
  );
}

const meta = {
  title: "Primitives v1.0/Data Display/Group Section Header",
  component: GroupSectionHeaderDemo,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    label: "In Review",
    count: 7,
    isContinued: false,
    defaultOpen: true,
    tone: "status",
  },
  argTypes: {
    tone: {
      control: { type: "inline-radio" },
      options: ["status", "priority", "assignee"],
    },
  },
  render: (args) => (
    <GroupSectionHeaderDemo key={remountKey(args.defaultOpen)} {...args} />
  ),
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

/**
 * ISS-4704: the section is larger than one page, so its header appears again on
 * the following page. The count still states the whole section — 7 here, not
 * the rows this page happens to carry — and the marker says the rows above it
 * are a continuation rather than a second "In Review".
 */
export const Continued: Story = {
  args: {
    isContinued: true,
  },
};

/**
 * ISS-4704, and the pair that is actually reachable: a caller can hold a page
 * of a continuing section WITHOUT knowing the section's population (the totals
 * map covers no key for it). The header then says it is continuing and states
 * no number, rather than printing this page's row count as the section size.
 */
export const ContinuedWithoutCount: Story = {
  args: {
    count: undefined,
    isContinued: true,
  },
};
