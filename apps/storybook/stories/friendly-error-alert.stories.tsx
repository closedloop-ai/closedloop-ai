import { FriendlyErrorAlert } from "@repo/app/shared/components/friendly-error-alert";
import { mockFriendlyError } from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Turns a raw error from a loop or gateway failure into a readable alert: a
 * plain-language title and description, plus a bulleted list of steps you
 * can try. Use it instead of building an Alert by hand whenever you are
 * showing a backend failure to someone who is not an engineer, since it maps
 * the error into friendly copy for you rather than leaving you to write that
 * copy at each call site. The original error message is still available, but
 * only inside a collapsed "Technical details" section, so it never clutters
 * the main message.
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
