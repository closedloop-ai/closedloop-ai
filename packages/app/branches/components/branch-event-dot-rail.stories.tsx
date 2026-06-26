import type { MergedTraceItem } from "@repo/api/src/types/branch";
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
  title: "App Core/Branches/Event Dot Rail",
  component: BranchEventDotRail,
  tags: ["autodocs"],
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

export const WithPrComments: Story = {
  args: { traceItems: greenAndRed, githubConnected: true, prCommentCount: 4 },
};

export const NotConnected: Story = {
  args: { traceItems: greenAndRed, githubConnected: false, prCommentCount: 4 },
};
