import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function CollapsibleSectionStory({
  defaultOpen = true,
  title = "Review findings",
}: {
  defaultOpen?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Storybook re-renders rather than remounts when an arg changes, so mirror
  // `defaultOpen` back into local state or the control reads as dead.
  const [appliedDefault, setAppliedDefault] = useState(defaultOpen);
  if (appliedDefault !== defaultOpen) {
    setAppliedDefault(defaultOpen);
    setOpen(defaultOpen);
  }

  return (
    <div className="w-[520px] rounded-lg border bg-background px-4">
      <CollapsibleSection onOpenChange={setOpen} open={open} title={title}>
        <div className="space-y-2 text-sm">
          <p className="font-medium">3 findings need implementation.</p>
          <p className="text-muted-foreground">
            Accessibility labels, token guards, and Storybook coverage are ready
            for review.
          </p>
        </div>
      </CollapsibleSection>
    </div>
  );
}

/**
 * A titled section with a chevron toggle you click to expand or collapse,
 * used on a page or panel instead of the bare Collapsible primitive, which
 * has no title built in.
 */
const meta = {
  title: "Primitives/Layout/Collapsible Section",
  component: CollapsibleSectionStory,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    defaultOpen: {
      control: "boolean",
      description: "Whether the section starts expanded.",
    },
    title: { control: "text" },
  },
  args: {
    defaultOpen: true,
    title: "Review findings",
  },
} satisfies Meta<typeof CollapsibleSectionStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: {
    defaultOpen: false,
  },
};
