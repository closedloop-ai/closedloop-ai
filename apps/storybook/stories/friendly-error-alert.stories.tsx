import { FriendlyErrorAlert } from "@repo/app/shared/components/friendly-error-alert";
import { mockFriendlyError } from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Friendly Error Alert",
  component: FriendlyErrorAlert,
  tags: ["autodocs"],
  args: {
    error: mockFriendlyError,
  },
} satisfies Meta<typeof FriendlyErrorAlert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
