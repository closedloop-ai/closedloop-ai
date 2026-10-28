import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../../lib/session-trace/build-session-trace";
import { formatSessionTraceDuration } from "../../../../lib/session-trace/session-trace-format";
import {
  SESSION_TRACE_KIND_TOKEN,
  SessionTraceExtentSource,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import {
  SessionTraceChartRows,
  SessionTraceChartRuler,
  sessionTraceRowAccessibleName,
} from "../session-trace-chart";
import { spanFrom, traceInvocation } from "./session-trace-span-fixtures";

const NO_COLUMNS = { footprintSourced: false, turnTokensSourced: false };
const ALL_COLUMNS = { footprintSourced: true, turnTokensSourced: true };
const EMPTY_WINDOW_COPY =
  "No spans fall inside this window. Widen the range or clear the filters.";

function barOf(componentKey: string): HTMLElement {
  const rowButton = screen.getByText(componentKey).closest("button");
  const bar = rowButton?.querySelector<HTMLElement>(
    'span[aria-hidden="true"][style*="width"]'
  );
  if (!bar) {
    throw new Error(`no bar for ${componentKey}`);
  }
  return bar;
}

function rowButtonOf(componentKey: string): HTMLButtonElement {
  const rowButton = screen.getByText(componentKey).closest("button");
  if (!rowButton) {
    throw new Error(`no row for ${componentKey}`);
  }
  return rowButton;
}

/**
 * A measured 100 s parent holding a measured 99 s child and a 64 ms failed hook
 * whose extent is only a start instant (inferred).
 */
function mixedSpans(): readonly SessionTraceSpan[] {
  return flattenSpans(
    buildSessionTrace([
      traceInvocation("parent", 0, { durationMs: 100_000 }),
      traceInvocation("long", 100, {
        durationMs: 99_000,
        parentExternalInvocationId: "parent",
        footprintTokens: 4200,
        inputTokens: 1500,
      }),
      traceInvocation("hook", 99_200, {
        kind: AgentComponentInvocationKind.Hook,
        parentExternalInvocationId: "parent",
        succeeded: false,
      }),
    ]).roots
  );
}

describe("SessionTraceChartRows", () => {
  it("says the window is empty instead of drawing an empty list", () => {
    render(
      <SessionTraceChartRows
        columns={NO_COLUMNS}
        onSelect={vi.fn()}
        selectedId={null}
        spans={[]}
        windowFromMs={0}
        windowToMs={1000}
      />
    );
    expect(screen.getByText(EMPTY_WINDOW_COPY)).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("fills a failed bar destructive, floors its width, and hatches an inferred extent", () => {
    const spans = mixedSpans();
    const hook = spans.find(
      (span) => span.invocation.externalInvocationId === "hook"
    );
    expect(hook?.extentSource).toBe(SessionTraceExtentSource.Inferred);
    render(
      <SessionTraceChartRows
        columns={NO_COLUMNS}
        onSelect={vi.fn()}
        selectedId={null}
        spans={spans}
        windowFromMs={0}
        windowToMs={1_000_000}
      />
    );

    const hookBar = barOf("component-hook");
    expect(Number.parseFloat(hookBar.style.width)).toBeCloseTo(1.2, 5);
    expect(hookBar.getAttribute("style")).toContain("var(--destructive)");
    expect(hookBar.getAttribute("style")).toContain(
      "repeating-linear-gradient"
    );

    const parentBar = barOf("component-parent");
    expect(parentBar.getAttribute("style")).toContain(
      SESSION_TRACE_KIND_TOKEN[AgentComponentInvocationKind.Tool]
    );
    expect(parentBar.getAttribute("style")).not.toContain(
      "repeating-linear-gradient"
    );
  });

  it("gives an ordinary short bar the minimum width rather than the failure floor", () => {
    render(
      <SessionTraceChartRows
        columns={NO_COLUMNS}
        onSelect={vi.fn()}
        selectedId={null}
        spans={flattenSpans(
          buildSessionTrace([traceInvocation("tiny", 0, { durationMs: 1 })])
            .roots
        )}
        windowFromMs={0}
        windowToMs={1_000_000}
      />
    );
    expect(Number.parseFloat(barOf("component-tiny").style.width)).toBeCloseTo(
      0.35,
      5
    );
  });

  it("renders sourced columns per row and says not recorded for a gap", () => {
    render(
      <SessionTraceChartRows
        columns={ALL_COLUMNS}
        onSelect={vi.fn()}
        selectedId={null}
        spans={mixedSpans()}
        windowFromMs={0}
        windowToMs={100_000}
      />
    );

    const longRow = rowButtonOf("component-long");
    expect(longRow).toHaveTextContent("4,200");
    expect(longRow).toHaveTextContent("1,500");
    const parentRow = rowButtonOf("component-parent");
    expect(
      Array.from(parentRow.querySelectorAll("span")).filter(
        (node) => node.textContent === "not recorded"
      )
    ).toHaveLength(2);
  });

  it("marks the selected row pressed and reports a click with its span", () => {
    const spans = mixedSpans();
    const onSelect = vi.fn();
    render(
      <SessionTraceChartRows
        columns={NO_COLUMNS}
        onSelect={onSelect}
        selectedId="long"
        spans={spans}
        windowFromMs={0}
        windowToMs={100_000}
      />
    );

    expect(rowButtonOf("component-long")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(rowButtonOf("component-parent")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    fireEvent.click(rowButtonOf("component-hook"));
    expect(onSelect).toHaveBeenCalledWith(
      spans.find((span) => span.invocation.externalInvocationId === "hook")
    );
  });
});

describe("sessionTraceRowAccessibleName", () => {
  it("states kind, depth, extent, both sourced columns, the critical path, and failure", () => {
    const span = spanFrom(
      [
        traceInvocation("solo", 0, {
          durationMs: 2000,
          succeeded: false,
          footprintTokens: 10,
          inputTokens: 20,
        }),
      ],
      "solo"
    );
    expect(span.onCriticalPath).toBe(true);
    expect(sessionTraceRowAccessibleName(span, ALL_COLUMNS)).toBe(
      "Tool component-solo, depth 1, measured extent 2.0s, 10 footprint tokens, 20 turn input tokens, on the critical path, failed"
    );
  });

  it("says not recorded for sourced columns this row lacks and counts failures below it", () => {
    const rows = [
      traceInvocation("parent", 0, { durationMs: 10_000 }),
      traceInvocation("kid", 100, {
        durationMs: 50,
        parentExternalInvocationId: "parent",
        succeeded: false,
      }),
      traceInvocation("late", 20_000, { durationMs: 30_000 }),
    ];
    const parent = spanFrom(rows, "parent");
    expect(parent.onCriticalPath).toBe(false);
    expect(sessionTraceRowAccessibleName(parent, ALL_COLUMNS)).toBe(
      "Tool component-parent, depth 1, measured extent 10.0s, footprint tokens not recorded, turn input tokens not recorded, 1 failed below it"
    );
  });

  it("omits unsourced columns entirely", () => {
    const span = spanFrom(
      [traceInvocation("plain", 0, { durationMs: 5 })],
      "plain"
    );
    expect(sessionTraceRowAccessibleName(span, NO_COLUMNS)).toBe(
      "Tool component-plain, depth 1, measured extent 5ms, on the critical path"
    );
  });
});

describe("SessionTraceChartRuler", () => {
  it("labels the window's ends and names only the sourced column headers", () => {
    const { rerender } = render(
      <SessionTraceChartRuler
        columns={ALL_COLUMNS}
        totalMs={90_000}
        windowFromMs={30_000}
        windowToMs={90_000}
      />
    );

    expect(
      screen.getByText(`Span · ${formatSessionTraceDuration(90_000)} total`)
    ).toBeVisible();
    const first = screen.getByText(formatSessionTraceDuration(30_000));
    const last = screen.getByText(formatSessionTraceDuration(90_000));
    expect(first.style.transform).toBe("translateX(0)");
    expect(last.style.transform).toBe("translateX(-100%)");
    expect(screen.getByText("Footprint")).toBeVisible();
    expect(screen.getByText("Tokens in")).toBeVisible();

    rerender(
      <SessionTraceChartRuler
        columns={NO_COLUMNS}
        totalMs={90_000}
        windowFromMs={30_000}
        windowToMs={90_000}
      />
    );
    expect(screen.queryByText("Footprint")).toBeNull();
    expect(screen.queryByText("Tokens in")).toBeNull();
    expect(screen.getByText("Extent")).toBeVisible();
  });
});
