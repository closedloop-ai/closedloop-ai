import {
  BranchBillingMode,
  BranchPhase,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  BranchCostCompleteness,
  BranchCostCompletenessReason,
} from "@repo/api/src/types/branch-usage";
import { GitHubPRState } from "@repo/api/src/types/github";
import { TokenCostNotPricedReason } from "@repo/cost/genai-cost";
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
  describeLeadTime,
  isBranchMerged,
  isLeadTimeValueUnavailable,
  LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE,
  LEAD_TIME_PENDING_MESSAGE,
  LeadTimeDisplayStatus,
  leadTimeCardValue,
  leadTimeForChange,
  leadTimeWaterfallSegments,
  locPerDollar,
  locPerDollarBaseline30d,
  medianPrSize,
  type PhaseSegment,
  perHourPerActorBuckets,
  projectBranchUsageSummary,
  reconcilePhaseSegments,
  resolveBranchPhase,
} from "../branch-derivations";
import {
  isLocPerDollarCostUnavailable,
  LOC_MERGED_UNAVAILABLE_MESSAGE,
  LOC_PER_DOLLAR_COST_UNAVAILABLE_MESSAGE,
  LOC_UNAVAILABLE_MESSAGE,
  resolveLocPerDollarUnavailableReason,
} from "../branch-loc-per-dollar";

// Priced cost = inputTokens + outputTokens for every model EXCEPT "unpriced",
// which the library "drops" (reason set). Cost is linear in tokens, matching the
// real genai-prices behavior the derivations rely on.
vi.mock("@repo/cost/genai-cost", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    computeTokenCost: vi.fn(
      (input: { model: string; inputTokens: number; outputTokens: number }) => {
        const invalidCount = !(
          Number.isFinite(input.inputTokens) &&
          Number.isFinite(input.outputTokens)
        );
        if (input.model === "unpriced" || invalidCount) {
          return {
            priced: false,
            provider: null,
            costUsd: null,
            inputCostUsd: null,
            outputCostUsd: null,
            reason: invalidCount
              ? TokenCostNotPricedReason.InvalidCount
              : TokenCostNotPricedReason.UnknownModel,
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
  };
});

const NOT_MERGED_RE = /hasn't merged/i;

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
    expect(locPerDollar({ churn: null, totalCostUsd: 10 })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: null })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: 0 })).toBeNull();
    expect(locPerDollar({ churn: 100, totalCostUsd: 25 })).toBe(4);
  });

  it("aggregates the window then divides; null when no LOC or zero cost", () => {
    expect(
      locPerDollarBaseline30d([
        { churn: 100, totalCostUsd: 10 },
        { churn: 50, totalCostUsd: 15 },
      ])
    ).toBe(6); // 150 / 25
    expect(
      locPerDollarBaseline30d([{ churn: null, totalCostUsd: 10 }])
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
      billingMode: BranchBillingMode.Subscription,
      phase: BranchPhase.Implement,
      inputTokens: 10,
      outputTokens: 1,
    }),
    row({
      sessionId: "s1",
      owner: "alice",
      hourStart: H0,
      billingMode: BranchBillingMode.Subscription,
      phase: BranchPhase.Implement,
      inputTokens: 20,
      outputTokens: 2,
    }),
    row({
      sessionId: "s2",
      owner: "bob",
      hourStart: H1,
      billingMode: BranchBillingMode.Api,
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
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.SourceIdentityUnavailable,
      subtotalUsd: 44,
    });

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
      costCompleteness: {
        completeness: BranchCostCompleteness.Complete,
        subtotalUsd: 0,
        lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
      },
      hourBuckets: [],
      phaseStacks: [],
      byActor: [],
    });
  });

  it("preserves a verified zero as a partial subtotal", () => {
    const summary = projectBranchUsageSummary([
      row({ billingMode: BranchBillingMode.Api }),
    ]);
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.SourceIdentityUnavailable,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    });
  });

  it("marks all-unpriced evidence unavailable without changing legacy zeros", () => {
    const summary = projectBranchUsageSummary([
      row({ model: "unpriced", inputTokens: 5 }),
    ]);
    expect(summary.totalEstimatedCost).toBe(0);
    expect(summary.subscriptionEstimatedCost).toBe(0);
    expect(summary.apiEstimatedCost).toBe(0);
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.SourceIdentityUnavailable,
    });
  });

  it("preserves a clean typed subtotal when a corrupt peer poisons the coarse legacy group", () => {
    const summary = projectBranchUsageSummary([
      row({ sessionId: "clean", inputTokens: 5 }),
      row({ sessionId: "corrupt", inputTokens: Number.POSITIVE_INFINITY }),
    ]);
    expect(summary.totalEstimatedCost).toBe(0);
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 5,
    });
  });

  it("marks a group malformed before opposite-signed rows can cancel", () => {
    const summary = projectBranchUsageSummary([
      row({ sessionId: "canceling", inputTokens: -5 }),
      row({ sessionId: "canceling", inputTokens: 10 }),
      row({ sessionId: "clean", inputTokens: 3 }),
    ]);
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 3,
    });
  });

  it("reconciles classified typed lanes to the known subtotal", () => {
    const summary = projectBranchUsageSummary([
      row({
        sessionId: "subscription",
        billingMode: BranchBillingMode.Subscription,
        inputTokens: 1,
      }),
      row({
        sessionId: "api",
        billingMode: BranchBillingMode.Api,
        inputTokens: 2,
      }),
    ]);
    expect(summary.costCompleteness).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.SourceIdentityUnavailable,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
    expect(summary.subscriptionEstimatedCost).toBe(1);
    expect(summary.apiEstimatedCost).toBe(2);
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

// FEA-2276 removed `partitionBuildVsRework` (the coarse Build/Rework split); its
// replacement, the real per-activity `rollupBranchActivity`, is covered by
// `@repo/lib/branches/activity-rollup.test.ts`. `reconcilePhaseSegments` (retained
// and reused by the new rollup) stays exercised below.
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
      status: BranchStatus.Merged,
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
        status: BranchStatus.Merged,
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

describe("describeLeadTime (FEA-3974 shared framing)", () => {
  it("merged branch → merged status, no empty message", () => {
    const result = describeLeadTime(
      dDetail({
        status: BranchStatus.Merged,
        sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
        mergedAt: "2026-06-10T11:00:00.000Z",
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.Merged);
    expect(result.emptyMessage).toBeNull();
  });

  it("unmerged branch WITH a session → in-progress framing (matches the card's 'In progress', not the pending copy)", () => {
    // No `firstActivityT`, so the D5 track is empty — the exact VQA state where
    // the old section showed "not enough activity" beside an "In progress" card.
    const result = describeLeadTime(
      dDetail({
        sessions: [dSession()],
        mergedAt: null,
        leadTime: {
          firstActivityT: null,
          lastActivityT: null,
          idleSpans: [],
        },
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(result.emptyMessage).not.toBe(LEAD_TIME_PENDING_MESSAGE);
    expect(result.emptyMessage).toMatch(NOT_MERGED_RE);
  });

  it("no session anchor → pending status with the shared pending message", () => {
    const result = describeLeadTime(
      dDetail({
        sessions: [],
        mergedAt: null,
        leadTime: {
          firstActivityT: null,
          lastActivityT: null,
          idleSpans: [],
        },
      })
    );
    expect(result.status).toBe(LeadTimeDisplayStatus.Pending);
    expect(result.emptyMessage).toBe(LEAD_TIME_PENDING_MESSAGE);
  });

  it("pending copy is honest about missing activity, not about merge state", () => {
    // The pending body must NOT claim "hasn't merged" — the cause is no captured
    // activity, and the card (not this copy) carries the in-progress framing.
    expect(LEAD_TIME_PENDING_MESSAGE).not.toMatch(NOT_MERGED_RE);
  });
});

describe("leadTimeCardValue (FEA-3974 shared card value)", () => {
  it("merged → the caller's formatted duration", () => {
    expect(leadTimeCardValue(LeadTimeDisplayStatus.Merged, () => "3h")).toBe(
      "3h"
    );
  });

  it("in-progress → 'In progress' (never the merged duration)", () => {
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.InProgress, () => "3h")
    ).toBe("In progress");
  });

  it("pending → null (no-data), matching the section's empty state", () => {
    // A zero-session branch reads no-data on the card AND "no activity" in the
    // section — never a lone "In progress" beside the empty breakdown (FEA-3974).
    // A nullish value drives MetricCard's muted "No data" glyph (FEA-4236).
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.Pending, () => "3h")
    ).toBeNull();
  });

  it("merged-unavailable → null no-data value (never 'In progress')", () => {
    // A merged branch with no synced merge time can't show a duration, so the
    // card reads no-data and the breakdown carries the honest reason — it must
    // NOT read "In progress", which would contradict the Merged chip.
    expect(
      leadTimeCardValue(LeadTimeDisplayStatus.MergedUnavailable, () => "3h")
    ).toBeNull();
  });
});

describe("isLeadTimeValueUnavailable (FEA-4236 muted no-data value)", () => {
  it("merged-unavailable and pending have no measurable value", () => {
    expect(
      isLeadTimeValueUnavailable(LeadTimeDisplayStatus.MergedUnavailable)
    ).toBe(true);
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.Pending)).toBe(
      true
    );
  });

  it("merged and in-progress DO carry a value (not no-data)", () => {
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.Merged)).toBe(
      false
    );
    expect(isLeadTimeValueUnavailable(LeadTimeDisplayStatus.InProgress)).toBe(
      false
    );
  });
});

describe("resolveLocPerDollarUnavailableReason (FEA-4229/4236 caption SSOT)", () => {
  it("merged branch with no churn → the merged lines-changed sync-gap reason", () => {
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: null,
        totalCostUsd: null,
        merged: true,
      })
    ).toBe(LOC_MERGED_UNAVAILABLE_MESSAGE);
  });

  it("non-merged branch with no churn → the generic lines-changed reason", () => {
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: null,
        totalCostUsd: 4,
        merged: false,
      })
    ).toBe(LOC_UNAVAILABLE_MESSAGE);
  });

  it("churn known but cost missing → the COST reason (never a lines-changed lie)", () => {
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: 42,
        totalCostUsd: null,
        merged: true,
      })
    ).toBe(LOC_PER_DOLLAR_COST_UNAVAILABLE_MESSAGE);
  });

  it("churn known but cost is zero → the COST reason from the raw cost input (never a $0.00 caption)", () => {
    // The resolver owns the zero-cost denominator decision (it takes the raw
    // cost, not a pre-computed boolean), so a priced-$0.00 branch reads the cost
    // gap instead of "N lines changed · $0.00" beneath "No data" — no caller can
    // classify $0.00 wrong.
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: 25,
        totalCostUsd: 0,
        merged: true,
      })
    ).toBe(LOC_PER_DOLLAR_COST_UNAVAILABLE_MESSAGE);
  });

  it("both churn and a usable (positive) cost → no reason (the value is available)", () => {
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: 42,
        totalCostUsd: 3.5,
        merged: true,
      })
    ).toBeNull();
  });

  it("no churn takes precedence over a missing cost (lines-changed gap wins)", () => {
    // Both inputs missing on a merged branch reads as the dominant, VQA-reported
    // lines-changed sync gap, not the cost gap.
    expect(
      resolveLocPerDollarUnavailableReason({
        churn: null,
        totalCostUsd: null,
        merged: true,
      })
    ).toBe(LOC_MERGED_UNAVAILABLE_MESSAGE);
  });
});

describe("isLocPerDollarCostUnavailable (zero denominator mirrors locPerDollar)", () => {
  it("null cost is unavailable", () => {
    expect(isLocPerDollarCostUnavailable(null)).toBe(true);
  });

  it("zero cost is unavailable (no usable denominator)", () => {
    expect(isLocPerDollarCostUnavailable(0)).toBe(true);
  });

  it("a positive cost is available", () => {
    expect(isLocPerDollarCostUnavailable(4.2)).toBe(false);
  });
});

describe("isBranchMerged (FEA-4227 merge signal parity with Properties)", () => {
  it("prState=MERGED reads merged even when mergedAt is null", () => {
    expect(
      isBranchMerged({
        prState: GitHubPRState.Merged,
        status: BranchStatus.Open,
      })
    ).toBe(true);
  });

  it("status=merged reads merged (projected status, same as the chip)", () => {
    expect(isBranchMerged({ prState: null, status: BranchStatus.Merged })).toBe(
      true
    );
  });

  it("open PR with no merged status is not merged", () => {
    expect(
      isBranchMerged({ prState: GitHubPRState.Open, status: BranchStatus.Open })
    ).toBe(false);
  });
});

describe("FEA-4227 merged branch never claims 'hasn't merged yet'", () => {
  // The exact VQA repro: PR is MERGED (prState=MERGED) but the merge instant has
  // not synced (mergedAt=null). The lead-time card/breakdown previously said
  // "In progress" / "hasn't merged yet", contradicting the Merged chip.
  const mergedNoTimestamp = dDetail({
    prState: GitHubPRState.Merged,
    status: BranchStatus.Merged,
    sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
    mergedAt: null,
  });

  it("waterfall reports the branch merged (no open-ended in-progress span)", () => {
    const result = leadTimeWaterfallSegments(mergedNoTimestamp);
    expect(result.mergeUnknown).toBe(false);
    expect(result.durationUnavailable).toBe(true);
    expect(result.totalMs).toBeNull();
    expect(result.segments[0]?.openEnded).toBeUndefined();
  });

  it("describeLeadTime resolves to MergedUnavailable with an honest reason", () => {
    const result = describeLeadTime(mergedNoTimestamp);
    expect(result.status).toBe(LeadTimeDisplayStatus.MergedUnavailable);
    expect(result.emptyMessage).toBe(LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE);
    // The copy must NOT contradict the Merged chip.
    expect(result.emptyMessage).not.toMatch(NOT_MERGED_RE);
  });

  it("card value is null no-data, not 'In progress'", () => {
    const status = describeLeadTime(mergedNoTimestamp).status;
    expect(leadTimeCardValue(status, () => "3h")).toBeNull();
  });

  it("a genuinely-in-progress branch (open PR) still reads in-progress", () => {
    const inProgress = dDetail({
      prState: GitHubPRState.Open,
      status: BranchStatus.Open,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: null,
    });
    const result = describeLeadTime(inProgress);
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(leadTimeCardValue(result.status, () => "3h")).toBe("In progress");
  });

  it("a merged branch WITH a merge timestamp still shows the measured duration", () => {
    const merged = dDetail({
      prState: GitHubPRState.Merged,
      status: BranchStatus.Merged,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const result = describeLeadTime(merged);
    expect(result.status).toBe(LeadTimeDisplayStatus.Merged);
    expect(leadTimeWaterfallSegments(merged).totalMs).toBe(3 * 3_600_000);
  });

  it("an open branch with a stale local mergedAt (cloud-hydration overlay) never shows a completed lead time", () => {
    // Desktop cloud hydration can replace status/prState back to Open while the
    // local `mergedAt` lingers. The finite-duration branch must gate on the
    // merge SIGNAL, not `mergedAt` presence, so this reads in-progress — not a
    // closed lead time for an open branch (wongk review, FEA-4227).
    const staleMergedAt = dDetail({
      prState: GitHubPRState.Open,
      status: BranchStatus.Open,
      sessions: [dSession({ startedAt: "2026-06-10T10:00:00.000Z" })],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const waterfall = leadTimeWaterfallSegments(staleMergedAt);
    expect(waterfall.mergeUnknown).toBe(true);
    expect(waterfall.totalMs).toBeNull();
    expect(waterfall.durationUnavailable).toBe(false);
    expect(waterfall.segments[0]?.openEnded).toBe(true);

    const result = describeLeadTime(staleMergedAt);
    expect(result.status).toBe(LeadTimeDisplayStatus.InProgress);
    expect(leadTimeCardValue(result.status, () => "3h")).toBe("In progress");
  });

  it("a merged branch with a valid mergedAt but NO session anchor stays pending (no-activity), not 'merge time hasn't synced'", () => {
    // The missing session anchor — not the merge time — is the real gap, so the
    // honest state is the no-activity Pending copy, not the merged-unavailable
    // "merge time hasn't synced" copy (wongk review).
    const mergedNoSession = dDetail({
      prState: GitHubPRState.Merged,
      status: BranchStatus.Merged,
      sessions: [],
      mergedAt: "2026-06-10T13:00:00.000Z",
    });
    const waterfall = leadTimeWaterfallSegments(mergedNoSession);
    expect(waterfall.durationUnavailable).toBe(false);
    expect(waterfall.totalMs).toBeNull();

    const result = describeLeadTime(mergedNoSession);
    expect(result.status).toBe(LeadTimeDisplayStatus.Pending);
    expect(result.emptyMessage).toBe(LEAD_TIME_PENDING_MESSAGE);
    expect(result.emptyMessage).not.toBe(LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE);
  });
});
