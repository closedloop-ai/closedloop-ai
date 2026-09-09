import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
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
  argTypes: {
    traceItems: { control: "object", table: { category: "Data" } },
    commits: { control: "object", table: { category: "Data" } },
    pullRequests: { control: "object", table: { category: "Data" } },
    activeHourStarts: {
      control: "object",
      description:
        "Active bar hour starts; dots outside those bars are omitted.",
      table: { category: "Data" },
    },
    range: {
      control: "object",
      description: "Shared axis so dots align with the timeline bars.",
      table: { category: "Data" },
    },
    mergedAt: { control: "text", table: { category: "Content" } },
    openedAt: { control: "text", table: { category: "Content" } },
    prNumber: {
      control: { type: "number", min: 1, step: 1 },
      table: { category: "Content" },
    },
    prCommentCount: { control: false, table: { category: "Content" } },
    githubConnected: { control: "boolean", table: { category: "State" } },
    activeRow: {
      control: { type: "number", min: 0, step: 1 },
      table: { category: "State" },
    },
    onScrub: { control: false, table: { category: "Events" } },
    onScrubRow: { control: false, table: { category: "Events" } },
    className: { control: "text", table: { category: "Appearance" } },
  },
  args: {
    onScrub: fn(),
    onScrubRow: fn(),
  },
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
    traceItems: [
      ev("b", "Human steering", "2026-06-10T10:05:00.000Z"),
      ev("g", "Commit pushed", "2026-06-10T10:15:00.000Z"),
      ev("r", "CI limit reached", "2026-06-10T10:25:00.000Z"),
    ],
  },
};
