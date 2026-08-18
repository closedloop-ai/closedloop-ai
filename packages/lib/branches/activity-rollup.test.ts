import type {
  BranchActivitySegment,
  BranchPageDetail,
  BranchSession,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  BRANCH_ACTIVITY_ORDER,
  isActiveActivityPhase,
  rollupBranchActivity,
  UNATTRIBUTED_KEY,
} from "./activity-rollup";

function seg(
  phase: string,
  costUsd: number | null,
  inputTokens = 0,
  outputTokens = 0
): BranchActivitySegment {
  return {
    phase,
    startMs: 0,
    endMs: 1,
    costUsd,
    inputTokens,
    outputTokens,
    confidence: 0.9,
  };
}

function session(
  sessionId: string,
  estimatedCostUsd: number | null,
  activitySegments: BranchActivitySegment[] | undefined,
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    branchCount?: number;
  } = {}
): BranchSession {
  return {
    sessionId,
    slug: null,
    name: sessionId,
    harness: "claude",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T01:00:00.000Z",
    isPrimary: true,
    ownerUserName: null, // not consumed by the rollup
    estimatedCostUsd,
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    activitySegments,
    ...(tokens.branchCount == null ? {} : { branchCount: tokens.branchCount }),
  };
}

function detail(
  sessions: BranchSession[],
  estimatedCostUsd: number | null,
  attributedCostUsd?: number | null
): Pick<
  BranchPageDetail,
  "attributedCostUsd" | "estimatedCostUsd" | "sessions"
> {
  return {
    sessions,
    estimatedCostUsd,
    ...(attributedCostUsd === undefined ? {} : { attributedCostUsd }),
  };
}

describe("rollupBranchActivity", () => {
  it("rolls the branch's sessions into a per-activity cost breakdown (replaces build/rework)", () => {
    const d = detail(
      [
        session("s1", 3, [
          seg("implement", 2, 100, 50),
          seg("review", 0.5, 20, 10),
          seg("validate", 0.5, 10, 5),
        ]),
      ],
      3
    );

    const rollup = rollupBranchActivity(d);

    expect(rollup.activities.map((a) => a.phase)).toEqual([
      "implement",
      "review",
      "validate",
    ]);
    const implement = rollup.activities.find((a) => a.phase === "implement");
    expect(implement).toMatchObject({
      costUsd: 2,
      inputTokens: 100,
      outputTokens: 50,
      segmentCount: 1,
      sessionCount: 1,
    });
    expect(rollup.hasAnySegments).toBe(true);
  });

  it("reconciles: Σ(activities) + unattributed == branch total", () => {
    // Session total is 3 but only 2.5 is attributed to segments (0.5 gap).
    const d = detail(
      [session("s1", 3, [seg("implement", 2, 100, 50), seg("review", 0.5)])],
      3
    );
    const rollup = rollupBranchActivity(d);
    const attributed = rollup.activities.reduce(
      (s, a) => s + (a.costUsd ?? 0),
      0
    );
    expect(attributed).toBeCloseTo(2.5, 9);
    expect(rollup.unattributed.costUsd).toBeCloseTo(0.5, 9);
    expect(attributed + (rollup.unattributed.costUsd ?? 0)).toBeCloseTo(3, 9);
  });

  it("reconciles to attributedCostUsd without dividing the canonical total again", () => {
    const d = detail(
      [
        session("shared", 10, [seg("implement", 10)], {
          branchCount: 2,
        }),
      ],
      10,
      5
    );

    const rollup = rollupBranchActivity(d);
    expect(rollup.totalCostUsd).toBe(5);
    expect(rollup.activities[0]?.costUsd).toBe(5);
    expect(rollup.unattributed.costUsd).toBe(0);
  });

  it("falls back to raw estimatedCostUsd only when attributedCostUsd is omitted", () => {
    const rollup = rollupBranchActivity(
      detail([session("legacy", 3, [seg("implement", 2)])], 3)
    );

    expect(rollup.totalCostUsd).toBe(3);
    expect(rollup.unattributed.costUsd).toBe(1);
  });

  it("preserves explicit null and zero attributed totals", () => {
    const sessions = [session("s1", 4, [seg("implement", 4)])];

    const unavailable = rollupBranchActivity(detail(sessions, 4, null));
    expect(unavailable.totalCostUsd).toBeNull();
    expect(unavailable.unattributed.costUsd).toBeNull();

    const zero = rollupBranchActivity(detail(sessions, 4, 0));
    expect(zero.totalCostUsd).toBe(0);
    expect(zero.unattributed.costUsd).toBe(0);
    expect(zero.activities[0]?.costUsd).toBe(0);
    expect(
      zero.activities.reduce(
        (sum, activity) => sum + (activity.costUsd ?? 0),
        zero.unattributed.costUsd ?? 0
      )
    ).toBe(0);
  });

  it("shows `other` honestly as its own aggregate, never folded into implement", () => {
    const d = detail(
      [session("s1", 2, [seg("implement", 1.5), seg("other", 0.5)])],
      2
    );
    const rollup = rollupBranchActivity(d);
    expect(rollup.activities.find((a) => a.phase === "other")?.costUsd).toBe(
      0.5
    );
    expect(
      rollup.activities.find((a) => a.phase === "implement")?.costUsd
    ).toBe(1.5);
  });

  it("routes a session with no segments to the unattributed residual (bar still sums to total)", () => {
    const d = detail(
      [
        session("s1", 2, [seg("implement", 2, 100, 50)], {
          inputTokens: 100,
          outputTokens: 50,
        }),
        // Pre-backfill session: no tiling, whole spend is unattributed.
        session("s2", 1.5, undefined, { inputTokens: 60, outputTokens: 30 }),
      ],
      3.5
    );
    const rollup = rollupBranchActivity(d);
    expect(
      rollup.activities.find((a) => a.phase === "implement")?.costUsd
    ).toBe(2);
    expect(rollup.unattributed.costUsd).toBeCloseTo(1.5, 9);
    expect(rollup.unattributed.sessionCount).toBe(1);
    // Unattributed tokens = the no-segment session's tokens.
    expect(rollup.unattributed.inputTokens).toBe(60);
    expect(rollup.unattributed.outputTokens).toBe(30);
  });

  it("treats an empty [] tiling like a no-segment session (both feed unattributed)", () => {
    const d = detail([session("s1", 1, [], { inputTokens: 40 })], 1);
    const rollup = rollupBranchActivity(d);
    expect(rollup.hasAnySegments).toBe(false);
    expect(rollup.unattributed.costUsd).toBe(1);
    expect(rollup.unattributed.sessionCount).toBe(1);
  });

  it("hasAnySegments is false when NO contributing session carries a tiling", () => {
    const d = detail(
      [session("s1", 1, undefined), session("s2", 2, undefined)],
      3
    );
    expect(rollupBranchActivity(d).hasAnySegments).toBe(false);
  });

  it("keeps an activity cost null (never 0) when nothing in it prices", () => {
    const d = detail(
      [session("s1", null, [seg("implement", null, 100, 50)])],
      null
    );
    const rollup = rollupBranchActivity(d);
    const implement = rollup.activities.find((a) => a.phase === "implement");
    expect(implement?.costUsd).toBeNull();
    expect(implement?.inputTokens).toBe(100);
    // No priced branch total → unattributed cost is null, not 0.
    expect(rollup.unattributed.costUsd).toBeNull();
  });

  it("orders activities by the canonical taxonomy, unknown phases after (alphabetical)", () => {
    const d = detail(
      [
        session("s1", 6, [
          seg("validate", 1),
          seg("explore", 1),
          seg("implement", 1),
          seg("zzz-custom", 1),
          seg("aaa-custom", 1),
          seg("review", 1),
        ]),
      ],
      6
    );
    const rollup = rollupBranchActivity(d);
    expect(rollup.activities.map((a) => a.phase)).toEqual([
      "explore",
      "implement",
      "review",
      "validate",
      "aaa-custom",
      "zzz-custom",
    ]);
  });

  it("aggregates the same phase across multiple sessions (distinct sessionCount, summed segments)", () => {
    const d = detail(
      [
        session("s1", 2, [seg("implement", 1), seg("implement", 0.5)]),
        session("s2", 1, [seg("implement", 1)]),
      ],
      3
    );
    const rollup = rollupBranchActivity(d);
    const implement = rollup.activities.find((a) => a.phase === "implement");
    expect(implement).toMatchObject({
      costUsd: 2.5,
      segmentCount: 3,
      sessionCount: 2,
    });
  });

  it("normalizes phase casing/whitespace so `Implement ` folds into `implement`", () => {
    const d = detail(
      [session("s1", 2, [seg("Implement ", 1), seg("implement", 1)])],
      2
    );
    const rollup = rollupBranchActivity(d);
    expect(rollup.activities).toHaveLength(1);
    expect(rollup.activities[0]).toMatchObject({
      phase: "implement",
      segmentCount: 2,
    });
  });

  it("even-splits a shared session's attributed cost by its branchCount, reconciling to the even-split total", () => {
    // A $10 Implement session shared across 2 branches (branchCount 2) + a
    // branch-local $10 Review session (branchCount 1). The even-split branch total
    // is $5 (shared half) + $10 = $15, so Implement must read $5, not the raw $10 —
    // and the reconciliation must not clamp a phantom residual.
    const d = detail(
      [
        session("shared", 10, [seg("implement", 10, 100, 200)], {
          branchCount: 2,
        }),
        session("local", 10, [seg("review", 10, 40, 80)], { branchCount: 1 }),
      ],
      15
    );
    const rollup = rollupBranchActivity(d);
    expect(
      rollup.activities.find((a) => a.phase === "implement")?.costUsd
    ).toBe(5);
    expect(rollup.activities.find((a) => a.phase === "review")?.costUsd).toBe(
      10
    );
    // Tokens are NOT divided — raw on both surfaces.
    expect(
      rollup.activities.find((a) => a.phase === "implement")?.inputTokens
    ).toBe(100);
    // Fully attributed after the split → no unattributed residual.
    expect(rollup.unattributed.costUsd).toBe(0);
  });

  it("does not double-count a session that appears more than once in detail.sessions", () => {
    // The cloud producer can push the same session onto `detail.sessions` once per
    // `session_pr` link row; folding both copies would inflate the activity $.
    const dup = session("s1", 2, [seg("implement", 2, 100, 50)], {
      inputTokens: 100,
      outputTokens: 50,
    });
    const rollup = rollupBranchActivity(detail([dup, { ...dup }], 2));
    const implement = rollup.activities.find((a) => a.phase === "implement");
    expect(implement).toMatchObject({
      costUsd: 2, // NOT 4
      inputTokens: 100, // NOT 200
      segmentCount: 1, // NOT 2
      sessionCount: 1,
    });
    // Token totals are deduped too, so the residual doesn't go negative/clamp.
    expect(rollup.unattributed.costUsd).toBe(0);
  });

  it("is deterministic and reads no clock (identical input → identical output)", () => {
    const build = () =>
      rollupBranchActivity(
        detail([session("s1", 2, [seg("implement", 2)])], 2)
      );
    expect(build()).toEqual(build());
  });
});

describe("isActiveActivityPhase", () => {
  it("excludes other/idle/unattributed from active work", () => {
    expect(isActiveActivityPhase("implement")).toBe(true);
    expect(isActiveActivityPhase("review")).toBe(true);
    expect(isActiveActivityPhase("other")).toBe(false);
    expect(isActiveActivityPhase("idle")).toBe(false);
    expect(isActiveActivityPhase(UNATTRIBUTED_KEY)).toBe(false);
  });
});

describe("BRANCH_ACTIVITY_ORDER", () => {
  it("is the FEA-2269 taxonomy in render order", () => {
    expect(BRANCH_ACTIVITY_ORDER).toEqual([
      "explore",
      "plan",
      "implement",
      "review",
      "validate",
      "rework",
      "other",
      "idle",
    ]);
  });
});
