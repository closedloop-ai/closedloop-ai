import type { Meta, StoryObj } from "@storybook/react";
import {
  renderTraceLinks,
  TraceCommandChip,
  TraceTagChip,
} from "./trace-harness-tags";

/**
 * A collapsible chip that hides a chunk of raw harness output, like captured
 * command output or a system reminder, behind a click inside a session's
 * trace. The head shows a friendly label, "Command output" rather than the
 * raw tag name, and only reveals the folded text once someone clicks it
 * open. An empty payload still shows the chip with nothing to expand into,
 * and an unrecognised tag falls back to showing its raw name on the head
 * instead of a friendly one.
 */
const meta = {
  title: "Primitives/Data Display/Trace Tag Chip",
  component: TraceTagChip,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    name: {
      control: "text",
      description:
        "Raw harness wrapper tag name. Mapped names render a friendly label on the chip head; anything else falls back to the name itself.",
    },
    inner: {
      control: "text",
      description:
        "Folded inner text. Empty means the chip has nothing to expand into.",
    },
    renderInner: {
      control: false,
      description:
        "How the owning surface renders the inner text. Event rows pass renderTraceLinks; the message body recurses through markdown.",
    },
    onJump: { control: false, table: { category: "Events" } },
  },
  args: {
    name: "local-command-stdout",
    inner: "Model set to Opus\nContext window: 1M tokens",
    renderInner: renderTraceLinks,
  },
} satisfies Meta<typeof TraceTagChip>;

export default meta;
type Story = StoryObj<typeof meta>;

// Collapsed: the chip shows its friendly label ("Command output") and hides the
// inner blob until the head is clicked.
export const Collapsed: Story = {};

// A tag with no friendly mapping falls back to the raw tag name on the chip head.
export const UnmappedTagName: Story = {
  args: {
    name: "some-unmapped-wrapper",
    inner: "raw inner text",
  },
};

// An empty inner renders only the head — there is nothing to expand into.
export const EmptyInner: Story = {
  args: {
    name: "command-args",
    inner: "",
  },
};

// ISS-4767: a whole slash-command invocation folds into one chip that names the
// command. Rendered with a zero-arg `render` (matching the
// `filter-popover.stories.tsx` precedent) so this meta's `TraceTagChip` args —
// `inner`/`renderInner` — are never spread onto a component that has no such
// props.
export const CommandInvocation: StoryObj = {
  render: () => (
    <TraceCommandChip
      args="--fix packages/app"
      message={null}
      name="/review"
      renderValue={renderTraceLinks}
    />
  ),
};

// The same chip with its disclosure body visible: the labelled Message and
// Arguments rows the head does not already say.
export const CommandInvocationDetails: StoryObj = {
  render: () => (
    <TraceCommandChip
      args="--fix packages/app"
      message="review the open comments"
      name="/review"
      renderValue={renderTraceLinks}
    />
  ),
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>(".st-tag-head")?.click();
  },
};

// A bare `/clear` — the harness sent no args, and its `<command-message>` only
// echoed the command name, so there is nothing to expand into. The chip is a
// static label, not a disclosure that opens onto nothing.
export const CommandInvocationWithoutDetails: StoryObj = {
  render: () => (
    <TraceCommandChip
      args={null}
      message="clear"
      name="/clear"
      renderValue={renderTraceLinks}
    />
  ),
};
