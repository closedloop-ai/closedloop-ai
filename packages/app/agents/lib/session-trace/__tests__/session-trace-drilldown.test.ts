import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { buildSessionTrace } from "../build-session-trace";
import { findSpanPath, resolveFocusView } from "../session-trace-drilldown";
import type { SessionTraceInvocation } from "../session-trace-node";

const ORIGIN = Date.parse("2026-08-20T14:00:00.000Z");
const TOTAL_MS = 90_000;

function row(
  id: string,
  offsetMs: number,
  durationMs: number | undefined,
  parentExternalInvocationId?: string
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: `key-${id}`,
    sequence: offsetMs,
    invokedAt: new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(parentExternalInvocationId === undefined
      ? {}
      : { parentExternalInvocationId }),
  };
}

function roots() {
  return buildSessionTrace([
    row("a", 0, 60_000),
    row("a1", 10_000, 20_000, "a"),
    row("a1x", 12_000, 5000, "a1"),
    row("a2", 40_000, 10_000, "a"),
    row("b", 70_000, 20_000),
  ]).roots;
}

function ids(
  spans: readonly { invocation: { externalInvocationId: string } }[]
) {
  return spans.map((span) => span.invocation.externalInvocationId);
}

describe("findSpanPath", () => {
  it("returns the chain from the root down to a nested span, inclusive", () => {
    const path = findSpanPath(roots(), "a1x");
    expect(path === null ? null : ids(path)).toStrictEqual(["a", "a1", "a1x"]);
  });

  it("finds a span that is itself a later root", () => {
    const path = findSpanPath(roots(), "b");
    expect(path === null ? null : ids(path)).toStrictEqual(["b"]);
  });

  it("returns null when no span carries the id", () => {
    expect(findSpanPath(roots(), "missing")).toBeNull();
  });

  it("returns null for an empty tree", () => {
    expect(findSpanPath([], "a")).toBeNull();
  });
});

describe("resolveFocusView", () => {
  it("returns the whole tree over the full window when nothing is focused", () => {
    const tree = roots();
    const view = resolveFocusView(tree, null, TOTAL_MS);
    expect(view.roots).toBe(tree);
    expect(view.trail).toStrictEqual([]);
    expect(view.windowFromMs).toBe(0);
    expect(view.windowToMs).toBe(TOTAL_MS);
    expect(view.focused).toBeNull();
  });

  it("falls back to the unfocused view when the focus id is not in the tree", () => {
    const tree = roots();
    const view = resolveFocusView(tree, "missing", TOTAL_MS);
    expect(view.roots).toBe(tree);
    expect(view.focused).toBeNull();
    expect(view.windowToMs).toBe(TOTAL_MS);
  });

  it("re-roots on the focused span, carries its ancestors, and fits the window to it", () => {
    const view = resolveFocusView(roots(), "a1x", TOTAL_MS);
    expect(ids(view.roots)).toStrictEqual(["a1x"]);
    expect(ids(view.trail)).toStrictEqual(["a", "a1"]);
    expect(view.focused?.invocation.externalInvocationId).toBe("a1x");
    expect(view.windowFromMs).toBe(12_000);
    expect(view.windowToMs).toBe(17_000);
  });

  it("gives a zero-width focused span a one-millisecond window", () => {
    const tree = buildSessionTrace([
      row("z", 0, 10_000),
      row("instant", 5000, 0, "z"),
    ]).roots;
    const view = resolveFocusView(tree, "instant", TOTAL_MS);
    expect(view.windowFromMs).toBe(5000);
    expect(view.windowToMs).toBe(5001);
  });
});
