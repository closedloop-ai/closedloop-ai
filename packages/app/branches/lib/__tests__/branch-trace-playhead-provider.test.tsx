import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  BranchTracePlayheadProvider,
  useBranchTracePlayhead,
} from "../branch-trace-playhead";

const OUTSIDE_PROVIDER_RE =
  /useBranchTracePlayhead must be used within a BranchTracePlayheadProvider/;

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
  sayItem("2026-06-10T10:05:00.000Z"),
  sayItem("2026-06-10T11:30:00.000Z"),
  { type: "end", sessionId: "s1", text: "done" },
];

function renderWithItems(items: readonly MergedTraceItem[]) {
  let current = items;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BranchTracePlayheadProvider traceItems={current}>
      {children}
    </BranchTracePlayheadProvider>
  );
  const view = renderHook(() => useBranchTracePlayhead(), { wrapper });
  return {
    ...view,
    setItems(next: readonly MergedTraceItem[]) {
      current = next;
      view.rerender();
    },
  };
}

describe("useBranchTracePlayhead", () => {
  it("throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useBranchTracePlayhead())).toThrow(
      OUTSIDE_PROVIDER_RE
    );
    vi.mocked(console.error).mockRestore();
  });

  it("starts with no active scrub", () => {
    const { result } = renderWithItems(traceItems);
    expect(result.current.activeTimestamp).toBeNull();
    expect(result.current.activeRow).toBeNull();
    expect(result.current.activeHourStart).toBeNull();
  });
});

describe("scrubToTimestamp", () => {
  it("sets the timestamp, derives the nearest row and hour, and notifies trace scroll listeners", () => {
    const { result } = renderWithItems(traceItems);
    const listener = vi.fn();
    result.current.registerTraceScroll(listener);
    act(() => {
      result.current.scrubToTimestamp("2026-06-10T11:20:00.000Z");
    });
    expect(result.current.activeRow).toBe(1);
    expect(result.current.activeTimestamp).toBe("2026-06-10T11:20:00.000Z");
    expect(result.current.activeHourStart).toBe("2026-06-10T11:00:00.000Z");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  it("does not notify listeners when no row can be derived", () => {
    const { result } = renderWithItems([]);
    const listener = vi.fn();
    result.current.registerTraceScroll(listener);
    act(() => {
      result.current.scrubToTimestamp("2026-06-10T11:20:00.000Z");
    });
    expect(result.current.activeTimestamp).toBe("2026-06-10T11:20:00.000Z");
    expect(result.current.activeRow).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const { result } = renderWithItems(traceItems);
    const listener = vi.fn();
    const unsubscribe = result.current.registerTraceScroll(listener);
    unsubscribe();
    act(() => {
      result.current.scrubToTimestamp("2026-06-10T10:05:00.000Z");
    });
    expect(result.current.activeRow).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("scrubToRow", () => {
  it("sets the row and its own timestamp without scrolling by default", () => {
    const { result } = renderWithItems(traceItems);
    const listener = vi.fn();
    result.current.registerTraceScroll(listener);
    act(() => {
      result.current.scrubToRow(0);
    });
    expect(result.current.activeRow).toBe(0);
    expect(result.current.activeTimestamp).toBe("2026-06-10T10:05:00.000Z");
    expect(result.current.activeHourStart).toBe("2026-06-10T10:00:00.000Z");
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to the closest indexed row's timestamp for a timestamp-less row and scrolls when flashing", () => {
    const { result } = renderWithItems(traceItems);
    const listener = vi.fn();
    result.current.registerTraceScroll(listener);
    act(() => {
      result.current.scrubToRow(2, true);
    });
    expect(result.current.activeRow).toBe(2);
    expect(result.current.activeTimestamp).toBe("2026-06-10T11:30:00.000Z");
    expect(listener).toHaveBeenCalledWith(2);
  });

  it("picks the first of two equidistant indexed rows for the fallback", () => {
    const { result } = renderWithItems([
      sayItem("2026-06-10T10:05:00.000Z"),
      { type: "end", sessionId: "s1", text: "done" },
      sayItem("2026-06-10T11:30:00.000Z"),
    ]);
    act(() => {
      result.current.scrubToRow(1);
    });
    expect(result.current.activeRow).toBe(1);
    expect(result.current.activeTimestamp).toBe("2026-06-10T10:05:00.000Z");
  });

  it("keeps the previous timestamp when the trace has no indexed rows", () => {
    const { result } = renderWithItems([
      { type: "end", sessionId: "s1", text: "done" },
    ]);
    act(() => {
      result.current.scrubToTimestamp("2026-06-10T10:05:00.000Z");
    });
    expect(result.current.activeTimestamp).toBe("2026-06-10T10:05:00.000Z");
    act(() => {
      result.current.scrubToRow(0);
    });
    expect(result.current.activeRow).toBe(0);
    expect(result.current.activeTimestamp).toBe("2026-06-10T10:05:00.000Z");
  });
});

describe("trace identity change", () => {
  it("clears an active scrub when the trace items change", () => {
    const view = renderWithItems(traceItems);
    act(() => {
      view.result.current.scrubToRow(1);
    });
    expect(view.result.current.activeRow).toBe(1);
    view.setItems([sayItem("2026-06-11T10:00:00.000Z")]);
    expect(view.result.current.activeRow).toBeNull();
    expect(view.result.current.activeTimestamp).toBeNull();
    expect(view.result.current.activeHourStart).toBeNull();
  });

  it("leaves an idle controller idle when the trace items change", () => {
    const view = renderWithItems(traceItems);
    view.setItems([sayItem("2026-06-11T10:00:00.000Z")]);
    expect(view.result.current.activeRow).toBeNull();
    expect(view.result.current.activeTimestamp).toBeNull();
  });
});
