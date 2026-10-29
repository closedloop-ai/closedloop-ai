/**
 * ISS-10737 — a bar is the INTERSECTION of its span and the visible window.
 *
 * `selectDrawnSpans` keeps every row that OVERLAPS the window, so "Zoom to span"
 * deliberately keeps the ancestors that surround the selection. Computing a
 * width from the whole subtree and clamping only the left edge then draws those
 * ancestors far past 100% — the bar container is not overflow-clipped, so the
 * bar runs across the later columns and the inspector while stating a duration
 * the window does not show.
 */

import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../../lib/session-trace/build-session-trace";
import type { SessionTraceInvocation } from "../../../../lib/session-trace/session-trace-node";
import { SessionTraceChartRows } from "../session-trace-chart";

const ORIGIN = Date.parse("2026-08-20T14:00:00.000Z");
const COLUMNS = { footprintSourced: false, turnTokensSourced: false };

const OUTER_KEY = "iss-10737-outer";
const INNER_KEY = "iss-10737-inner";

function row(
  id: string,
  offsetMs: number,
  componentKey: string,
  durationMs: number,
  parentExternalInvocationId?: string
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey,
    sequence: offsetMs,
    invokedAt: new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    durationMs,
    ...(parentExternalInvocationId === undefined
      ? {}
      : { parentExternalInvocationId }),
  };
}

/** A 100 s outer call wrapping a 1 s inner one that starts 50 s in. */
function spans() {
  return flattenSpans(
    buildSessionTrace([
      row("outer", 0, OUTER_KEY, 100_000),
      row("inner", 50_000, INNER_KEY, 1000, "outer"),
    ]).roots
  );
}

function barOf(componentKey: string): HTMLElement {
  const label = screen.getByText(componentKey);
  const rowButton = label.closest("button");
  if (rowButton === null) {
    throw new Error(`no row rendered for ${componentKey}`);
  }
  const bar = rowButton.querySelector<HTMLElement>(
    'span[aria-hidden="true"][style*="width"]'
  );
  if (bar === null) {
    throw new Error(`no bar rendered for ${componentKey}`);
  }
  return bar;
}

function percentOf(value: string): number {
  return Number.parseFloat(value.replace("%", ""));
}

describe("SessionTraceChartRows, zoomed to a span", () => {
  it("clips an ancestor's bar to the window instead of overflowing the row", () => {
    render(
      <SessionTraceChartRows
        columns={COLUMNS}
        onSelect={() => {
          // Selection is not under test here.
        }}
        selectedId="inner"
        spans={spans()}
        windowFromMs={50_000}
        windowToMs={51_000}
      />
    );

    const outerBar = barOf(OUTER_KEY);
    const left = percentOf(outerBar.style.left);
    const width = percentOf(outerBar.style.width);

    // The outer call is 100x the window; unclipped it computed 10,000%.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);
    expect(left + width).toBeLessThanOrEqual(100.01);
  });

  it("still draws the selected span across the whole window", () => {
    render(
      <SessionTraceChartRows
        columns={COLUMNS}
        onSelect={() => {
          // Selection is not under test here.
        }}
        selectedId="inner"
        spans={spans()}
        windowFromMs={50_000}
        windowToMs={51_000}
      />
    );

    const innerBar = barOf(INNER_KEY);

    expect(percentOf(innerBar.style.left)).toBeCloseTo(0, 5);
    expect(percentOf(innerBar.style.width)).toBeCloseTo(100, 5);
  });

  it("leaves an unzoomed row unchanged", () => {
    render(
      <SessionTraceChartRows
        columns={COLUMNS}
        onSelect={() => {
          // Selection is not under test here.
        }}
        selectedId={null}
        spans={spans()}
        windowFromMs={0}
        windowToMs={100_000}
      />
    );

    const outerBar = barOf(OUTER_KEY);

    expect(percentOf(outerBar.style.left)).toBeCloseTo(0, 5);
    expect(percentOf(outerBar.style.width)).toBeCloseTo(100, 5);
  });
});
