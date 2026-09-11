import { FriendlyErrorAlert } from "@repo/app/shared/components/friendly-error-alert";
import { mockFriendlyError } from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Turns a raw error from a loop or gateway failure into a plain language
 * alert with steps to try, used instead of hand building an Alert for a
 * backend failure shown to non engineers.
 */
const meta = {
  title: "Primitives/Feedback & Status/Friendly Error Alert",
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
