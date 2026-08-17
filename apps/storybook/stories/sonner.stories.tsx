import { Toaster } from "@repo/design-system/components/ui/sonner";
import type { Meta, StoryObj } from "@storybook/react";
import { toast } from "sonner";
import { action } from "storybook/actions";

/**
 * Fixed event time for the toast description (ISS-5286).
 *
 * `new Date().toLocaleString()` was nondeterministic on two axes, not one: the
 * clock, and the runner's locale/timezone. Pinning the instant alone would still
 * render "6/11/2025" here and "11/06/2025" elsewhere, so the locale and timezone
 * are pinned too. The story still demonstrates a formatted timestamp, which is
 * the point of the description slot.
 */
const EVENT_TIMESTAMP = new Date(Date.UTC(2025, 5, 11, 15, 30));
const EVENT_TIMESTAMP_LABEL = EVENT_TIMESTAMP.toLocaleString("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * An opinionated toast component for React.
 */
const meta: Meta<typeof Toaster> = {
  title: "Design System/Primitives/Sonner",
  component: Toaster,
  tags: ["autodocs"],
  argTypes: {},
  args: {
    position: "bottom-right",
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof Toaster>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the toaster.
 */
export const Default: Story = {
  render: (args) => (
    <div className="flex min-h-96 items-center justify-center space-x-2">
      <button
        onClick={() =>
          toast("Event has been created", {
            description: EVENT_TIMESTAMP_LABEL,
            action: {
              label: "Undo",
              onClick: action("Undo clicked"),
            },
          })
        }
        type="button"
      >
        Show Toast
      </button>
      <Toaster {...args} />
    </div>
  ),
};
