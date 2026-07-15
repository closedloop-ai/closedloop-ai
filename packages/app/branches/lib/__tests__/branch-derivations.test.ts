import { BranchPhase, type MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail as dDetail,
  makeBranchSession as dSession,
} from "../../__tests__/branch-fixtures";
import {
  activeIdleSpans,
  type BranchTokenRow,
  buildVsReworkSplit,
  costPerBranch,
  costPerSession,
  leadTimeForChange,
  leadTimeWaterfallSegments,
  locPerDollar,
  locPerDollarBaseline30d,
  medianPrSize,
  type PhaseSegment,
  partitionBuildVsRework,
  perHourPerActorBuckets,
  projectBranchUsageSummary,
  reconcilePhaseSegments,
  resolveBranchPhase,
} from "../branch-derivations";

// Priced cost = inputTokens + outputTokens for every model EXCEPT "unpriced",
// which the library "drops" (reason set). Cost is linear in tokens, matching the
// real genai-prices behavior the derivations rely on.
vi.mock("@closedloop-ai/loops-api/genai-cost", () => ({
  computeTokenCost: vi.fn(
    (input: { model: string; inputTokens: number; outputTokens: number }) => {
      if (input.model === "unpriced") {
        return {
          priced: false,
          provider: null,
          costUsd: null,
          inputCostUsd: null,
          outputCostUsd: null,
          reason: "unknown_model",
        };
      }
      return {
        priced: true,
        provider: "test",
        costUsd: input.inputTokens + input.outputTokens,
        inputCostUsd: input.inputTokens,
        outputCostUsd: input.outputTokens,
        reason: null,
      };
    }
  ),
}));

function row(overrides: Partial<BranchTokenRow> = {}): BranchTokenRow {
  return {
    sessionId: "s1",
    owner: "alice",
    model: "claude",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("costPerSession / costPerBranch", () => {
  it("sums priced (session,model) groups and drops unpriced models", () => {
    const rows = [
      row({
        sessionId: "s1",
        model: "claude",
        inputTokens: 10,
        outputTokens: 1,
      }),
      row({
        sessionId: "s1",
        model: "claude",
        inputTokens: 20,
        outputTokens: 2,
      }),
      row({
        sessionId: "s1",
        model: "unpriced",
        inputTokens: 99,
        outputTokens: 9,
      }),
    ];
    // (s1,claude): input 30 + output 3 = 33; unpriced dropped.
    expect(costPerSession(rows)).toBe(33);
    expect(costPerBranch(rows)).toBe(33);
  });

  it("returns null when every row is unpriced", () => {
    const rows = [row({ model: "unpriced", inputTokens: 5, outputTokens: 5 })];
    expect(costPerSession(rows)).toBeNull();
    expect(costPerBranch(rows)).toBeNull();
  });

  it("returns null for an empty corpus", () => {
    expect(costPerSession([])).toBeNull();
    expect(costPerBranch([])).toBeNull();
  });
});

describe("locPerDollar / locPerDollarBaseline30d", () => {
  it("returns null on null LOC, null cost, or zero cost (never 0)", () => {
    expect(locPerDollar({ netLoc: null, totalCostUsd: 10 })).toBeNull();
    expect(locPerDollar({ netLoc: 100, totalCostUsd: null })).toBeNull();
    expect(locPerDollar({ netLoc: 100, totalCostUsd: 0 })).toBeNull();
    expect(locPerDollar({ netLoc: 100, totalCostUsd: 25 })).toBe(4);
  });

  it("aggregates the window then divides; null when no LOC or zero cost", () => {
    expect(
      locPerDollarBaseline30d([
        { netLoc: 100, totalCostUsd: 10 },
        { netLoc: 50, totalCostUsd: 15 },
      ])
    ).toBe(6); // 150 / 25
    expect(
      locPerDollarBaseline30d([{ netLoc: null, totalCostUsd: 10 }])
    ).toBeNull();
    expect(locPerDollarBaseline30d([])).toBeNull();
  });
});

describe("leadTimeForChange", () => {
  it("returns the ms delta, or null for missing/negative inputs", () => {
    expect(
      leadTimeForChange({
        firstCommitAt: "2026-06-17T00:00:00.000Z",
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBe(3_600_000);
    expect(
      leadTimeForChange({
        firstCommitAt: null,
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBeNull();
    expect(
      leadTimeForChange({
        firstCommitAt: "2026-06-17T02:00:00.000Z",
        mergedAt: "2026-06-17T01:00:00.000Z",
      })
    ).toBeNull(); // negative (clock skew)
  });
});

describe("medianPrSize", () => {
  it("includes only merged single-PR branches with both LOC fields", () => {
    const branches = [
      { additions: 10, deletions: 10, status: "merged", multiPrWarning: false }, // 20
      { additions: 30, deletions: 10, status: "merged", multiPrWarning: false }, // 40
      { additions: 90, deletions: 10, status: "merged", multiPrWarning: false }, // 100
      { additions: 5, deletions: 5, status: "open", multiPrWarning: false }, // excluded (open)
      { additions: 5, deletions: 5, status: "merged", multiPrWarning: true }, // excluded (multi-PR)
      {
        additions: null,
        deletions: 5,
        status: "merged",
        multiPrWarning: false,
      }, // excluded (additions null — either missing LOC field excludes the row)
    ];
    expect(medianPrSize(branches)).toBe(40); // median of [20,40,100]
  });

  it("returns null when none qualify", () => {
    expect(
      medianPrSize([
        { additions: 5, deletions: 5, status: "open", multiPrWarning: false },
      ])
    ).toBeNull();
  });
});

describe("activeIdleSpans", () => {
  const base = Date.parse("2026-06-17T00:00:00.000Z");
  const at = (ms: number): string => new Date(base + ms).toISOString();
  const items: MergedTraceItem[] = [
    {
      type: "prompt",
      sessionId: "s1",
      t: at(0),
      tMs: 0,
      cumCostUsd: null,
      actorName: "alice",
      text: "a",
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(60_000),
      tMs: 60_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "b",
    },
    {
      type: "say",
      sessionId: "s1",
      t: at(300_000),
      tMs: 300_000,
      cumCostUsd: null,
      actorName: "alice",
      text: "c",
    },
    { type: "end", sessionId: "s1", text: "done" },
  ];

  it("splits active vs idle at the default 120s threshold", () => {
    const result = activeIdleSpans(items);
    expect(result.activeMs).toBe(60_000); // 0 -> 60s active
    expect(result.idleMs).toBe(240_000); // 60s -> 300s idle (240s gap)
    expect(result.idleSpans).toEqual([
      { startT: at(60_000), endT: at(300_000), gapMs: 240_000 },
    ]);
  });

  it("honors a custom idle threshold", () => {
    const result = activeIdleSpans(items, { idleThresholdMs: 30_000 });
    // Now the 60s gap is also idle.
    expect(result.idleSpans).toHaveLength(2);
    expect(result.activeMs).toBe(0);
    expect(result.idleMs).toBe(300_000);
  });
});

describe("perHourPerActorBuckets", () => {
  it("groups by hour then actor, folds null owner into 'unattributed', sums tokens + cost", () => {
    const rows = [
      row({
        hourStart: "2026-06-17T00:00:00.000Z",
        owner: "alice",
        inputTokens: 10,
        outputTokens: 1,
      }),
      row({
        hourStart: "2026-06-17T00:00:00.000Z",
        owner: "alice",
        inputTokens: 5,
        outputTokens: 0,
      }),
      row({
        hourStart: "2026-06-17T00:00:00.000Z",
        owner: null,
        inputTokens: 2,
        outputTokens: 2,
      }),
      row({
        hourStart: "2026-06-17T01:00:00.000Z",
        owner: "alice",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ];
    const buckets = perHourPerActorBuckets(rows);
    expect(buckets.map((b) => b.hourStart)).toEqual([
      "2026-06-17T00:00:00.000Z",
      "2026-06-17T01:00:00.000Z",
    ]);
    const hour0 = buckets[0];
    const alice = hour0.byActor.find((a) => a.owner === "alice");
    const unattributed = hour0.byActor.find((a) => a.owner === null);
    expect(alice?.inputTokens).toBe(15);
    expect(alice?.estimatedCostUsd).toBe(16); // 15 input + 1 output
    expect(unattributed?.estimatedCostUsd).toBe(4); // 2 + 2
  });

  it("respects the timeZone option (UTC default vs an explicit zone)", () => {
    const timestamp = new Date("2026-06-17T02:30:00.000Z");
    const utc = perHourPerActorBuckets([
      row({ timestamp, owner: "a", inputTokens: 1 }),
    ]);
    const chicago = perHourPerActorBuckets(
      [row({ timestamp, owner: "a", inputTokens: 1 })],
      { timeZone: "America/Chicago" }
    );
    expect(utc[0].hourStart).toBe("2026-06-17T02:00:00.000Z");
    // 02:30Z is 21:30 the previous day in CDT (UTC-5).
    expect(chicago[0].hourStart).toBe("2026-06-16T21:00:00");
    expect(utc[0].hourStart).not.toBe(chicago[0].hourStart);
  });
});

describe("resolveBranchPhase", () => {
  it("maps canonical values and known SessionPhase-key aliases", () => {
    expect(resolveBranchPhase({ phase: BranchPhase.Rework })).toBe(
      BranchPhase.Rework
    );
    expect(resolveBranchPhase({ phase: "code_review" })).toBe(
      BranchPhase.Review
    );
    expect(resolveBranchPhase({ phase: "coding" })).toBe(BranchPhase.Implement);
    expect(resolveBranchPhase({ phase: "testing" })).toBe(BranchPhase.Verify);
  });

  it("returns null for absent or unknown keys", () => {
    expect(resolveBranchPhase({ phase: null })).toBeNull();
    expect(resolveBranchPhase({})).toBeNull();
    expect(resolveBranchPhase({ phase: "totally-unknown" })).toBeNull();
  });
});

describe("projectBranchUsageSummary", () => {
  const H0 = "2026-06-17T00:00:00.000Z";
  const H1 = "2026-06-17T01:00:00.000Z";
  const rows: BranchTokenRow[] = [
    row({
      sessionId: "s1",
      owner: "alice",
      hourStart: H0,
      billingMode: "subscription",
      phase: BranchPhase.Implement,
      inputTokens: 10,
      outputTokens: 1,
    }),
    row({
      sessionId: "s1",
      owner: "alice",
      hourStart: H0,
      billingMode: "subscription",
      phase: BranchPhase.Implement,
      inputTokens: 20,
      outputTokens: 2,
    }),
    row({
      sessionId: "s2",
      owner: "bob",
      hourStart: H1,
      billingMode: "api",
      phase: BranchPhase.Rework,
      inputTokens: 5,
      outputTokens: 0,
    }),
    row({
      sessionId: "s3",
      owner: null,
      hourStart: H0,
      billingMode: null,
      phase: null,
      inputTokens: 3,
      outputTokens: 3,
    }),
  ];

  it("projects totals, the billing split, hour buckets, phase stacks, and byActor", () => {
    const summary = projectBranchUsageSummary(rows, { branchCount: 3 });
    expect(summary.viewerScope).toBe("self");
    expect(summary.totalBranches).toBe(3);
    expect(summary.totalInputTokens).toBe(38);
    expect(summary.totalOutputTokens).toBe(6);
    expect(summary.totalEstimatedCost).toBe(44); // all "claude": 38 input + 6 output
    expect(summary.subscriptionEstimatedCost).toBe(33); // s1: 30 + 3
    expect(summary.apiEstimatedCost).toBe(5); // s2: 5 + 0 (null-billing s3 in neither split)

    expect(summary.hourBuckets.map((b) => b.hourStart)).toEqual([H0, H1]);
    const h0Alice = summary.hourBuckets[0].byActor.find(
      (a) => a.owner === "alice"
    );
    const h0Unattributed = summary.hourBuckets[0].byActor.find(
      (a) => a.owner === null
    );
    expect(h0Alice?.estimatedCostUsd).toBe(33);
    expect(h0Unattributed?.estimatedCostUsd).toBe(6);

    const implement = summary.phaseStacks.find(
      (p) => p.phase === BranchPhase.Implement
    );
    const rework = summary.phaseStacks.find(
      (p) => p.phase === BranchPhase.Rework
    );
    expect(implement).toMatchObject({
      estimatedCostUsd: 33,
      inputTokens: 30,
      sessionCount: 1,
    });
    expect(rework).toMatchObject({ estimatedCostUsd: 5, sessionCount: 1 });
    // s3 has no resolvable phase -> excluded from phaseStacks.
    expect(summary.phaseStacks).toHaveLength(2);

    expect(summary.byActor.map((a) => a.owner)).toEqual(["alice", "bob", null]);
    expect(
      summary.byActor.find((a) => a.owner === "bob")?.estimatedCostUsd
    ).toBe(5);
  });

  it("projects the empty canonical summary for no rows", () => {
    const summary = projectBranchUsageSummary([]);
    expect(summary).toEqual({
      viewerScope: "self",
      totalBranches: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      apiEstimatedCost: 0,
      hourBuckets: [],
      phaseStacks: [],
      byActor: [],
    });
  });
});

describe("buildVsReworkSplit", () => {
  it("computes the 2-state split (rework = rework + review phases)", () => {
    const rows = [
      row({
        sessionId: "s1",
        phase: BranchPhase.Implement,
        inputTokens: 70,
        outputTokens: 0,
      }),
      row({
        sessionId: "s1",
        phase: BranchPhase.Rework,
        inputTokens: 20,
        outputTokens: 0,
      }),
      row({
        sessionId: "s1",
        phase: BranchPhase.Review,
        inputTokens: 10,
        outputTokens: 0,
      }),
    ];
    // build = 70, rework = 30, total 100.
    expect(buildVsReworkSplit(rows)).toEqual({ buildPct: 70, reworkPct: 30 });
  });

  it("folds unknown phases into Build", () => {
    const rows = [row({ phase: null, inputTokens: 50, outputTokens: 0 })];
    expect(buildVsReworkSplit(rows)).toEqual({ buildPct: 100, reworkPct: 0 });
  });

  it("returns null pcts when nothing prices", () => {
    const rows = [
      row({ model: "unpriced", phase: BranchPhase.Implement, inputTokens: 5 }),
    ];
    expect(buildVsReworkSplit(rows)).toEqual({
      buildPct: null,
      reworkPct: null,
    });
  });
});

describe("partitionBuildVsRework (D3)", () => {
  it("attributes every session to Build; Rework is empty in v1", () => {
    const detail = dDetail({
      sessions: [
        dSession({ sessionId: "s1", estimatedCostUsd: 1, inputTokens: 10 }),
        dSession({ sessionId: "s2", estimatedCostUsd: 2, outputTokens: 5 }),
      ],
    });
    const { build, rework } = partitionBuildVsRework(detail);
    expect(build.costUsd).toBe(3);
    expect(build.sessionCount).toBe(2);
    expect(build.inputTokens).toBe(10);
    expect(build.outputTokens).toBe(5);
    expect(rework.costUsd).toBeNull();
    expect(rework.sessionCount).toBe(0);
  });

  it("netLoc is additions+deletions when both present, else null (never 0)", () => {
    expect(
      partitionBuildVsRework(
        dDetail({ additions: 10, deletions: 5, sessions: [dSession()] })
      ).build.netLoc
    ).toBe(15);
    expect(
      partitionBuildVsRework(dDetail({ sessions: [dSession()] })).build.netLoc
    ).toBeNull();
  });

  it("cost is null (not 0) when no session prices", () => {
    const { build } = partitionBuildVsRework(
      dDetail({ sessions: [dSession({ estimatedCostUsd: null })] })
    );
    expect(build.costUsd).toBeNull();
  });
});

describe("reconcilePhaseSegments (D4)", () => {
  const seg = (key: PhaseSegment["key"], costUsd: number): PhaseSegment => ({
    key,
    label: key,
    costUsd,
    firstRow: null,
  });

  it("null total leaves segments untouched", () => {
    const segments = [seg("build", 5)];
    expect(reconcilePhaseSegments(null, segments)).toBe(segments);
  });

  it("folds a positive remainder into the trailing segment so sum === total", () => {
    const out = reconcilePhaseSegments(10, [seg("build", 4), seg("rework", 1)]);
    expect(out.reduce((s, x) => s + x.costUsd, 0)).toBeCloseTo(10);
    expect(out[1]?.costUsd).toBeCloseTo(6);
  });

  it("scales segments down proportionally when over-attributed", () => {
    const out = reconcilePhaseSegments(5, [seg("build", 6), seg("rework", 4)]);
    expect(out.reduce((s, x) => s + x.costUsd, 0)).toBeCloseTo(5);
    expect(out[0]?.costUsd).toBeCloseTo(3);
    expect(out[1]?.costUsd).toBeCloseTo(2);
  });
});

describe("leadTimeWaterfallSegments (D5)", () => {
  it("anchors on the earliest session start (NOT branch creation) through merge", () => {
    const detail = dDetail({
      lastActivityAt: "2026-06-01T00:00:00.000Z",
      sessions: [
        dSession({ sessionId: "s2", startedAt: "2026-06-10T12:00:00.000Z" }),
        dSession({ sessionId: "s1", startedAt: "2026-06-10T10:00:00.000Z" }),
      ],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const result = leadTimeWaterfallSegments(detail);
    // 10:00 → 13:00 = 3h.
    expect(result.totalMs).toBe(3 * 3_600_000);
    expect(result.mergeUnknown).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.openEnded).toBeUndefined();
  });

  it("open-ended + null total when the branch has not merged", () => {
    const result = leadTimeWaterfallSegments(
      dDetail({ sessions: [dSession()], mergedAt: null })
    );
    expect(result.mergeUnknown).toBe(true);
    expect(result.totalMs).toBeNull();
    expect(result.segments[0]?.openEnded).toBe(true);
  });

  it("totalMs equals the sum of finite segment durations", () => {
    const result = leadTimeWaterfallSegments(
      dDetail({
        sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
        mergedAt: "2026-06-10T11:00:00.000Z",
      })
    );
    const finiteSum = result.segments.reduce(
      (sum, segment) => sum + (segment.durationMs ?? 0),
      0
    );
    expect(result.totalMs).toBe(finiteSum);
  });

  it("flags multiPr from multiPrWarning and empty when no sessions", () => {
    expect(
      leadTimeWaterfallSegments(dDetail({ multiPrWarning: true })).multiPr
    ).toBe(true);
    const empty = leadTimeWaterfallSegments(dDetail({ sessions: [] }));
    expect(empty.segments).toEqual([]);
    expect(empty.totalMs).toBeNull();
  });
});
