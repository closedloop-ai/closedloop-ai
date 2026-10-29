import {
  BranchTraceCompletenessState,
  type BranchTraceSessionHydration,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
} from "@repo/api/src/types/branch-trace";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import {
  MAX_TIMELINE_DAYS,
  type TimelineColumn,
  type TimelineSegment,
  type TimelineSessionIdentity,
} from "../../lib/branch-session-buckets";
import { formatClock } from "../../lib/branch-timeline-range";
import {
  buildTimelineLegend,
  detailForLoadedTimelineSessions,
  formatTimelineBarLabel,
  formatTimelineCompletenessDisclosure,
  formatTimelineEvidenceValue,
  formatTimelineSegmentCost,
  formatTimelineTokens,
  resolveTimelineCostEvidence,
  resolveTimelineNoBarsMessage,
  resolveTimelineTraceEvidence,
  TIMELINE_TOKEN_PARTS,
  TimelineTraceEvidence,
  timelineBarHeightPercent,
} from "../branch-pr-activity-timeline-helpers";

function makeTraceState(
  overrides: Partial<BranchTraceState> = {}
): BranchTraceState {
  return {
    sessions: [],
    qualifyingSessionCount: 0,
    completeness: { state: BranchTraceCompletenessState.Complete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    ...overrides,
  };
}

function loadedSessionIdentity(
  artifactId: string
): BranchTraceSessionHydration {
  return {
    identity: {
      artifactId,
      name: null,
      slug: null,
      navigableRef: artifactId,
    },
    state: BranchTraceSessionHydrationState.Loaded,
  };
}

function makeSegment(
  overrides: Partial<TimelineSegment> = {}
): TimelineSegment {
  return {
    key: "seg",
    label: "Avery",
    owner: "Avery",
    value: 0,
    input: 0,
    output: 0,
    cache: 0,
    color: "var(--chart-2)",
    costUnavailable: false,
    hasKnownCost: true,
    ...overrides,
  };
}

function makeColumn(overrides: Partial<TimelineColumn> = {}): TimelineColumn {
  return {
    hourStart: "2026-06-10T14:00:00.000Z",
    total: 0,
    segments: [],
    isGap: false,
    hasConcurrency: false,
    ...overrides,
  };
}

function sessionIdentity(
  overrides: Partial<TimelineSessionIdentity>
): TimelineSessionIdentity {
  return {
    name: null,
    slug: null,
    navigableRef: "",
    sessionId: "sess",
    ...overrides,
  };
}

describe("detailForLoadedTimelineSessions", () => {
  it("returns the detail unchanged when no trace state reached the component", () => {
    const detail = makeBranchDetail({
      sessions: [makeBranchSession({ sessionId: "s1" })],
    });
    expect(detailForLoadedTimelineSessions(detail, undefined)).toBe(detail);
    expect(detailForLoadedTimelineSessions(detail, null)).toBe(detail);
  });

  it("preserves the branch's own totals when every source session loaded and an authoritative cost exists", () => {
    const session = makeBranchSession({
      sessionId: "s1",
      evenSplitCostUsd: 10,
    });
    const detail = makeBranchDetail({
      sessions: [session],
      estimatedCostUsd: 99,
      attributedCostUsd: 42,
    });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });
    const result = detailForLoadedTimelineSessions(detail, traceState);
    expect(result.estimatedCostUsd).toBe(99);
    expect(result.attributedCostUsd).toBe(42);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("falls back to the loaded subtotal for both totals when a source session did not load", () => {
    const s1 = makeBranchSession({ sessionId: "s1", evenSplitCostUsd: 10 });
    const s2 = makeBranchSession({ sessionId: "s2", evenSplitCostUsd: 20 });
    const detail = makeBranchDetail({
      sessions: [s1, s2],
      estimatedCostUsd: 999,
      attributedCostUsd: 5,
    });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });
    const result = detailForLoadedTimelineSessions(detail, traceState);
    expect(result.estimatedCostUsd).toBe(10);
    expect(result.attributedCostUsd).toBe(10);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("keeps an authoritative exact-zero attributed cost at zero even though loaded evidence is nonzero", () => {
    // resolveLoadedAttributedCost checks `attributedCostUsd === 0` BEFORE
    // falling back to the loaded subtotal, so a branch the server priced at
    // exactly $0 stays $0 here even though its one loaded session carries a
    // nonzero even-split share. Only estimatedCostUsd (the chartable total)
    // takes the loaded subtotal in this case.
    const s1 = makeBranchSession({ sessionId: "s1", evenSplitCostUsd: 10 });
    const s2 = makeBranchSession({ sessionId: "s2", evenSplitCostUsd: 20 });
    const detail = makeBranchDetail({
      sessions: [s1, s2],
      attributedCostUsd: 0,
    });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });
    const result = detailForLoadedTimelineSessions(detail, traceState);
    expect(result.estimatedCostUsd).toBe(10);
    expect(result.attributedCostUsd).toBe(0);
  });

  it("keeps a null attributed cost null, and zeroes the chartable subtotal too", () => {
    const s1 = makeBranchSession({ sessionId: "s1", evenSplitCostUsd: 10 });
    const s2 = makeBranchSession({ sessionId: "s2", evenSplitCostUsd: 20 });
    const detail = makeBranchDetail({
      sessions: [s1, s2],
      attributedCostUsd: null,
    });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });
    const result = detailForLoadedTimelineSessions(detail, traceState);
    expect(result.attributedCostUsd).toBeNull();
    // A null attributedCostUsd marks the branch cost unavailable, which zeroes
    // every session's resolved share regardless of its own even-split cost.
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("omits attributedCostUsd entirely when the source detail never set it", () => {
    const s1 = makeBranchSession({ sessionId: "s1", evenSplitCostUsd: 10 });
    const detail = makeBranchDetail({ sessions: [s1] });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });
    const result = detailForLoadedTimelineSessions(detail, traceState);
    expect(Object.hasOwn(result, "attributedCostUsd")).toBe(false);
    expect(result.estimatedCostUsd).toBe(10);
  });

  it("requireKnownLoadedCost demands cost evidence on every loaded row, else null instead of a fabricated zero", () => {
    const s1 = makeBranchSession({
      sessionId: "s1",
      evenSplitCostUsd: null,
      estimatedCostUsd: null,
    });
    const s2 = makeBranchSession({ sessionId: "s2", evenSplitCostUsd: 20 });
    const detail = makeBranchDetail({
      sessions: [s1, s2],
      attributedCostUsd: 7,
    });
    const traceState = makeTraceState({
      sessions: [loadedSessionIdentity("s1")],
    });

    const permissive = detailForLoadedTimelineSessions(detail, traceState);
    expect(permissive.estimatedCostUsd).toBe(0);

    const strict = detailForLoadedTimelineSessions(detail, traceState, {
      requireKnownLoadedCost: true,
    });
    expect(strict.estimatedCostUsd).toBeNull();
  });
});

describe("formatTimelineEvidenceValue", () => {
  it("renders Unavailable when the trace evidence claim is unavailable", () => {
    expect(
      formatTimelineEvidenceValue("$5.00", TimelineTraceEvidence.Unavailable)
    ).toBe("Unavailable");
  });

  it("renders Unavailable when local evidence marks it unavailable, even on complete trace evidence", () => {
    expect(
      formatTimelineEvidenceValue("$5.00", TimelineTraceEvidence.Complete, {
        unavailable: true,
      })
    ).toBe("Unavailable");
  });

  it("marks an incomplete trace-evidence value with an asterisk", () => {
    expect(
      formatTimelineEvidenceValue("$5.00", TimelineTraceEvidence.Incomplete)
    ).toBe("$5.00*");
  });

  it("does not mark the empty-value placeholder even when evidence is incomplete", () => {
    expect(
      formatTimelineEvidenceValue("—", TimelineTraceEvidence.Incomplete)
    ).toBe("—");
  });

  it("marks a value via local incomplete evidence on otherwise complete trace evidence", () => {
    expect(
      formatTimelineEvidenceValue("$3.00", TimelineTraceEvidence.Complete, {
        incomplete: true,
      })
    ).toBe("$3.00*");
  });

  it("leaves the value untouched for complete evidence with no local override", () => {
    expect(
      formatTimelineEvidenceValue("$3.00", TimelineTraceEvidence.Complete)
    ).toBe("$3.00");
  });

  it("leaves the value untouched when evidence is missing and no local override applies", () => {
    expect(
      formatTimelineEvidenceValue("$3.00", TimelineTraceEvidence.Missing)
    ).toBe("$3.00");
  });
});

describe("formatTimelineCompletenessDisclosure", () => {
  it("returns null when nothing was omitted and no fallback reason applies", () => {
    expect(formatTimelineCompletenessDisclosure([], [])).toBeNull();
  });

  it("names non-bucketable sessions and appends the cost/duration caveat", () => {
    const session = sessionIdentity({ sessionId: "sess-1" });
    expect(formatTimelineCompletenessDisclosure([session], [])).toBe(
      "* Timing is unavailable for sess-1. Cost and duration include only rendered activity with timing data."
    );
  });

  it("names truncated sessions using the actual MAX_TIMELINE_DAYS cap", () => {
    const session = sessionIdentity({ sessionId: "sess-2" });
    expect(formatTimelineCompletenessDisclosure([], [session])).toBe(
      `* The ${MAX_TIMELINE_DAYS}-day timeline limit omits later activity for sess-2. Cost and duration include only rendered activity with timing data.`
    );
  });

  it("joins multiple sessions per sentence and states the cost caveat once", () => {
    const nonBucketable = [
      sessionIdentity({ sessionId: "a" }),
      sessionIdentity({ sessionId: "b" }),
    ];
    const truncated = [sessionIdentity({ sessionId: "c" })];
    expect(formatTimelineCompletenessDisclosure(nonBucketable, truncated)).toBe(
      `* Timing is unavailable for a, b. The ${MAX_TIMELINE_DAYS}-day timeline limit omits later activity for c. Cost and duration include only rendered activity with timing data.`
    );
  });

  it("prefers slug, then name, then navigableRef, then sessionId for the label", () => {
    const bySlug = sessionIdentity({
      sessionId: "id",
      slug: "SES-1",
      name: "Name",
      navigableRef: "ref",
    });
    const byName = sessionIdentity({
      sessionId: "id",
      slug: "  ",
      name: "Name",
      navigableRef: "ref",
    });
    const byRef = sessionIdentity({
      sessionId: "id",
      slug: "  ",
      name: "  ",
      navigableRef: "ref",
    });
    const byId = sessionIdentity({
      sessionId: "id",
      slug: "  ",
      name: "  ",
      navigableRef: "  ",
    });
    expect(formatTimelineCompletenessDisclosure([bySlug], [])).toContain(
      "SES-1"
    );
    expect(formatTimelineCompletenessDisclosure([byName], [])).toContain(
      "Name"
    );
    expect(formatTimelineCompletenessDisclosure([byRef], [])).toContain("ref");
    expect(formatTimelineCompletenessDisclosure([byId], [])).toContain("id");
  });

  it("discloses an unpriced-branch fallback with its own sentence", () => {
    expect(
      formatTimelineCompletenessDisclosure([], [], { unpricedBranch: true })
    ).toBe(
      "* This branch has no attributed cost of its own, so the total shown is the spend charted above."
    );
  });

  it("discloses incomplete aggregate trace evidence with its own sentence", () => {
    expect(
      formatTimelineCompletenessDisclosure([], [], {
        incompleteTraceEvidence: true,
      })
    ).toBe(
      "* Some Session trace evidence could not be loaded, so these figures cover only the evidence that loaded."
    );
  });

  it("orders session sentences, the cost caveat, then the two fallback sentences", () => {
    const session = sessionIdentity({ sessionId: "sess-1" });
    expect(
      formatTimelineCompletenessDisclosure([session], [], {
        incompleteTraceEvidence: true,
        unpricedBranch: true,
      })
    ).toBe(
      "* Timing is unavailable for sess-1. Cost and duration include only rendered activity with timing data. Some Session trace evidence could not be loaded, so these figures cover only the evidence that loaded. This branch has no attributed cost of its own, so the total shown is the spend charted above."
    );
  });
});

describe("resolveTimelineNoBarsMessage", () => {
  it("explains unavailable session timing when no bucketable session exists but sources did", () => {
    expect(
      resolveTimelineNoBarsMessage({
        columnCount: 0,
        sourceSessionCount: 3,
        sessionCount: 0,
        traceCompleteness: BranchTraceCompletenessState.Unavailable,
      })
    ).toBe("Session timing is unavailable, so spend can't be charted by hour.");
  });

  it("takes the unavailable-timing message even when columns rendered, if the trigger conditions hold", () => {
    // sourceSessionCount/traceCompleteness gate this branch independently of
    // columnCount; a nonzero columnCount does not fall through to `null`.
    expect(
      resolveTimelineNoBarsMessage({
        columnCount: 3,
        sourceSessionCount: 3,
        sessionCount: 0,
        traceCompleteness: BranchTraceCompletenessState.Unavailable,
      })
    ).toBe("Session timing is unavailable, so spend can't be charted by hour.");
  });

  it("does not use the unavailable-timing message when traceCompleteness is not Unavailable", () => {
    expect(
      resolveTimelineNoBarsMessage({
        columnCount: 0,
        sourceSessionCount: 3,
        sessionCount: 0,
        traceCompleteness: BranchTraceCompletenessState.Complete,
      })
    ).toBe(
      "0 sessions ran on this branch, but their timing has no measurable duration, so spend can't be charted by hour."
    );
  });

  it("pluralizes the no-measurable-duration message for one session", () => {
    expect(
      resolveTimelineNoBarsMessage({ columnCount: 0, sessionCount: 1 })
    ).toBe(
      "1 session ran on this branch, but their timing has no measurable duration, so spend can't be charted by hour."
    );
  });

  it("pluralizes the no-measurable-duration message for multiple sessions", () => {
    expect(
      resolveTimelineNoBarsMessage({ columnCount: 0, sessionCount: 2 })
    ).toBe(
      "2 sessions ran on this branch, but their timing has no measurable duration, so spend can't be charted by hour."
    );
  });

  it("returns null once at least one column rendered and the unavailable-timing gate does not apply", () => {
    expect(
      resolveTimelineNoBarsMessage({ columnCount: 1, sessionCount: 2 })
    ).toBeNull();
  });
});

describe("timelineBarHeightPercent", () => {
  it("is 0 for a gap column regardless of total", () => {
    expect(
      timelineBarHeightPercent(makeColumn({ isGap: true, total: 50 }), 100)
    ).toBe(0);
  });

  it("floors at the minimum bar percent when total is non-positive", () => {
    expect(timelineBarHeightPercent(makeColumn({ total: 0 }), 100)).toBe(8);
  });

  it("floors at the minimum bar percent when maxTotal is non-positive", () => {
    expect(timelineBarHeightPercent(makeColumn({ total: 50 }), 0)).toBe(8);
  });

  it("reaches 100 when total equals maxTotal", () => {
    expect(timelineBarHeightPercent(makeColumn({ total: 100 }), 100)).toBe(100);
  });

  it("scales by a sqrt ratio between the floor and 100", () => {
    expect(timelineBarHeightPercent(makeColumn({ total: 25 }), 100)).toBe(50);
  });

  it("clamps a very small sqrt-scaled ratio up to the minimum bar percent", () => {
    expect(timelineBarHeightPercent(makeColumn({ total: 1 }), 10_000)).toBe(8);
  });
});

describe("formatTimelineTokens (smoke — see branch-timeline-tokens.test.ts for the full ladder)", () => {
  it("keeps a dash for zero and NaN", () => {
    expect(formatTimelineTokens(0)).toBe("—");
    expect(formatTimelineTokens(Number.NaN)).toBe("—");
  });

  it("compacts a plain positive count", () => {
    expect(formatTimelineTokens(2500)).toBe("2.5k");
  });
});

describe("formatTimelineBarLabel", () => {
  it("renders an idle gap column without a cost breakdown", () => {
    const column = makeColumn({ isGap: true });
    const when = formatClock(Date.parse(column.hourStart));
    expect(formatTimelineBarLabel(column)).toBe(`${when} · idle`);
  });

  it("renders the total cost and a per-segment breakdown", () => {
    const column = makeColumn({
      total: 12.5,
      segments: [
        makeSegment({ label: "Avery", value: 10 }),
        makeSegment({ label: "Sam", value: 2.5 }),
      ],
    });
    const when = formatClock(Date.parse(column.hourStart));
    expect(formatTimelineBarLabel(column)).toBe(
      `${when} · $12.50 · Avery $10.00 · Sam $2.50`
    );
  });
});

describe("formatTimelineSegmentCost", () => {
  it("shows the plain cost when not marked unavailable", () => {
    expect(
      formatTimelineSegmentCost({ costUnavailable: false, value: 5 })
    ).toBe("$5.00");
  });

  it("marks a positive unavailable-cost value with an asterisk", () => {
    expect(formatTimelineSegmentCost({ costUnavailable: true, value: 5 })).toBe(
      "$5.00*"
    );
  });

  it("renders Unavailable for a zero unavailable-cost value", () => {
    expect(formatTimelineSegmentCost({ costUnavailable: true, value: 0 })).toBe(
      "Unavailable"
    );
  });

  it("renders Unavailable for a negative unavailable-cost value", () => {
    expect(
      formatTimelineSegmentCost({ costUnavailable: true, value: -5 })
    ).toBe("Unavailable");
  });
});

describe("buildTimelineLegend", () => {
  it("returns an empty legend for no columns", () => {
    expect(buildTimelineLegend([])).toEqual([]);
  });

  it("sums a segment's value across columns by key", () => {
    const columns = [
      makeColumn({
        segments: [
          makeSegment({ key: "a", label: "Avery", value: 5, color: "c1" }),
        ],
      }),
      makeColumn({
        segments: [
          makeSegment({ key: "a", label: "Avery", value: 3, color: "c1" }),
        ],
      }),
    ];
    expect(buildTimelineLegend(columns)).toEqual([
      { key: "a", label: "Avery", color: "c1", total: 8 },
    ]);
  });

  it("sorts by descending total, then label alphabetically on a tie", () => {
    const columns = [
      makeColumn({
        segments: [
          makeSegment({ key: "b", label: "Bravo", value: 5, color: "c2" }),
          makeSegment({ key: "a", label: "Alpha", value: 10, color: "c1" }),
          makeSegment({ key: "c", label: "Charlie", value: 5, color: "c3" }),
        ],
      }),
    ];
    expect(buildTimelineLegend(columns).map((entry) => entry.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("resolveTimelineTraceEvidence", () => {
  it("is Missing when no trace state reached the component", () => {
    expect(resolveTimelineTraceEvidence(undefined)).toBe(
      TimelineTraceEvidence.Missing
    );
    expect(resolveTimelineTraceEvidence(null)).toBe(
      TimelineTraceEvidence.Missing
    );
  });

  it("reads the aggregate completeness state directly", () => {
    const traceState = makeTraceState({
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Incomplete,
      },
    });
    expect(resolveTimelineTraceEvidence(traceState)).toBe(
      TimelineTraceEvidence.Incomplete
    );
  });
});

describe("TimelineTraceEvidence", () => {
  it("reuses BranchTraceCompletenessState's three values", () => {
    expect(TimelineTraceEvidence.Complete).toBe(
      BranchTraceCompletenessState.Complete
    );
    expect(TimelineTraceEvidence.Incomplete).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(TimelineTraceEvidence.Unavailable).toBe(
      BranchTraceCompletenessState.Unavailable
    );
  });

  it("adds Missing as the fourth state the trace contract cannot express", () => {
    expect(TimelineTraceEvidence.Missing).toBe("missing");
  });
});

describe("TIMELINE_TOKEN_PARTS", () => {
  it("lists input, output, and cache read in that order", () => {
    expect(TIMELINE_TOKEN_PARTS.map((part) => part.key)).toEqual([
      "input",
      "output",
      "cache",
    ]);
  });
});

describe("resolveTimelineCostEvidence", () => {
  it("with the gate off: a priced branch reports its own authoritative cost", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: false,
        chartableCostUsd: 50,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 100,
      evidenceMissing: false,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("with the gate off: an unpriced branch falls back to chartable cost WITHOUT a marker (historical shipped behavior)", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        sourceCostUnpriced: false,
        chartableCostUsd: 50,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 50,
      evidenceMissing: false,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("with the gate off: incomplete timing falls back to chartable cost and marks incomplete", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: false,
        chartableCostUsd: 50,
        timingIncomplete: true,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 50,
      evidenceMissing: false,
      incomplete: true,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("with the gate on and evidence Missing: short-circuits to evidenceMissing without any other marker", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        sourceCostUnpriced: false,
        chartableCostUsd: 30,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Missing,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: 30,
      evidenceMissing: true,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("with the gate on: an unpriced branch with a chartable figure discloses the unpriced-branch fallback", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        sourceCostUnpriced: false,
        chartableCostUsd: 40,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: 40,
      evidenceMissing: false,
      incomplete: true,
      unpricedBranchFallback: true,
      incompleteTraceEvidence: false,
    });
  });

  it("with the gate on: an unpriced branch with NO chartable figure does not claim a spend it cannot show", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: null,
        sourceCostUnpriced: false,
        chartableCostUsd: null,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: null,
      evidenceMissing: false,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("sourceCostUnpriced is ignored while the gate is off", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: true,
        chartableCostUsd: 20,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
      })
    ).toEqual({
      value: 100,
      evidenceMissing: false,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });

  it("sourceCostUnpriced takes effect once the gate is on", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: true,
        chartableCostUsd: 20,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Complete,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: 20,
      evidenceMissing: false,
      incomplete: true,
      unpricedBranchFallback: true,
      incompleteTraceEvidence: false,
    });
  });

  it("incomplete aggregate trace evidence marks the figure even while it stays authoritative", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: false,
        chartableCostUsd: 20,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Incomplete,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: 100,
      evidenceMissing: false,
      incomplete: true,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: true,
    });
  });

  it("an unavailable (but not missing) trace evidence state triggers no marker on its own", () => {
    expect(
      resolveTimelineCostEvidence({
        authoritativeCostUsd: 100,
        sourceCostUnpriced: false,
        chartableCostUsd: 20,
        timingIncomplete: false,
        traceEvidence: TimelineTraceEvidence.Unavailable,
        discloseFallbackReasons: true,
      })
    ).toEqual({
      value: 100,
      evidenceMissing: false,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    });
  });
});
