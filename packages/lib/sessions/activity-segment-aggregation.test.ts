import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels";
import type {
  SyncedActivitySegmentRow,
  SyncedAgentSessionTokenEvent,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  type ActivitySegmentTokenEvent,
  buildActivitySegments,
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
  toActivitySegmentTokenEvents,
} from "./activity-segment-aggregation.js";

function row(
  overrides: Partial<SyncedActivitySegmentRow> & {
    phase: string;
    startMs: number;
    endMs: number;
  }
): SyncedActivitySegmentRow {
  return {
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 1,
    workItemRef: null,
    subagentId: null,
    ...overrides,
  };
}

function event(
  tMs: number,
  overrides: Partial<Omit<ActivitySegmentTokenEvent, "tMs">> = {}
): ActivitySegmentTokenEvent {
  return {
    tMs,
    costUsd: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("buildActivitySegments", () => {
  it("returns an empty tiling when there are no rows (renderer applies the fallback)", () => {
    expect(buildActivitySegments([], [event(5)])).toEqual([]);
  });

  it("bins token events into the phase whose half-open span contains them", () => {
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100 }),
      row({ phase: "implement", startMs: 100, endMs: 200 }),
    ];
    const events = [
      event(10, { costUsd: 2, inputTokens: 200, outputTokens: 20 }),
      event(150, { costUsd: 5, inputTokens: 500, outputTokens: 50 }),
      // endMs is exclusive: an event exactly at the boundary belongs to the next span.
      event(100, { costUsd: 3, inputTokens: 300, outputTokens: 30 }),
    ];

    const segments = buildActivitySegments(rows, events);

    expect(segments.map((s) => s.key)).toEqual(["plan", "implement"]);
    const plan = segments.find((s) => s.key === "plan")!;
    const implement = segments.find((s) => s.key === "implement")!;
    expect(plan.costUsd).toBe(2);
    expect(plan.inputTokens).toBe(200);
    expect(plan.durationMs).toBe(100);
    expect(implement.costUsd).toBe(8);
    expect(implement.inputTokens).toBe(800);
    expect(implement.durationMs).toBe(100);
  });

  it("reconciles per-phase cost and token sums exactly to the event totals", () => {
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100 }),
      row({ phase: "implement", startMs: 100, endMs: 200 }),
      row({
        phase: OTHER_PHASE_KEY,
        startMs: 200,
        endMs: 300,
        evidenceLayers: [],
      }),
    ];
    const events = [
      event(50, { costUsd: 1.25, inputTokens: 100, cacheReadTokens: 40 }),
      event(120, { costUsd: 2.5, inputTokens: 200, cacheWriteTokens: 15 }),
      event(250, { costUsd: 0.75, inputTokens: 50, outputTokens: 5 }),
    ];

    const segments = buildActivitySegments(rows, events);

    const totalCost = events.reduce((sum, e) => sum + e.costUsd, 0);
    const segmentCost = segments.reduce((sum, s) => sum + s.costUsd, 0);
    expect(segmentCost).toBeCloseTo(totalCost, 10);

    const totalInput = events.reduce((sum, e) => sum + e.inputTokens, 0);
    const segInput = segments.reduce((sum, s) => sum + s.inputTokens, 0);
    expect(segInput).toBe(totalInput);
    const totalCacheRead = events.reduce(
      (sum, e) => sum + e.cacheReadTokens,
      0
    );
    expect(segments.reduce((sum, s) => sum + s.cacheReadTokens, 0)).toBe(
      totalCacheRead
    );
  });

  it("accrues events falling in a gap / outside the tiling to the honest `other` remainder", () => {
    const rows = [row({ phase: "implement", startMs: 100, endMs: 200 })];
    const events = [
      event(150, { costUsd: 4 }), // inside implement
      event(10, { costUsd: 1 }), // before the tiling → other
      event(500, { costUsd: 2 }), // after the tiling → other
    ];

    const segments = buildActivitySegments(rows, events);
    const other = segments.find((s) => s.key === OTHER_PHASE_KEY)!;
    expect(other).toBeDefined();
    expect(other.isUnclassified).toBe(true);
    expect(other.costUsd).toBe(3);
    // Synthesized-only remainder has no span, so zero duration and no provenance.
    expect(other.durationMs).toBe(0);
    expect(other.source).toBeNull();
    expect(other.confidence).toBeNull();
  });

  it("merges gap events into an existing `other` tiling row rather than duplicating it", () => {
    const rows = [
      row({ phase: "implement", startMs: 100, endMs: 200 }),
      row({
        phase: OTHER_PHASE_KEY,
        startMs: 200,
        endMs: 260,
        evidenceLayers: [],
      }),
    ];
    const events = [
      event(220, { costUsd: 1 }), // inside the real other row
      event(9000, { costUsd: 2 }), // outside → merges into the same other segment
    ];

    const segments = buildActivitySegments(rows, events);
    const others = segments.filter((s) => s.key === OTHER_PHASE_KEY);
    expect(others).toHaveLength(1);
    expect(others[0]!.costUsd).toBe(3);
    expect(others[0]!.durationMs).toBe(60);
    expect(others[0]!.isUnclassified).toBe(true);
  });

  it("computes a duration-weighted mean confidence across a phase's rows", () => {
    const rows = [
      row({ phase: "implement", startMs: 0, endMs: 100, confidence: 0.4 }),
      row({ phase: "implement", startMs: 100, endMs: 300, confidence: 1 }),
    ];
    const segments = buildActivitySegments(rows, []);
    const implement = segments.find((s) => s.key === "implement")!;
    // (0.4*100 + 1*200) / 300 = 0.8
    expect(implement.confidence).toBeCloseTo(0.8, 10);
    expect(implement.durationMs).toBe(300);
  });

  it("maps declared evidence to `explicit`, structural to `loop_perf`, and empty to null", () => {
    const rows = [
      row({
        phase: "plan",
        startMs: 0,
        endMs: 100,
        evidenceLayers: ["declared", "structural"],
      }),
      row({
        phase: "implement",
        startMs: 100,
        endMs: 200,
        evidenceLayers: ["structural"],
      }),
      row({
        phase: IDLE_PHASE_KEY,
        startMs: 200,
        endMs: 260,
        evidenceLayers: [],
      }),
    ];
    const segments = buildActivitySegments(rows, []);
    expect(segments.find((s) => s.key === "plan")!.source).toBe("explicit");
    expect(segments.find((s) => s.key === "implement")!.source).toBe(
      "loop_perf"
    );
    expect(segments.find((s) => s.key === IDLE_PHASE_KEY)!.source).toBeNull();
  });

  it("resolves a phase's source by which provenance covers more wall-time (declared wins ties)", () => {
    const rows = [
      // Same phase, split across a short declared window and a longer inferred one.
      row({
        phase: "review",
        startMs: 0,
        endMs: 50,
        evidenceLayers: ["declared"],
      }),
      row({
        phase: "review",
        startMs: 50,
        endMs: 250,
        evidenceLayers: ["structural"],
      }),
    ];
    const segments = buildActivitySegments(rows, []);
    // inferred 200ms > declared 50ms → loop_perf
    expect(segments.find((s) => s.key === "review")!.source).toBe("loop_perf");
  });

  it("orders segments chronologically by earliest span, remainder-only phases last", () => {
    const rows = [
      row({ phase: "implement", startMs: 300, endMs: 400 }),
      row({ phase: "plan", startMs: 0, endMs: 100 }),
    ];
    // An event in the gap [100,300) creates a synthesized `other` with no span.
    const segments = buildActivitySegments(rows, [event(200)]);
    expect(segments.map((s) => s.key)).toEqual([
      "plan",
      "implement",
      OTHER_PHASE_KEY,
    ]);
  });

  it("labels the honest remainder and idle distinctly and titleizes other phases", () => {
    const rows = [
      row({ phase: "implement", startMs: 0, endMs: 100 }),
      row({
        phase: IDLE_PHASE_KEY,
        startMs: 100,
        endMs: 150,
        evidenceLayers: [],
      }),
      row({
        phase: OTHER_PHASE_KEY,
        startMs: 150,
        endMs: 200,
        evidenceLayers: [],
      }),
    ];
    const segments = buildActivitySegments(rows, []);
    // ISS-4790: the WIRE label is the same canonical string the UI renders, so
    // an API consumer of `ActivitySegment.label` names the bucket exactly as the
    // product UI does. A divergent literal in `phaseLabel` fails here.
    expect(segments.find((s) => s.key === "implement")!.label).toBe(
      ACTIVITY_PHASE_LABEL.implement
    );
    expect(segments.find((s) => s.key === IDLE_PHASE_KEY)!.label).toBe(
      ACTIVITY_PHASE_LABEL.idle
    );
    expect(segments.find((s) => s.key === OTHER_PHASE_KEY)!.label).toBe(
      ACTIVITY_PHASE_LABEL.other
    );
    // Only `other` carries the unclassified flag; idle does not.
    expect(
      segments.find((s) => s.key === IDLE_PHASE_KEY)!.isUnclassified
    ).toBeUndefined();
  });

  it("guards against non-finite inputs (NaN timestamps skipped, NaN counts coerced to 0)", () => {
    const rows = [row({ phase: "implement", startMs: 0, endMs: 100 })];
    const events = [
      event(Number.NaN, { costUsd: 99 }), // skipped entirely
      event(50, {
        costUsd: Number.NaN,
        inputTokens: Number.NaN,
        outputTokens: 7,
      }),
    ];
    const segments = buildActivitySegments(rows, events);
    const implement = segments.find((s) => s.key === "implement")!;
    expect(implement.costUsd).toBe(0);
    expect(implement.inputTokens).toBe(0);
    expect(implement.outputTokens).toBe(7);
  });
});

describe("buildActivitySegments — edge cases for internal helpers", () => {
  // -------------------------------------------------------------------
  // clamp01: confidence values outside [0,1] must be clamped.
  // These reach clamp01() via normalizeSpans() which is called per-row.
  // -------------------------------------------------------------------

  it("clamps NaN confidence to 0 (confidenceWeight stays 0, confidence is null)", () => {
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100, confidence: Number.NaN }),
    ];
    const segments = buildActivitySegments(rows, []);
    const plan = segments.find((s) => s.key === "plan")!;
    // clamp01(NaN) → 0; with 0 confidence the weighted-mean denominator is
    // still non-zero (durationMs = 100 > 0), so weightedConfidence = 0×100 = 0
    // and confidence = 0/100 = 0 (not null).
    expect(plan.confidence).toBe(0);
    expect(plan.durationMs).toBe(100);
  });

  it("clamps a negative confidence to 0", () => {
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100, confidence: -0.5 }),
    ];
    const segments = buildActivitySegments(rows, []);
    const plan = segments.find((s) => s.key === "plan")!;
    expect(plan.confidence).toBe(0);
  });

  it("clamps a confidence above 1 to 1", () => {
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100, confidence: 1.5 }),
    ];
    const segments = buildActivitySegments(rows, []);
    const plan = segments.find((s) => s.key === "plan")!;
    expect(plan.confidence).toBe(1);
  });

  // -------------------------------------------------------------------
  // Zero-duration row: confidence is null rather than 0 or 0.8.
  //
  // This pins the `confidenceWeight > 0 ? weighted / weight : null` ternary
  // ONLY. It deliberately does not claim the `span.durationMs > 0` guard: a
  // zero-duration row contributes `0.8 x 0 = 0` to the numerator and `0` to the
  // denominator, so forcing that guard true leaves confidenceWeight at 0 and the
  // result at null. No input can distinguish that guard's arms here.
  // -------------------------------------------------------------------

  it("produces null confidence for a row whose startMs equals endMs (zero duration)", () => {
    const rows = [
      row({ phase: "plan", startMs: 100, endMs: 100, confidence: 0.8 }),
    ];
    const segments = buildActivitySegments(rows, []);
    const plan = segments.find((s) => s.key === "plan")!;
    expect(plan.durationMs).toBe(0);
    // null, not 0 and not 0.8 — negating the ternary yields NaN here.
    expect(plan.confidence).toBeNull();
  });

  // -------------------------------------------------------------------
  // normalizeSpans: a non-array evidenceLayers must be treated as [].
  // -------------------------------------------------------------------

  it("treats a non-array evidenceLayers as empty (no source, no declared flag)", () => {
    // Force null into the typed field to exercise the Array.isArray guard.
    const evidenceLayers: string[] = null as any;
    const rows = [
      row({ phase: "plan", startMs: 0, endMs: 100, evidenceLayers }),
    ];
    const segments = buildActivitySegments(rows, []);
    const plan = segments.find((s) => s.key === "plan")!;
    // Empty evidence → hasEvidence = false → source = null.
    expect(plan.source).toBeNull();
  });

  // -------------------------------------------------------------------
  // byChronology: when two phases share the same minStartMs the sort
  // falls back to lexicographic key order.
  // -------------------------------------------------------------------

  it("sorts phases with equal earliest start by phase key alphabetically", () => {
    const rows = [
      row({ phase: "z-phase", startMs: 0, endMs: 50 }),
      row({ phase: "a-phase", startMs: 0, endMs: 50 }),
      row({ phase: "m-phase", startMs: 0, endMs: 50 }),
    ];
    const segments = buildActivitySegments(rows, []);
    // All three have minStartMs = 0 → byChronology resolves by key string.
    expect(segments.map((s) => s.key)).toEqual([
      "a-phase",
      "m-phase",
      "z-phase",
    ]);
  });

  // -------------------------------------------------------------------
  // phaseLabel: a key whose labelize() returns "" (only separators)
  // must fall back to UNKNOWN_ACTIVITY_PHASE_LABEL, not an empty string.
  // -------------------------------------------------------------------

  it("labels a separator-only phase key with the canonical unknown label", () => {
    // "-" splits on [-_:] to [] → labelize returns "" (falsy)
    const rows = [row({ phase: "-", startMs: 0, endMs: 100 })];
    const segments = buildActivitySegments(rows, []);
    const seg = segments.find((s) => s.key === "-")!;
    expect(seg.label).toBe(UNKNOWN_ACTIVITY_PHASE_LABEL);
  });

  it("titleizes a novel phase key through labelize when not in the canonical map", () => {
    const rows = [row({ phase: "auto_review", startMs: 0, endMs: 100 })];
    const segments = buildActivitySegments(rows, []);
    const seg = segments.find((s) => s.key === "auto_review")!;
    // "auto_review" → labelize → "Auto Review"
    expect(seg.label).toBe("Auto Review");
  });
});

describe("toActivitySegmentTokenEvents", () => {
  function syncedEvent(
    overrides: Partial<SyncedAgentSessionTokenEvent> = {}
  ): SyncedAgentSessionTokenEvent {
    return {
      externalEventId: "e1",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      estimatedCostUsd: 0.25,
      createdAt: "2026-05-20T00:30:00.000Z",
      ...overrides,
    };
  }

  it("maps synced token events onto the aggregation input shape", () => {
    const [mapped] = toActivitySegmentTokenEvents([syncedEvent()]);
    expect(mapped).toEqual({
      tMs: Date.parse("2026-05-20T00:30:00.000Z"),
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    });
  });

  it("defaults a missing cost to 0 and lets buildActivitySegments skip an unparsable timestamp", () => {
    const mapped = toActivitySegmentTokenEvents([
      syncedEvent({ estimatedCostUsd: undefined }),
      syncedEvent({ createdAt: "not-a-date" }),
    ]);
    expect(mapped[0]!.costUsd).toBe(0);
    expect(Number.isNaN(mapped[1]!.tMs)).toBe(true);
    // The NaN-timestamp event is dropped by the aggregator's finite guard.
    const rows: SyncedActivitySegmentRow[] = [
      row({ phase: "implement", startMs: 0, endMs: 10 ** 13 }),
    ];
    const segments = buildActivitySegments(rows, mapped);
    // Only the first event (cost 0, but valid ts) lands; second is skipped.
    expect(segments.find((s) => s.key === "implement")!.inputTokens).toBe(100);
  });
});
