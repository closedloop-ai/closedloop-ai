import { Button } from "@repo/design-system/components/ui/button";
import { Section } from "@repo/design-system/components/ui/layout/section";
import type { Meta, StoryObj } from "@storybook/react";

const SectionCanvas = (props: Parameters<typeof Section>[0]) => (
  <Section {...props} />
);

const meta = {
  title: "Design System/Layout/Section",
  component: SectionCanvas,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    title: {
      control: "text",
    },
    description: {
      control: "text",
    },
    actions: {
      control: false,
      description: "Controls rendered on the right of the section header.",
    },
    children: {
      control: false,
    },
    className: {
      control: "text",
    },
    contentClassName: {
      control: "text",
      description: "Extra classes for the body below the header.",
    },
  },
  args: {
    title: "Section Title",
    description:
      "Shared structural card section for dashboard, settings, and activity surfaces.",
    actions: <Button size="sm">Review</Button>,
    children: (
      <div className="rounded-xl border border-border border-dashed px-4 py-8 text-muted-foreground text-sm">
        Section content
      </div>
    ),
  },
} satisfies Meta<typeof SectionCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
