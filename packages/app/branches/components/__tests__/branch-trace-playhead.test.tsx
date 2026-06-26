import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TimeRange } from "../../lib/branch-timeline-range";
import {
  BranchTracePlayheadProvider,
  useBranchTracePlayhead,
} from "../../lib/branch-trace-playhead";
import { BranchTracePlayhead } from "../branch-trace-playhead";

const SCRUB_RE = /scrub the trace timeline/i;

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
  sayItem("2026-06-10T11:00:00.000Z"),
  { type: "end", sessionId: "s1", text: "done" },
];

const START_MS = Date.parse("2026-06-10T10:00:00.000Z");
const END_MS = Date.parse("2026-06-10T12:00:00.000Z");
const range: TimeRange = {
  startMs: START_MS,
  endMs: END_MS,
  spanMs: END_MS - START_MS,
};

function Readout() {
  const controller = useBranchTracePlayhead();
  const [scrolledRow, setScrolledRow] = useState<number | null>(null);
  useEffect(
    () => controller.registerTraceScroll((row) => setScrolledRow(row)),
    [controller]
  );
  return (
    <div>
      <span data-testid="ts">{controller.activeTimestamp ?? "none"}</span>
      <span data-testid="row">{controller.activeRow ?? "none"}</span>
      <span data-testid="hour">{controller.activeHourStart ?? "none"}</span>
      <span data-testid="scrolled">{scrolledRow ?? "none"}</span>
      <button
        onClick={() => controller.scrubToTimestamp("2026-06-10T10:20:00.000Z")}
        type="button"
      >
        to-ts
      </button>
      <button onClick={() => controller.scrubToRow(2)} type="button">
        to-row
      </button>
    </div>
  );
}

function Harness() {
  return (
    <BranchTracePlayheadProvider traceItems={traceItems}>
      <Readout />
      <BranchTracePlayhead range={range} />
    </BranchTracePlayheadProvider>
  );
}

function RerenderHarness({ items }: { items: MergedTraceItem[] }) {
  return (
    <BranchTracePlayheadProvider traceItems={items}>
      <Readout />
    </BranchTracePlayheadProvider>
  );
}

const otherTraceItems: MergedTraceItem[] = [
  sayItem("2026-07-01T09:00:00.000Z"),
];

describe("BranchTracePlayhead + controller (E2)", () => {
  it("renders the draggable handle and starts with no active position", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: SCRUB_RE })).toBeInTheDocument();
    expect(screen.getByTestId("ts")).toHaveTextContent("none");
    expect(screen.getByTestId("row")).toHaveTextContent("none");
  });

  it("a timeline-driven scrub sets the timestamp, nearest row, hour, and notifies the trace", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "to-ts" }));
    expect(screen.getByTestId("ts")).toHaveTextContent(
      "2026-06-10T10:20:00.000Z"
    );
    // 10:20 is nearest to the 10:30 item (row 1).
    expect(screen.getByTestId("row")).toHaveTextContent("1");
    expect(screen.getByTestId("hour")).toHaveTextContent(
      "2026-06-10T10:00:00.000Z"
    );
    // Timeline-driven scrub forwards the row to registered trace-scroll listeners.
    expect(screen.getByTestId("scrolled")).toHaveTextContent("1");
  });

  it("a trace-driven scrub sets the row and derives its timestamp", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "to-row" }));
    expect(screen.getByTestId("row")).toHaveTextContent("2");
    expect(screen.getByTestId("ts")).toHaveTextContent(
      "2026-06-10T11:00:00.000Z"
    );
  });

  it("resets the active scrub when the trace identity changes (branch switch)", async () => {
    const { rerender } = render(<RerenderHarness items={traceItems} />);
    await userEvent.click(screen.getByRole("button", { name: "to-ts" }));
    expect(screen.getByTestId("row")).toHaveTextContent("1");

    // Navigating to a different branch swaps the trace array in-place; the stale
    // row/hour must not linger against the new trace.
    rerender(<RerenderHarness items={otherTraceItems} />);
    expect(screen.getByTestId("ts")).toHaveTextContent("none");
    expect(screen.getByTestId("row")).toHaveTextContent("none");
    expect(screen.getByTestId("hour")).toHaveTextContent("none");
  });

  it("detaches document drag listeners when it unmounts mid-drag", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Harness />);
    // Begin a drag (attaches document pointermove/pointerup listeners) but never
    // release the pointer — then unmount.
    fireEvent.pointerDown(screen.getByRole("button", { name: SCRUB_RE }), {
      clientX: 40,
    });
    removeSpy.mockClear();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    removeSpy.mockRestore();
  });
});
