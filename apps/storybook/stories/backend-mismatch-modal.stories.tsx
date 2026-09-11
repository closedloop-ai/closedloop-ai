import { BackendMismatchModal } from "@repo/app/compute/components/backend-mismatch-modal";
import { mockBackendMismatch } from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

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

export const Default: Story = {};
