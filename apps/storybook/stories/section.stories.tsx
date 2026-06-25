import { Button } from "@repo/design-system/components/ui/button";
import { Section } from "@repo/design-system/components/ui/layout/section";
import type { Meta, StoryObj } from "@storybook/react";

const SectionCanvas = () => (
  <Section
    actions={<Button size="sm">Review</Button>}
    description="Shared structural card section for dashboard, settings, and activity surfaces."
    title="Section Title"
  >
    <div className="rounded-xl border border-border border-dashed px-4 py-8 text-muted-foreground text-sm">
      Section content
    </div>
  </Section>
);

const meta = {
  title: "Design System/Layout/Section",
  component: SectionCanvas,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SectionCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
