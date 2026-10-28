import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { InlineEditFeedback } from "@repo/design-system/components/ui/inline-edit-feedback";
import { Input } from "@repo/design-system/components/ui/input";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

const FEEDBACK_ID = "inline-edit-feedback-story";

/**
 * The message an inline editor renders beside its field when a write is
 * refused or a draft cannot be read. It is domain-free: the words always come
 * from the host (here the shared save-error constant production passes), and
 * the editor links the message to its control through `aria-describedby`.
 *
 * `role="alert"` announces it the moment it mounts, so the host renders it only
 * while there is something to say. `truncate` holds it to one line under a
 * grid-height field and puts the full sentence back in `title`.
 *
 * States that do not apply: it has no hover, focus, editing, loading, empty,
 * disabled, read-only or permission state of its own. It is a message, not a
 * control, and "no message" is the host rendering nothing. Those states belong
 * to the cells that mount it: Inline Scalar Cell, Inline Date Cell (through
 * Inline Scalar Cell's `type="date"`) and Inline Name Cell.
 */
const meta = {
  title: "Primitives/Feedback & Status/Inline Edit Feedback",
  component: InlineEditFeedback,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    message: { control: "text" },
    alignEnd: { control: "boolean" },
    truncate: { control: "boolean" },
    // Wiring, not appearance: the id pairs the message with a field.
    id: { control: false },
    className: { control: false },
  },
  args: {
    message: INLINE_EDIT_SAVE_ERROR_MESSAGE,
    alignEnd: false,
    truncate: false,
  },
} satisfies Meta<typeof InlineEditFeedback>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The message on its own: announced, and with no `title` while it wraps. */
export const Default: Story = {
  render: (args) => (
    <div className="w-64">
      <InlineEditFeedback {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert");
    await expect(alert).toHaveTextContent(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    await expect(alert).not.toHaveAttribute("title");
  },
};

/**
 * Beside a field: the field is marked invalid and the message is its
 * accessible description, the pairing every inline editor makes.
 */
export const DescribedField: Story = {
  render: (args) => <DescribedFieldDemo {...args} />,
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByRole("textbox", {
      name: "Estimate",
    });
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  },
};

/**
 * A narrow column. With `truncate` the message holds to one line and the full
 * sentence is still reachable through `title`, which also names the alert.
 */
export const Truncated: Story = {
  args: { truncate: true },
  render: (args) => (
    <div className="w-32">
      <InlineEditFeedback {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert", {
      name: INLINE_EDIT_SAVE_ERROR_MESSAGE,
    });
    await expect(alert).toHaveAttribute(
      "title",
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  },
};

/** Under a right-aligned numeric field, the message follows the field. */
export const AlignedEnd: Story = {
  args: { alignEnd: true, truncate: true },
  render: (args) => <DescribedFieldDemo {...args} alignEnd />,
};

/** The described field in the dark theme. */
export const Dark: Story = {
  globals: { theme: "dark" },
  render: (args) => <DescribedFieldDemo {...args} />,
};

function DescribedFieldDemo({
  alignEnd,
  message,
  truncate,
}: Readonly<{ alignEnd?: boolean; message: string; truncate?: boolean }>) {
  return (
    <div className="flex w-48 flex-col">
      <Input
        aria-describedby={FEEDBACK_ID}
        aria-invalid
        aria-label="Estimate"
        className={alignEnd ? "h-7 text-right" : "h-7"}
        defaultValue="12"
      />
      <InlineEditFeedback
        alignEnd={alignEnd}
        id={FEEDBACK_ID}
        message={message}
        truncate={truncate}
      />
    </div>
  );
}
