import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function CollapsibleSectionStory({
  defaultOpen = true,
}: {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="w-[520px] rounded-lg border bg-background px-4">
      <CollapsibleSection
        onOpenChange={setOpen}
        open={open}
        title="Review findings"
      >
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

const meta = {
  title: "Design System/Primitives/Collapsible Section",
  component: CollapsibleSectionStory,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof CollapsibleSectionStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: {
    defaultOpen: false,
  },
};
