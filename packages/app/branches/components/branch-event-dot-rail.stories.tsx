import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchEventDotRail } from "./branch-event-dot-rail";

function ev(dot: "g" | "b" | "r", text: string, t: string): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

const greenOnly: MergedTraceItem[] = [
  ev("g", "PR opened", "2026-06-10T10:00:00.000Z"),
  ev("g", "Commit pushed", "2026-06-10T11:00:00.000Z"),
  ev("g", "Approved — ready to merge", "2026-06-10T12:00:00.000Z"),
];

const greenAndRed: MergedTraceItem[] = [
  ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
  ev("r", "CI failed — non-deterministic seed", "2026-06-10T10:30:00.000Z"),
  ev("b", "autonomy step (dropped)", "2026-06-10T11:00:00.000Z"),
  ev("g", "All checks pass", "2026-06-10T12:00:00.000Z"),
];

const meta = {
  title: "Composites v1.0/Branches/Branch Event Dot Rail",
  component: BranchEventDotRail,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchEventDotRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GreenOnly: Story = {
  args: { traceItems: greenOnly, githubConnected: true },
};

export const GreenAndRed: Story = {
  args: { traceItems: greenAndRed, githubConnected: true },
};

export const StackedSemanticEvents: Story = {
  args: {
    activeHourStarts: ["2026-06-10T10:00:00.000Z"],
    onScrub: () => undefined,
    traceItems: [
      ev("b", "Human steering", "2026-06-10T10:05:00.000Z"),
      ev("g", "Commit pushed", "2026-06-10T10:15:00.000Z"),
      ev("r", "CI limit reached", "2026-06-10T10:25:00.000Z"),
    ],
  },
};

export const DenseOverflow: Story = {
  args: {
    onScrub: () => undefined,
    onScrubRow: () => undefined,
    traceItems: [
      ev("b", "First human steering turn", "2026-06-10T10:00:00.000Z"),
      ev("b", "Second human steering turn", "2026-06-10T10:00:00.000Z"),
      ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
      ev("r", "CI failed", "2026-06-10T10:00:00.000Z"),
      ev("b", "Reviewer requested follow-up", "2026-06-10T10:00:00.000Z"),
    ],
  },
};
