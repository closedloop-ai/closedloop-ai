import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

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

/**
 * A header row for a page section or panel, showing a bold title on the left
 * and any trailing actions, like a button, on the right. Pass both isOpen
 * and onToggle together to make the title itself a collapse toggle with a
 * chevron, or leave them out for a plain, static title. It only supplies the
 * header row: use Collapsible Section when you also want it wired up to hide
 * and show a block of content beneath it, and use Group Section Header
 * instead for the denser row that sits above a group of table or list rows.
 */
const meta = {
  title: "Primitives/Layout/Section Header",
  component: SectionHeader,
  tags: ["autodocs"],
  argTypes: {
    title: {
      control: "text",
    },
    isOpen: {
      control: "boolean",
      description:
        "Supply together with onToggle to render the title as a collapse toggle.",
    },
    children: {
      control: false,
      description: "Trailing actions rendered on the right of the header.",
    },
    onToggle: {
      control: false,
      table: { category: "Events" },
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    title: "Associated Artifacts",
    onToggle: fn(),
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
