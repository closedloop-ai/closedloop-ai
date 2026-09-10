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
  title: "Primitives/Overlays/Sonner",
  component: Toaster,
  tags: ["autodocs"],
  argTypes: {
    position: {
      options: [
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
      ],
      control: { type: "select" },
      table: { category: "Appearance" },
    },
    theme: {
      options: ["light", "dark", "system"],
      control: { type: "radio" },
      description:
        "Leave unset so the toaster follows the Storybook theme through next-themes.",
      table: { category: "Appearance" },
    },
    dir: {
      options: ["ltr", "rtl", "auto"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    invert: { control: "boolean", table: { category: "Appearance" } },
    richColors: { control: "boolean", table: { category: "Appearance" } },
    closeButton: { control: "boolean", table: { category: "Appearance" } },
    expand: {
      control: "boolean",
      description: "Show every stacked toast expanded instead of collapsed.",
      table: { category: "Appearance" },
    },
    className: { control: "text", table: { category: "Appearance" } },
    duration: {
      control: { type: "number", min: 1000, max: 20_000, step: 500 },
      description: "Milliseconds a toast stays on screen.",
      table: { category: "Behavior" },
    },
    gap: {
      control: { type: "number", min: 0, max: 48, step: 1 },
      description: "Pixel gap between stacked toasts.",
      table: { category: "Behavior" },
    },
    visibleToasts: {
      control: { type: "number", min: 1, max: 10, step: 1 },
      table: { category: "Behavior" },
    },
    hotkey: {
      control: "object",
      description: "Key codes that move focus to the toast region.",
      table: { category: "Behavior" },
    },
    swipeDirections: {
      control: "object",
      description: 'Directions a toast can be swiped away, e.g. ["right"].',
      table: { category: "Behavior" },
    },
    containerAriaLabel: {
      control: "text",
      table: { category: "Accessibility" },
    },
    // Offsets accept an object, a string, or a number, and `toastOptions`,
    // `icons` and `style` carry React nodes or CSS objects the component
    // renders directly. None of them survive a hand edit in a JSON editor.
    offset: { control: false },
    mobileOffset: { control: false },
    toastOptions: { control: false },
    icons: { control: false },
    style: { control: false },
  },
  args: {
    position: "bottom-right",
    dir: "auto",
    invert: false,
    richColors: false,
    closeButton: false,
    expand: false,
    duration: 4000,
    gap: 14,
    visibleToasts: 3,
    hotkey: ["altKey", "KeyT"],
    containerAriaLabel: "Notifications",
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
