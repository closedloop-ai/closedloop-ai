import type { MergedTraceItem } from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchMergedTrace } from "./branch-merged-trace";

const traceItems: MergedTraceItem[] = [
  {
    type: "sessionstart",
    sessionId: "s1",
    t: "2026-06-10T10:00:00.000Z",
    actor: { name: "alice", harness: "claude" },
  },
  {
    type: "prompt",
    sessionId: "s1",
    t: "2026-06-10T10:00:30.000Z",
    tMs: 0,
    cumCostUsd: null,
    actorName: "alice",
    text: "Add the flags and examples.",
  },
  {
    type: "tools",
    sessionId: "s1",
    t: "2026-06-10T10:01:00.000Z",
    tMs: 0,
    endMs: 0,
    summary: "Edited 3 files",
    hasFail: false,
    failN: 0,
  },
  {
    type: "idle",
    sessionId: "s1",
    t: "2026-06-10T10:05:00.000Z",
    gapMs: 1_800_000,
  },
  {
    type: "sessionstart",
    sessionId: "ci1",
    t: "2026-06-10T10:35:00.000Z",
    actor: { name: null, harness: "ci", ci: true },
  },
  {
    type: "event",
    sessionId: "ci1",
    t: "2026-06-10T10:36:00.000Z",
    dot: "r",
    text: "CI failed — non-deterministic seed",
  },
  { type: "end", sessionId: "ci1", text: "Run complete" },
];

const meta = {
  title: "App Core/Branches/Merged Trace",
  component: BranchMergedTrace,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchMergedTrace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { traceItems },
};

export const ActiveRow: Story = {
  args: { traceItems, activeRow: 1 },
};

export const Empty: Story = {
  args: { traceItems: [] },
};
