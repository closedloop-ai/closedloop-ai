import { FriendlyErrorAlert } from "@repo/app/shared/components/friendly-error-alert";
import { mockFriendlyError } from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Friendly Error Alert",
  component: FriendlyErrorAlert,
  tags: ["autodocs"],
  argTypes: {
    error: {
      control: "object",
      description:
        "Raw error payload. The component resolves it into display-safe copy and keeps the raw message inside the technical details disclosure.",
    },
    className: { control: "text" },
  },
  args: {
    error: mockFriendlyError,
  },
} satisfies Meta<typeof FriendlyErrorAlert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
