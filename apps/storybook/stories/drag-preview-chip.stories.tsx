import { DragPreviewChip } from "@repo/design-system/components/ui/drag-preview-chip";
import type { Meta, StoryObj } from "@storybook/react";
import { expect } from "storybook/test";

const meta = {
  title: "Primitives/Data Display/Drag Preview Chip",
  component: DragPreviewChip,
  tags: ["autodocs", "stable"],
  parameters: { layout: "padded" },
  args: {
    label: "Test PRD",
    sourceElement: globalThis.document.body,
    x: 16,
    y: 16,
  },
  argTypes: {
    label: { control: "text" },
    sourceElement: { control: false },
    x: { control: false },
    y: { control: false },
  },
} satisfies Meta<typeof DragPreviewChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const chip = canvas.getByTestId("drag-preview-chip");
    await expect(chip).toHaveTextContent("Test PRD");
    await expect(chip.querySelector("svg")).not.toBeNull();
    await expect(
      chip.querySelectorAll("[data-drag-preview-title]")
    ).toHaveLength(1);
    await expect(chip.style.width).toBe("max-content");
    await expect(chip.style.maxWidth).toContain("var(--container-sm)");
  },
};
