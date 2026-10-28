import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridRowDragHandle } from "@repo/design-system/components/ui/grid-row-drag-handle";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

const meta = {
  title: "Primitives/Data Display/Grid Row Drag Handle",
  component: GridRowDragHandle,
  tags: ["stable", "autodocs"],
  args: {
    "aria-label": "Drag to reorder",
    disabled: false,
  },
  argTypes: {
    disabled: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <GridInteractionContract>
        <div className="group/row flex h-11 items-center rounded-md border bg-background px-3">
          <Story />
        </div>
      </GridInteractionContract>
    ),
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof GridRowDragHandle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { className: "opacity-100" },
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole("button", {
      name: "Drag to reorder",
    });
    await expect(handle).toHaveClass("opacity-100");
    await expect(handle).not.toHaveAttribute("data-state");
    await expect(handle).toBeEnabled();
    await expect(handle).toHaveClass("min-h-6", "w-6", "text-muted-foreground");
  },
};

export const Disabled: Story = {
  args: { className: "opacity-100", disabled: true },
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole("button", {
      name: "Drag to reorder",
    });
    await expect(handle).toBeDisabled();
    await expect(handle).toHaveClass("opacity-100", "disabled:opacity-30");
  },
};
