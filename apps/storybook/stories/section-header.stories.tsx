import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function ToggleDemo() {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <SectionHeader
      isOpen={isOpen}
      onToggle={() => setIsOpen((current) => !current)}
      title="Associated Artifacts"
    >
      <Button size="sm" variant="outline">
        Add link
      </Button>
    </SectionHeader>
  );
}

const meta = {
  title: "Design System/Layout/Section Header",
  component: SectionHeader,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    title: "Associated Artifacts",
  },
} satisfies Meta<typeof SectionHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithActions: Story = {
  args: {
    children: (
      <Button size="sm" variant="outline">
        Add link
      </Button>
    ),
  },
};

export const Toggleable: Story = {
  render: () => <ToggleDemo />,
};
