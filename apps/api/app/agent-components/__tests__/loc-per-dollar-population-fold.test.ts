/**
 * @file loc-per-dollar-population-fold.test.ts
 * @description ISS-6409: pins the CLOUD `foldPopulationLocPerDollar` directly.
 *
 * The desktop twin is driven end to end by a Playwright spec, but the cloud
 * fold had no test that named it: `page-data-service.test.ts` mocks the service
 * wholesale and the web e2e supplies the aggregate as a route fixture, so
 * replacing the session UNION with a per-component sum left every suite green —
 * and that per-component sum is the exact estimand this issue exists to remove.
 *
 * The corpus separates all three candidates, so one assertion falsifies two
 * wrong designs at once:
 *  - union (correct):      1100 lines / $200 = 5.5
 *  - per-component sum:    2100 / $300      = 7.0
 *  - unweighted mean:      (5.5 + 10) / 2   = 7.75
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import { describe, expect, it } from "vitest";
import {
  foldPopulationLocPerDollar,
  type SessionLocCost,
} from "../loc-per-dollar";

const SHARED_SESSION = "session-shared";
const ALPHA_SOLO_SESSION = "session-alpha-solo";
const BRAVO_SOLO_SESSION = "session-bravo-solo";

/** A session whose cost was measured — including a measured zero. */
function locCost(loc: number, cost: number): SessionLocCost {
  return {
    branch: null,
    cost,
    costMeasured: true,
    loc,
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: null,
    // The LOC/$ fold reads no token term; `null` rather than `0` so the fixture
    // claims no measurement it did not take.
    tokens: null,
  };
}

/**
 * A session whose cost was never measured (`estimatedCost` null upstream). It
 * surfaces as `cost: 0` exactly like a measured zero, which is the whole reason
 * `costMeasured` exists.
 */
function unmeasuredCost(loc: number): SessionLocCost {
  return { ...locCost(loc, 0), costMeasured: false };
}

/**
 * Both components share one session and each also has a session of its own, so
 * FIVE candidate answers are distinct at rendered precision:
 *
 *   union (correct)     1300 / 250 = 5.20
 *   alpha-only          1100 / 200 = 5.50   <- a fold that stops at components[0]
 *   per-component sum   2300 / 350 = 6.57
 *   unweighted mean   (5.5 + 8) / 2 = 6.75
 *   bravo-only          1200 / 150 = 8.00
 *
 * The alpha-only row matters: with bravo contributing no session of its own,
 * the union collapses onto alpha's own ratio and a fold that never visited the
 * rest of the population would still look right (#6417 e2e review).
 */
function corpus() {
  return {
    components: [
      { kind: AgentComponentKind.Subagent, slug: "alpha" },
      { kind: AgentComponentKind.Subagent, slug: "bravo" },
    ],
    locCostBySession: new Map<string, SessionLocCost>([
      [SHARED_SESSION, locCost(1000, 100)],
      [ALPHA_SOLO_SESSION, locCost(100, 100)],
      [BRAVO_SOLO_SESSION, locCost(200, 50)],
    ]),
    sessionIdsBySlug: new Map<string, Iterable<string>>([
      ["alpha", [SHARED_SESSION, ALPHA_SOLO_SESSION]],
      ["bravo", [SHARED_SESSION, BRAVO_SOLO_SESSION]],
    ]),
  };
}

describe("foldPopulationLocPerDollar", () => {
  it("counts a session shared by two components exactly once", () => {
    const { components, sessionIdsBySlug, locCostBySession } = corpus();

    const result = foldPopulationLocPerDollar(
      components,
      sessionIdsBySlug,
      locCostBySession
    );

    expect(result.locPerDollar).toBe(5.2);
    // Every wrong answer this corpus can produce, named.
    expect(result.locPerDollar).not.toBe(5.5); // folded only components[0]
    expect(result.locPerDollar).not.toBeCloseTo(6.5714, 3); // per-component sum
    expect(result.locPerDollar).not.toBe(6.75); // unweighted mean of ratios
    expect(result.sampleSize).toBe(2);
  });

  it("excludes a non-verifiable kind from both the union and the count", () => {
    const { components, sessionIdsBySlug, locCostBySession } = corpus();
    const withTool = [
      ...components,
      { kind: AgentComponentKind.Tool, slug: "grep" },
    ];
    sessionIdsBySlug.set("grep", ["session-tool"]);
    locCostBySession.set("session-tool", locCost(9000, 1));

    const result = foldPopulationLocPerDollar(
      withTool,
      sessionIdsBySlug,
      locCostBySession
    );

    expect(result.locPerDollar).toBe(5.2);
    expect(result.sampleSize).toBe(2);
  });

  it("skips a non-finite or negative session rather than summing it", () => {
    const { components, sessionIdsBySlug, locCostBySession } = corpus();
    sessionIdsBySlug.set("alpha", [
      SHARED_SESSION,
      ALPHA_SOLO_SESSION,
      "session-nan",
      "session-negative",
    ]);
    locCostBySession.set("session-nan", locCost(50, Number.NaN));
    locCostBySession.set("session-negative", locCost(-5, -5));

    const result = foldPopulationLocPerDollar(
      components,
      sessionIdsBySlug,
      locCostBySession
    );

    // One corrupt row must not null the whole card, which is what an
    // unguarded NaN in the denominator would do under a union fold.
    expect(result.locPerDollar).toBe(5.2);
    expect(result.sampleSize).toBe(2);
  });

  it("folds a cost-only population to unavailable, not to a rate", () => {
    // One component has lines but no priced spend, the other spend but no git
    // LOC. Excluding unpriced sessions drops the first entirely, so the union
    // carries cost and no lines and correctly reads unavailable.
    //
    // Before the exclusion this fixture produced a real number (4) above
    // "across 0 components". That pair is now unreachable by construction: a
    // non-null union needs cost, all cost comes from a priced session, and any
    // component with a priced session is counted.
    const result = foldPopulationLocPerDollar(
      [
        { kind: AgentComponentKind.Subagent, slug: "lines-only" },
        { kind: AgentComponentKind.Subagent, slug: "cost-only" },
      ],
      new Map<string, Iterable<string>>([
        ["lines-only", ["session-lines"]],
        ["cost-only", ["session-cost"]],
      ]),
      new Map<string, SessionLocCost>([
        ["session-lines", unmeasuredCost(400)],
        ["session-cost", locCost(0, 100)],
      ])
    );

    expect(result.locPerDollar).toBeNull();
    expect(result.sampleSize).toBe(0);
  });

  it("zeroes the sample when the union cannot be measured at all", () => {
    // Both components contribute lines, so `contributesToUnion` is true for
    // each — but nothing is priced, so the union folds to null. Without the
    // `locPerDollar === null ? 0` clamp this renders "— across 2 components",
    // a dash claiming a measured population.
    const result = foldPopulationLocPerDollar(
      [
        { kind: AgentComponentKind.Subagent, slug: "alpha" },
        { kind: AgentComponentKind.Subagent, slug: "bravo" },
      ],
      new Map<string, Iterable<string>>([
        ["alpha", ["session-a"]],
        ["bravo", ["session-b"]],
      ]),
      new Map<string, SessionLocCost>([
        ["session-a", unmeasuredCost(400)],
        ["session-b", unmeasuredCost(600)],
      ])
    );

    expect(result.locPerDollar).toBeNull();
    expect(result.sampleSize).toBe(0);
  });

  it("is not carried by a near-free component, as the mean of ratios was", () => {
    // ISS-6409's own failure scenario, at its stated shape: one heavily-used
    // subagent plus four trial subagents on near-free sessions. The mean of
    // ratios reads ~35x the true rate because each near-zero denominator
    // contributes an enormous ratio with equal weight; the ratio of sums
    // weights by the dollar and barely moves.
    const components = [
      { kind: AgentComponentKind.Subagent, slug: "workhorse" },
      ...["t1", "t2", "t3", "t4"].map((slug) => ({
        kind: AgentComponentKind.Subagent,
        slug,
      })),
    ];
    const sessionIdsBySlug = new Map<string, Iterable<string>>([
      ["workhorse", ["s-workhorse"]],
      ...["t1", "t2", "t3", "t4"].map((slug): [string, Iterable<string>] => [
        slug,
        [`s-${slug}`],
      ]),
    ]);
    const locCostBySession = new Map<string, SessionLocCost>([
      ["s-workhorse", locCost(18_000, 600)],
      ...["t1", "t2", "t3", "t4"].map((slug): [string, SessionLocCost] => [
        `s-${slug}`,
        locCost(40, 0.03),
      ]),
    ]);

    const result = foldPopulationLocPerDollar(
      components,
      sessionIdsBySlug,
      locCostBySession
    );

    // 18,160 / 600.12 — what the spend actually bought.
    expect(result.locPerDollar).toBeCloseTo(30.26, 2);
    // The mean of ratios on this same corpus is ~1,070.
    expect(result.locPerDollar).toBeLessThan(40);
    expect(result.sampleSize).toBe(5);
  });

  it("excludes a session whose cost was never measured", () => {
    // Cosimo, 2026-09-02. An ABSENT cost would put its lines in the numerator
    // and nothing in the denominator, so unpriced work reads as free work and
    // lifts the rate — and under a union fold it lifts the WHOLE card, not one
    // row. Note this session is `cost: 0` on the wire, identical to the
    // measured zero in the next case; only `costMeasured` separates them.
    const { components, sessionIdsBySlug, locCostBySession } = corpus();
    sessionIdsBySlug.set("bravo", [
      SHARED_SESSION,
      BRAVO_SOLO_SESSION,
      "session-unpriced",
    ]);
    locCostBySession.set("session-unpriced", unmeasuredCost(50));

    const result = foldPopulationLocPerDollar(
      components,
      sessionIdsBySlug,
      locCostBySession
    );

    // Still 1300 / 250. Counting the unmeasured session would read 5.4.
    expect(result.locPerDollar).toBe(5.2);
    expect(result.locPerDollar).not.toBe(5.4);
    expect(result.sampleSize).toBe(2);
  });

  it("includes a MEASURED zero cost — free work is a real figure", () => {
    // The other half of the rule, and the reason the predicate is
    // null-versus-zero rather than zero-versus-positive: a measured $0 is data,
    // so its lines count. Same shape as the case above apart from
    // `costMeasured`, and the answers differ.
    const { components, sessionIdsBySlug, locCostBySession } = corpus();
    sessionIdsBySlug.set("bravo", [
      SHARED_SESSION,
      BRAVO_SOLO_SESSION,
      "session-free",
    ]);
    locCostBySession.set("session-free", locCost(50, 0));

    const result = foldPopulationLocPerDollar(
      components,
      sessionIdsBySlug,
      locCostBySession
    );

    // 1350 / 250 — the free session's lines count toward what the spend bought.
    expect(result.locPerDollar).toBe(5.4);
    expect(result.sampleSize).toBe(2);
  });

  it("reports no sample when the fold yields nothing", () => {
    const result = foldPopulationLocPerDollar(
      [{ kind: AgentComponentKind.Subagent, slug: "alpha" }],
      new Map<string, Iterable<string>>([["alpha", ["session-missing"]]]),
      new Map<string, SessionLocCost>()
    );

    expect(result.locPerDollar).toBeNull();
    expect(result.sampleSize).toBe(0);
  });
});
