import { BackendMismatchModal } from "@repo/app/compute/components/backend-mismatch-modal";
import { mockBackendMismatch } from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent } from "storybook/test";

const CONTINUE_ON_ORIGINAL_LABEL = /continue on local gpu runner/i;

/**
 * A dialog for continuing a run on a different device than it last finished
 * on, letting you keep going on the original, switch and lose the current
 * state, or cancel.
 */
const meta = {
  title: "Composites/Overlays/Backend Mismatch Modal",
  component: BackendMismatchModal,
  tags: ["autodocs"],
  argTypes: {
    open: {
      control: "boolean",
      description: "Whether the modal is mounted and visible.",
    },
    mismatchData: {
      control: "object",
      description:
        "Backend mismatch payload. Its target name drives the copy on both buttons; `null` falls back to generic wording.",
    },
    onOpenChange: { control: false, table: { category: "Events" } },
    onConfirmOriginal: { control: false, table: { category: "Events" } },
    onConfirmPreferred: { control: false, table: { category: "Events" } },
  },
  args: {
    open: true,
    onOpenChange: fn(),
    mismatchData: mockBackendMismatch,
    onConfirmOriginal: fn(),
    onConfirmPreferred: fn(),
  },
} satisfies Meta<typeof BackendMismatchModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args }) => {
    // The Dialog renders through a portal, and the story starts with
    // `open: true`, so the content is found on the document rather than
    // within canvasElement.
    const confirmButton = await screen.findByRole("button", {
      name: CONTINUE_ON_ORIGINAL_LABEL,
    });

    await userEvent.click(confirmButton);

    await expect(args.onConfirmOriginal).toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};
