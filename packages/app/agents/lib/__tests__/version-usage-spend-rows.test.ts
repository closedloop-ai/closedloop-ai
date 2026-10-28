/**
 * ISS-10467 (operator ruling, marisolashgrove 2026-09-26) — the per-version TOKEN
 * and COST rows, at the display seam.
 *
 * The panel suite drives these through the real `AgentDetail` render; this file
 * pins the shaping decisions that render cannot show cheaply — that the labels
 * are the CANONICAL metric phrases rather than words this surface invented, and
 * that the kind gate on `LOC / $` is deliberately NOT the kind gate on the spend
 * rows. Both were the substance of the review thread this ruling settles, so
 * they are asserted rather than left to a reviewer's reading of the diff.
 */

import {
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentVersionUsage } from "@repo/api/src/types/agent-component-version-usage";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import { EMPTY_VERSION_SPEND } from "@repo/api/src/utils/version-spend";
import { SESSION_LEVEL_ATTRIBUTION_CAVEAT } from "@repo/app/agents/lib/session-level-attribution-copy";
import {
  sessionLevelAttributionCaveat,
  versionUsageMetrics,
} from "@repo/app/agents/lib/version-usage-view";
import { describe, expect, it } from "vitest";

const TOKENS_KEY = "total-tokens";
const COST_KEY = "estimated-cost";

function entry(
  overrides: Partial<AgentComponentVersionUsage> = {}
): AgentComponentVersionUsage {
  return {
    hash: "aaaaaaaa1111",
    invocations: 6,
    sessions: 2,
    locPerDollar: null,
    truncated: false,
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...EMPTY_VERSION_SPEND,
    ...overrides,
  };
}

function row(kind: AgentComponentKind, key: string, over = {}) {
  return versionUsageMetrics(kind, entry(over)).find((r) => r.key === key);
}

describe("versionUsageMetrics — per-version spend rows (ISS-10467)", () => {
  it("names both figures with the canonical metric phrases", () => {
    // The labels are OWNED (`total-tokens-copy`, `total-estimated-cost-copy`) and
    // read, not re-typed here: a surface that spells a metric its own way is how
    // one screen comes to call the same quantity something else. Asserting
    // against the imported constants also means a rename lands on both at once.
    expect(row(AgentComponentKind.Skill, TOKENS_KEY)?.label).toBe(
      TOTAL_TOKENS_LABEL
    );
    expect(row(AgentComponentKind.Skill, COST_KEY)?.label).toBe(
      TOTAL_ESTIMATED_COST_LABEL
    );
  });

  it("renders the spend rows for EVERY kind, unlike the LOC / $ ratio", () => {
    // The distinction the ruling draws. `LOC / $` is withheld for a kind whose
    // per-component attribution is not verifiable; the raw totals are not,
    // because they are measured over a session set the producer names exactly and
    // withholding them deletes a figure that is in hand. A single `kind` gate
    // reused for both — the shape that shipped — fails this pair.
    for (const kind of [
      AgentComponentKind.Skill,
      AgentComponentKind.Command,
      AgentComponentKind.Subagent,
    ]) {
      const keys = versionUsageMetrics(kind, entry()).map((r) => r.key);
      expect(keys).toContain(TOKENS_KEY);
      expect(keys).toContain(COST_KEY);
      // And the ratio row still follows its own gate, so this is a real
      // divergence rather than two gates that happen to agree.
      expect(keys.includes("loc-per-dollar")).toBe(
        isLocPerDollarVerifiableKind(kind)
      );
    }
  });

  it("dashes an unmeasured figure and marks it unmeasured for the muted slot", () => {
    const tokens = row(AgentComponentKind.Skill, TOKENS_KEY);
    const cost = row(AgentComponentKind.Skill, COST_KEY);

    expect(tokens?.value).toBe("—");
    expect(cost?.value).toBe("—");
    // `measured` is what styles the value muted rather than as a measurement; a
    // dash rendered in the foreground colour reads as a real reported value.
    expect(tokens?.measured).toBe(false);
    expect(cost?.measured).toBe(false);
  });

  it("formats a measured figure, including a measured zero", () => {
    expect(
      row(AgentComponentKind.Skill, TOKENS_KEY, { totalTokens: 1_250_000 })
        ?.value
    ).toBe("1.25M");
    // CENTS, not the `$42` this column rounded 41.5 to before (operator ruling,
    // marisolashgrove 2026-10-01: "raise cost column's precision"). ISS-10468 put a
    // CHANGE column beside this one, and whole dollars rendered a real $0.20 move
    // as two cells a dollar apart.
    expect(
      row(AgentComponentKind.Skill, COST_KEY, { estimatedCostUsd: 41.5 })?.value
    ).toBe("$41.50");
    // A priced $0 is a fact, and it must not wear the no-value dash.
    const zero = row(AgentComponentKind.Skill, COST_KEY, {
      estimatedCostUsd: 0,
    });
    expect(zero?.value).toBe("$0.00");
    expect(zero?.measured).toBe(true);
  });

  it("marks a partially covered figure with the page's own floor glyph", () => {
    expect(
      row(AgentComponentKind.Skill, TOKENS_KEY, {
        totalTokens: 900,
        totalTokensPartial: true,
      })?.value
    ).toBe("900+");
    expect(
      row(AgentComponentKind.Skill, COST_KEY, {
        estimatedCostUsd: 12,
        estimatedCostPartial: true,
      })?.value
    ).toBe("$12.00+");
  });

  it("never decorates a no-value dash with the floor glyph", () => {
    // `—+` would assert a bound on a figure that does not exist. Reachable under
    // version skew: a producer can send the coverage flag having failed to
    // compute the figure it describes.
    expect(
      row(AgentComponentKind.Skill, COST_KEY, {
        estimatedCostUsd: null,
        estimatedCostPartial: true,
      })?.value
    ).toBe("—");
  });
});

describe("sessionLevelAttributionCaveat (ISS-10467)", () => {
  it("states the session-level admission for a kind that owes one", () => {
    expect(
      sessionLevelAttributionCaveat(
        AgentComponentKind.Skill,
        entry({ estimatedCostUsd: 9 })
      )
    ).toBe(SESSION_LEVEL_ATTRIBUTION_CAVEAT);
    expect(
      sessionLevelAttributionCaveat(
        AgentComponentKind.Command,
        entry({ totalTokens: 10 })
      )
    ).toBe(SESSION_LEVEL_ATTRIBUTION_CAVEAT);
  });

  it("is silent for a kind whose attribution is reliable", () => {
    // `subagent` governs the whole session it runs, so the sentence would be
    // false. Pinned beside the case above so this is a gate, not a deletion.
    expect(
      sessionLevelAttributionCaveat(
        AgentComponentKind.Subagent,
        entry({ estimatedCostUsd: 9, totalTokens: 10 })
      )
    ).toBeNull();
  });

  it("is silent when neither figure was measured", () => {
    // A caveat over two dashes states a shortfall in a measurement that does not
    // exist — the same rule `sampledLocPerDollarCaveat` follows one row up.
    expect(
      sessionLevelAttributionCaveat(AgentComponentKind.Skill, entry())
    ).toBeNull();
    expect(
      sessionLevelAttributionCaveat(AgentComponentKind.Skill, undefined)
    ).toBeNull();
  });
});
