import type { TurnItem } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { type TraceEventGroup, TraceEventRow } from "./trace-event-row";

/**
 * The event row picks between THREE shells, and which one it picks is a
 * correctness rule, not a style choice — a row that folds into a chip must never
 * become the clickable separator `<button>`, or the chip's own head is a button
 * inside a button. These stories put the three side by side on the canvas so the
 * rule is visible rather than only asserted.
 *
 * The ISS-4767 fold gate defaults to `false` with no provider mounted, so the
 * chip-block story wraps nothing and still shows a folded harness chip: the
 * generic wrapper fold has never been flag-gated.
 */
function eventGroup(
  overrides: Partial<Extract<TurnItem, { type: "event" }>> = {}
): TraceEventGroup {
  return {
    kind: "event",
    row: 12,
    item: {
      type: "event",
      _row: 12,
      t: "2026-08-02T17:04:00.000Z",
      tMs: 0,
      dot: "b",
      text: "Session resumed",
      ...overrides,
    },
  };
}

const meta = {
  title: "App Core/Agents/Timeline/Trace Event Row",
  component: TraceEventRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    group: {
      control: "object",
      description:
        "The coalesced event line, as session-trace.tsx builds it in buildTraceGroups.",
    },
    active: {
      control: "boolean",
      description: "Read-only 'you are here' highlight driven by the trace.",
    },
    invocationAnchor: {
      control: "object",
      description:
        "Anchor the row is compared against to stamp data-invocation-anchor-target.",
    },
    onJump: {
      control: false,
      description:
        "Omit it and the row is a plain separator. Supplying it makes the whole row the jump target, unless the row folds into a harness chip.",
      table: { category: "Events" },
    },
  },
  args: { active: false, group: eventGroup(), invocationAnchor: null },
} satisfies Meta<typeof TraceEventRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No `onJump`: a plain, non-interactive centered separator row. */
export const Separator: Story = {};

/** With `onJump` the whole row becomes the clickable jump target. */
export const ClickableSeparator: Story = {
  args: { onJump: fn() },
};

/**
 * The row folds a harness wrapper into a chip, so it renders LEFT-ALIGNED and
 * stays a `<div>` even though `onJump` is set — the chip head is the only button.
 */
export const FoldedChipBlock: Story = {
  args: {
    group: eventGroup({
      text: "<local-command-stdout>Model set to Opus</local-command-stdout>",
    }),
    onJump: fn(),
  },
};

/** The green and red dots, on the same separator shell. */
export const SuccessDot: Story = {
  args: { group: eventGroup({ dot: "g", text: "Tests passed" }) },
};

export const ErrorDot: Story = {
  args: { group: eventGroup({ dot: "r", text: "Build failed" }) },
};

/** The read-only "you are here" highlight the trace drives while scrolling. */
export const Active: Story = {
  args: { active: true },
};
