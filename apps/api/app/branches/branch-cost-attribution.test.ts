import type {
  BranchPageDetail,
  BranchSession,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  attachSessionEvenSplitCosts,
  type BranchSessionCostUsage,
  collectDistinctSessionIds,
  distinctSessionCosts,
  evenSplitBranchCost,
  evenSplitBranchCostByBranch,
  rawBranchCost,
  sessionBranchCount,
} from "./branch-cost-attribution";

/**
 * ISS-6657 — per-branch cost attribution. Two contracts are load-bearing and
 * neither is expressible in the type system:
 *
 * 1. NULL IS NOT ZERO. `rawBranchCost`, `evenSplitBranchCost` and
 *    `sumLocEnrichedSpend` return `null` for "nothing priced" and a number for
 *    "priced". `da12fdd28` fixed exactly this collapse (the `0.00` floor), so
 *    every no-cost assertion below is `toBeNull()`, never `toBeFalsy()` and
 *    never `toBe(0)` — those two pass against the regression.
 * 2. A SESSION'S COST IS SPENT ONCE. A session touching N branches contributes
 *    1/N to each, so the shares sum back to the captured cost — not N times it.
 *
 * Every expected number below is a hand-computed literal, never re-derived with
 * the production arithmetic.
 */

const SESSION_DEFAULTS = {
  slug: null,
  name: null,
  harness: "claude",
  startedAt: "2026-08-01T00:00:00.000Z",
  endedAt: null,
  isPrimary: false,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

function session(sessionId: string, estimatedCostUsd: number | null) {
  return { ...SESSION_DEFAULTS, sessionId, estimatedCostUsd } as BranchSession;
}

function usage(
  sessions: BranchSession[],
  estimatedCostUsd = 0
): BranchSessionCostUsage {
  return {
    estimatedCostUsd,
    hasPricedCost: sessions.some((row) => row.estimatedCostUsd !== null),
    sessionIds: [...new Set(sessions.map((row) => row.sessionId))],
    sessions,
  };
}

describe("sessionBranchCount", () => {
  it("keeps a zero branch count unavailable instead of inventing N=1", () => {
    const branchCounts = new Map([["s1", 0]]);

    expect(sessionBranchCount(branchCounts, "s1")).toBeNull();
    expect(
      evenSplitBranchCost(usage([session("s1", 10)]), branchCounts)
    ).toBeNull();
  });

  it("keeps an absent global divisor unavailable", () => {
    expect(sessionBranchCount(new Map(), "missing")).toBeNull();
  });
});

describe("distinctSessionCosts", () => {
  it("counts one session once when it repeats across its branch links", () => {
    // The same session artifact is pushed onto every link it has. Summing the
    // rows instead of deduping them reports $24 of spend for $12 of usage.
    const costs = distinctSessionCosts([
      session("s1", 12),
      session("s1", 12),
      session("s2", 5),
    ]);

    expect([...costs.entries()]).toEqual([
      ["s1", 12],
      ["s2", 5],
    ]);
  });

  it("prefers a priced row over an unpriced placeholder for the same session, in either arrival order", () => {
    // The unpriced-first order is the one that regresses: a naive
    // set-if-absent fold locks in the `null`-coerced 0 and the session's real
    // $8 never reaches the branch total.
    expect(
      distinctSessionCosts([session("s1", null), session("s1", 8)]).get("s1")
    ).toBe(8);
    expect(
      distinctSessionCosts([session("s1", 8), session("s1", null)]).get("s1")
    ).toBe(8);
  });
});

describe("evenSplitBranchCost", () => {
  it("splits a shared session so the per-branch shares sum back to the captured cost exactly once", () => {
    const branchCounts = new Map([["s1", 3]]);
    const shared = usage([session("s1", 12)]);

    // Hand-computed: 12 / 3 = 4 on each of the three branches, 4 * 3 = 12.
    const share = evenSplitBranchCost(shared, branchCounts);

    expect(share).toBe(4);
    expect(share === null ? null : share * 3).toBe(12);
  });

  it("adds each distinct session's own share", () => {
    // Hand-computed: 12/3 = 4, plus 10/2 = 5, plus 7/1 = 7 => 16.
    expect(
      evenSplitBranchCost(
        usage([session("s1", 12), session("s2", 10), session("s3", 7)]),
        new Map([
          ["s1", 3],
          ["s2", 2],
          ["s3", 1],
        ])
      )
    ).toBe(16);
  });

  it("returns null, not 0, when no linked session is priced", () => {
    expect(
      evenSplitBranchCost(
        usage([session("s1", null), session("s2", null)]),
        new Map([["s1", 2]])
      )
    ).toBeNull();
  });

  it("returns a priced 0 as 0, distinct from the unpriced null", () => {
    // A session that genuinely cost nothing is a known zero. Collapsing it into
    // the unpriced `null` hides real usage behind "cost unavailable".
    expect(
      evenSplitBranchCost(usage([session("s1", 0)]), new Map([["s1", 1]]))
    ).toBe(0);
  });

  it("keeps an unpriced numeric fallback distinct from a priced even-split zero", () => {
    expect(
      evenSplitBranchCost(
        {
          ...usage([session("s1", 0)], 0),
          hasPricedCost: false,
        },
        new Map([["s1", 1]])
      )
    ).toBeNull();
  });

  it("keeps an unpriced sibling from diluting a priced session's share", () => {
    // s2 is unpriced and contributes 0; the total must still be s1's own
    // share. Hand-computed: 9/1 = 9.
    expect(
      evenSplitBranchCost(
        usage([session("s1", 9), session("s2", null)]),
        new Map([
          ["s1", 1],
          ["s2", 1],
        ])
      )
    ).toBe(9);
  });
});

describe("rawBranchCost", () => {
  it("returns null, not 0, for a branch with no captured usage", () => {
    // `da12fdd28`: a `0` here renders as "$0.00" — a claim the branch cost
    // nothing — where the truth is that nothing was priced. `toBeFalsy()` and
    // `toBe(0)` both pass against that regression; `toBeNull()` does not.
    const cost = rawBranchCost(usage([], 0));

    expect(cost).toBeNull();
    expect(cost).not.toBe(0);
  });

  it("returns the replicated total when usage is priced", () => {
    expect(rawBranchCost(usage([session("s1", 12)], 12))).toBe(12);
  });

  it("returns a priced 0 as 0, distinct from the unpriced null", () => {
    expect(rawBranchCost(usage([session("s1", 0)], 0))).toBe(0);
  });

  it("keeps an unpriced numeric fallback distinct from a priced 0", () => {
    expect(
      rawBranchCost({
        ...usage([], 0),
        sessionIds: ["s1"],
        sessions: [session("s1", 0)],
        hasPricedCost: false,
      })
    ).toBeNull();
  });
});

describe("evenSplitBranchCostByBranch", () => {
  it("gives every branch on the page its own share and maps an unpriced branch to null", () => {
    const byBranch = evenSplitBranchCostByBranch(
      new Map([
        ["branch-a", usage([session("s1", 12)], 12)],
        ["branch-b", usage([session("s1", 12), session("s2", 6)], 18)],
        ["branch-c", usage([session("s3", null)], 0)],
      ]),
      new Map([
        ["s1", 2],
        ["s2", 1],
        ["s3", 1],
      ])
    );

    // Hand-computed: a = 12/2 = 6; b = 12/2 + 6/1 = 12; c has nothing priced.
    expect(byBranch.get("branch-a")).toBe(6);
    expect(byBranch.get("branch-b")).toBe(12);
    expect(byBranch.get("branch-c")).toBeNull();
    // s1's $12 was spent once: 6 on a plus 6 of b's 12.
    expect(byBranch.get("branch-a")).toBe(6);
  });
});

describe("collectDistinctSessionIds", () => {
  it("collects a session shared by several branches exactly once", () => {
    // The divisor query is keyed on these ids; a duplicated id would fetch the
    // same branch count twice, and a missing one leaves a session undivided.
    const ids = collectDistinctSessionIds(
      new Map([
        ["branch-a", usage([session("s1", 1), session("s2", 1)])],
        ["branch-b", usage([session("s1", 1), session("s3", 1)])],
      ])
    );

    expect([...ids].sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("attachSessionEvenSplitCosts", () => {
  it("stamps each session's share so the timeline bars sum to the branch header cost", () => {
    const sessions = [session("s1", 12), session("s2", 10)];
    const detail = { sessions } as BranchPageDetail;
    const branchCounts = new Map([
      ["s1", 3],
      ["s2", 2],
    ]);

    attachSessionEvenSplitCosts(detail, branchCounts);

    // Hand-computed: 12/3 = 4 and 10/2 = 5, summing to 9.
    expect(sessions[0]?.evenSplitCostUsd).toBe(4);
    expect(sessions[1]?.evenSplitCostUsd).toBe(5);
    // The header total the bars must reconcile against, computed independently
    // by the branch-level helper.
    expect(evenSplitBranchCost(usage(sessions), branchCounts)).toBe(9);
  });

  it("leaves an unpriced session's share null rather than stamping a 0 bar", () => {
    const sessions = [session("s1", null)];
    const detail = { sessions } as BranchPageDetail;

    attachSessionEvenSplitCosts(detail, new Map([["s1", 2]]));

    expect(sessions[0]?.evenSplitCostUsd).toBeNull();
    expect(sessions[0]?.evenSplitCostUsd).not.toBe(0);
  });
});
