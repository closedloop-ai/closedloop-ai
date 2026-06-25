import { BackendMismatchModal } from "@repo/app/compute/components/backend-mismatch-modal";
import { mockBackendMismatch } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Backend Mismatch Modal",
  component: BackendMismatchModal,
  tags: ["autodocs"],
  args: {
    open: true,
    onOpenChange: () => undefined,
    mismatchData: mockBackendMismatch,
    onConfirmOriginal: () => undefined,
    onConfirmPreferred: () => undefined,
  },
} satisfies Meta<typeof BackendMismatchModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
