import type { MergedTraceItem } from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import type { TimeRange } from "../lib/branch-timeline-range";
import {
  BranchTracePlayheadProvider,
  useBranchTracePlayhead,
} from "../lib/branch-trace-playhead";
import { BranchTracePlayhead } from "./branch-trace-playhead";

function sayItem(t: string): MergedTraceItem {
  return {
    type: "say",
    sessionId: "s1",
    t,
    tMs: 0,
    cumCostUsd: null,
    actorName: "alice",
    text: "x",
  };
}

const traceItems: MergedTraceItem[] = [
  sayItem("2026-06-10T10:00:00.000Z"),
  sayItem("2026-06-10T10:30:00.000Z"),
  sayItem("2026-06-10T11:30:00.000Z"),
  sayItem("2026-06-10T12:45:00.000Z"),
];

const START_MS = Date.parse("2026-06-10T10:00:00.000Z");
const END_MS = Date.parse("2026-06-10T13:00:00.000Z");
const range: TimeRange = {
  startMs: START_MS,
  endMs: END_MS,
  spanMs: END_MS - START_MS,
};

function Readout() {
  const controller = useBranchTracePlayhead();
  return (
    <p style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
      Drag the handle — active: {controller.activeTimestamp ?? "(none)"} · row{" "}
      {controller.activeRow ?? "(none)"}
    </p>
  );
}

function PlayheadDemo() {
  return (
    <BranchTracePlayheadProvider traceItems={traceItems}>
      <div style={{ maxWidth: 640 }}>
        <Readout />
        <div className="bq-bars-wrap">
          <BranchTracePlayhead range={range} />
        </div>
      </div>
    </BranchTracePlayheadProvider>
  );
}

const meta = {
  title: "App Core/Branches/Trace Playhead",
  component: PlayheadDemo,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof PlayheadDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DragToScrub: Story = {};
