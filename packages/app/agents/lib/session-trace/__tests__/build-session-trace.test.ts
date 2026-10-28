import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  buildSessionTrace,
  collectFailedSpans,
  findSpanById,
  flattenSpans,
  selectDrawnSpans,
  summariseSessionTraceSpans,
} from "../build-session-trace";
import {
  SessionTraceExtentSource,
  type SessionTraceInvocation,
} from "../session-trace-node";

const ORIGIN = Date.parse("2026-08-20T14:00:00.000Z");

function row(
  id: string,
  offsetMs: number | null,
  overrides: Partial<SessionTraceInvocation> = {}
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: id,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    invokedAt:
      offsetMs === null ? null : new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

describe("buildSessionTrace", () => {
  it("re-roots a parent cycle instead of answering an empty tree", () => {
    // `parentExternalInvocationId` is collected, so a corrupt pair can point at
    // each other. Obeyed, that tree has NO root and the tab draws nothing for a
    // session that ran — an empty render standing in for bad data.
    const trace = buildSessionTrace([
      row("n1", 0, { parentExternalInvocationId: "n2", durationMs: 10 }),
      row("n2", 100, { parentExternalInvocationId: "n1", durationMs: 10 }),
      row("n3", 200, { parentExternalInvocationId: "n1", durationMs: 10 }),
    ]);

    expect(trace.spanCount).toBe(3);
    expect(trace.roots.length).toBeGreaterThan(0);
    expect(
      flattenSpans(trace.roots)
        .map((span) => span.invocation.externalInvocationId)
        .sort()
    ).toStrictEqual(["n1", "n2", "n3"]);
    // The descendant of a cut cycle member keeps the ancestry it genuinely has.
    expect(findSpanById(trace.roots, "n3")?.depth).toBe(1);
  });

  it("builds and walks a chain far deeper than a recursive descent survives", () => {
    // Deep enough that the previous recursive link/assign/walk overflowed —
    // each level cost several frames and the default stack is ~11k. The walk
    // bound is 100,000 rows, so this is well inside what a session may carry.
    const DEPTH = 10_000;
    const rows = Array.from({ length: DEPTH }, (_, index) =>
      row(`n${index}`, index, {
        ...(index === 0 ? {} : { parentExternalInvocationId: `n${index - 1}` }),
        durationMs: 1,
      })
    );

    const trace = buildSessionTrace(rows);

    expect(trace.spanCount).toBe(DEPTH);
    expect(trace.maxDepth).toBe(DEPTH - 1);
    expect(flattenSpans(trace.roots)).toHaveLength(DEPTH);
  });

  it("uses a measured duration as the extent and says so", () => {
    const trace = buildSessionTrace([row("n1", 0, { durationMs: 500 })]);
    const span = trace.roots[0];

    expect(span.extentSource).toBe(SessionTraceExtentSource.Measured);
    expect(span.subtreeMs).toBe(500);
    expect(trace.measuredSpanCount).toBe(1);
    expect(trace.inferredSpanCount).toBe(0);
  });

  it("bounds an unmeasured span at its next sibling's start, marked inferred", () => {
    const trace = buildSessionTrace([
      row("n1", 0),
      row("n2", 3000, { durationMs: 10 }),
    ]);

    expect(trace.roots[0].extentSource).toBe(SessionTraceExtentSource.Inferred);
    expect(trace.roots[0].subtreeMs).toBe(3000);
    expect(trace.inferredSpanCount).toBe(1);
  });

  it("never draws a child outside the parent that owns it", () => {
    // The parent's measured duration closes before its child does. The parent
    // is widened rather than the child being clipped or dropped.
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 100 }),
      row("n2", 50, {
        durationMs: 4000,
        parentExternalInvocationId: "n1",
      }),
    ]);

    const parent = trace.roots[0];
    expect(parent.children).toHaveLength(1);
    expect(parent.endMs).toBeGreaterThanOrEqual(parent.children[0].endMs);
    expect(parent.endMs).toBe(4050);
  });

  it("takes own time off the UNION of children, not their sum", () => {
    // Two children run concurrently across the same 1s. Summing them would
    // claim 2s of child time inside a 2s parent and report 0s of own time.
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 2000 }),
      row("n2", 0, { durationMs: 1000, parentExternalInvocationId: "n1" }),
      row("n3", 0, { durationMs: 1000, parentExternalInvocationId: "n1" }),
    ]);

    expect(trace.roots[0].selfMs).toBe(1000);
  });

  it("marks the longest-running chain as the critical path", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 100 }),
      row("n2", 0, { durationMs: 50, parentExternalInvocationId: "n1" }),
      row("n3", 0, { durationMs: 90, parentExternalInvocationId: "n1" }),
      row("n4", 0, { durationMs: 80, parentExternalInvocationId: "n3" }),
    ]);

    const onPath = flattenSpans(trace.roots)
      .filter((span) => span.onCriticalPath)
      .map((span) => span.invocation.externalInvocationId);

    expect(onPath).toStrictEqual(["n1", "n3", "n4"]);
  });

  it("does not hand the critical path to a trivial call that merely ran last", () => {
    // Sequential roots: a long one, then a 3ms trailing call. Descending by end
    // time would crown the trailing call; the answer to "why did this take 10s"
    // is the 10s root.
    const trace = buildSessionTrace([
      row("n1", 0, { componentKey: "long", durationMs: 10_000 }),
      row("n2", 20_000, { componentKey: "ScheduleWakeup", durationMs: 3 }),
    ]);

    const onPath = flattenSpans(trace.roots)
      .filter((span) => span.onCriticalPath)
      .map((span) => span.invocation.componentKey);

    expect(onPath).toStrictEqual(["long"]);
  });

  it("keeps a timestamp-less invocation instead of discarding it", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 10 }),
      row("n2", null),
    ]);

    expect(trace.spanCount).toBe(1);
    expect(
      trace.unplaced.map((row_) => row_.externalInvocationId)
    ).toStrictEqual(["n2"]);
  });

  it("strands an unreadable timestamp instead of letting NaN poison the axis", () => {
    const trace = buildSessionTrace([
      { ...row("n1", 0, { durationMs: 500 }), invokedAt: "not-a-date" },
      row("n2", 1000, { durationMs: 250 }),
    ]);

    expect(trace.unplaced.map((item) => item.externalInvocationId)).toEqual([
      "n1",
    ]);
    expect(flattenSpans(trace.roots)).toHaveLength(1);
    // The surviving row's own extent is intact: an unreadable sibling's NaN
    // reached the origin and the bound before, and every bar measured against
    // them came out unplaceable.
    expect(trace.roots[0].startMs).toBe(0);
    expect(trace.roots[0].subtreeMs).toBe(250);
    expect(Number.isFinite(trace.totalMs)).toBe(true);
  });

  it("returns every invocation as unplaced when none carries a timestamp", () => {
    const trace = buildSessionTrace([row("n1", null), row("n2", null)]);

    expect(trace.roots).toHaveLength(0);
    expect(trace.unplaced).toHaveLength(2);
    expect(trace.totalMs).toBe(0);
  });

  it("records depth, ancestry and agent identity down the tree", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { componentKey: "/cmd", durationMs: 900 }),
      row("n2", 10, {
        componentKey: "skill",
        parentExternalInvocationId: "n1",
        externalAgentId: "ag-0",
        durationMs: 800,
      }),
      row("n3", 20, {
        componentKey: "sub",
        parentExternalInvocationId: "n2",
        externalAgentId: "ag-1",
        durationMs: 700,
      }),
    ]);

    const deepest = findSpanById(trace.roots, "n3");
    expect(deepest?.depth).toBe(2);
    expect(deepest?.ancestry).toStrictEqual(["/cmd", "skill"]);
    expect(trace.maxDepth).toBe(2);
    expect(trace.agentCount).toBe(2);
  });

  it("rolls subtree spend up without touching the footprint population", () => {
    const trace = buildSessionTrace([
      row("n1", 0, {
        durationMs: 100,
        estimatedCost: 0.5,
        footprintTokens: 10,
      }),
      row("n2", 0, {
        durationMs: 50,
        parentExternalInvocationId: "n1",
        estimatedCost: 0.25,
        footprintTokens: 999,
      }),
    ]);

    expect(trace.roots[0].subtreeCostUsd).toBeCloseTo(0.75, 6);
  });

  it("rolls footprint and turn tokens up as SEPARATE populations", () => {
    // A component's injected text is already inside the consuming turn's input
    // count, so a single "tokens" total would count it twice. The two roll-ups
    // must stay apart, and neither may absorb the other.
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 100, footprintTokens: 10, inputTokens: 100 }),
      row("n2", 0, {
        durationMs: 50,
        parentExternalInvocationId: "n1",
        footprintTokens: 5,
        inputTokens: 40,
        outputTokens: 7,
      }),
    ]);

    const root = trace.roots[0];
    expect(root.subtreeFootprintTokens).toBe(15);
    expect(root.subtreeInputTokens).toBe(140);
    expect(root.subtreeOutputTokens).toBe(7);
    expect(trace.totalFootprintTokens).toBe(15);
    expect(trace.totalInputTokens).toBe(140);
  });

  it("carries a footprint on a kind that has no turn usage at all", () => {
    // Footprint is the kind-agnostic population — a hook's stdout counts even
    // though a hook never bills a turn. A roll-up that only followed turn usage
    // would report zero here.
    const trace = buildSessionTrace([
      row("n1", 0, {
        kind: AgentComponentInvocationKind.Hook,
        durationMs: 40,
        footprintTokens: 120,
      }),
    ]);

    expect(trace.roots[0].subtreeFootprintTokens).toBe(120);
    expect(trace.roots[0].subtreeInputTokens).toBe(0);
    expect(trace.totalFootprintTokens).toBe(120);
  });

  it("propagates a failure count up so a collapsed parent still shows it", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 100 }),
      row("n2", 0, {
        durationMs: 50,
        parentExternalInvocationId: "n1",
        succeeded: false,
      }),
      row("n3", 0, {
        durationMs: 10,
        parentExternalInvocationId: "n2",
        succeeded: true,
      }),
    ]);

    expect(trace.roots[0].subtreeErrorCount).toBe(1);
    expect(trace.roots[0].invocation.succeeded).toBeUndefined();
    expect(trace.errorCount).toBe(1);
  });

  it("does not count an unreported success or an absent flag as a failure", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 10 }),
      row("n2", 5, { durationMs: 10, succeeded: true }),
    ]);

    expect(trace.errorCount).toBe(0);
    expect(trace.roots[0].subtreeErrorCount).toBe(0);
  });

  it("treats a row whose parent is absent as a root rather than losing it", () => {
    const trace = buildSessionTrace([
      row("n2", 0, { durationMs: 10, parentExternalInvocationId: "missing" }),
    ]);

    expect(trace.roots).toHaveLength(1);
    expect(trace.spanCount).toBe(1);
  });
});

describe("selectDrawnSpans", () => {
  const trace = buildSessionTrace([
    row("n1", 0, { durationMs: 4000 }),
    row("n2", 0, { durationMs: 3000, parentExternalInvocationId: "n1" }),
    row("n3", 3500, { durationMs: 400, parentExternalInvocationId: "n1" }),
  ]);
  const everySpan = flattenSpans(trace.roots);

  it("drops a span that falls outside the window", () => {
    const drawn = selectDrawnSpans(everySpan, {
      showCriticalPathOnly: false,
      windowFromMs: 0,
      windowToMs: 1000,
    });

    expect(drawn.map((span) => span.invocation.componentKey)).toEqual([
      "n1",
      "n2",
    ]);
  });

  it("drops a span that is off the critical path", () => {
    const drawn = selectDrawnSpans(everySpan, {
      showCriticalPathOnly: true,
      windowFromMs: 0,
      windowToMs: 4000,
    });

    expect(drawn.every((span) => span.onCriticalPath)).toBe(true);
    expect(drawn.length).toBeLessThan(everySpan.length);
  });

  it("summarises the narrowed rows, not the tree they came from", () => {
    // The header sits above the chart and claims to describe it. Summarising
    // the whole subtree while the chart draws a window of it reports spend,
    // failures and coverage for rows the reader cannot see.
    const drawn = selectDrawnSpans(everySpan, {
      showCriticalPathOnly: false,
      windowFromMs: 0,
      windowToMs: 1000,
    });

    expect(summariseSessionTraceSpans(drawn).spanCount).toBe(2);
    expect(summariseSessionTraceSpans(everySpan).spanCount).toBe(3);
  });
});

describe("collectFailedSpans", () => {
  it("orders two failures that share a sequence by externalInvocationId", () => {
    // `sequence` is NOT unique: the invocation table's only uniqueness is
    // (generationId, externalInvocationId) and (generationId, sequence) is a
    // plain index, so two invocations in one generation can share a sequence.
    // Without the tiebreak the comparator returns 0 for these two distinct rows
    // and the order falls back to input order, which reverses when the read
    // returns them the other way round.
    const forward = buildSessionTrace([
      row("n1", 0, { durationMs: 10 }),
      row("zz", 100, { sequence: 7, succeeded: false, durationMs: 10 }),
      row("aa", 200, { sequence: 7, succeeded: false, durationMs: 10 }),
    ]);
    const reversed = buildSessionTrace([
      row("n1", 0, { durationMs: 10 }),
      row("aa", 200, { sequence: 7, succeeded: false, durationMs: 10 }),
      row("zz", 100, { sequence: 7, succeeded: false, durationMs: 10 }),
    ]);

    const ids = (trace: ReturnType<typeof buildSessionTrace>) =>
      collectFailedSpans(trace.roots).map(
        (span) => span.invocation.externalInvocationId
      );

    expect(ids(forward)).toStrictEqual(["aa", "zz"]);
    expect(ids(reversed)).toStrictEqual(["aa", "zz"]);
  });

  it("keeps sequence as the ranked key ahead of the tiebreak", () => {
    const trace = buildSessionTrace([
      row("zz", 0, { sequence: 1, succeeded: false, durationMs: 10 }),
      row("aa", 100, { sequence: 2, succeeded: false, durationMs: 10 }),
    ]);

    expect(
      collectFailedSpans(trace.roots).map(
        (span) => span.invocation.externalInvocationId
      )
    ).toStrictEqual(["zz", "aa"]);
  });
});
