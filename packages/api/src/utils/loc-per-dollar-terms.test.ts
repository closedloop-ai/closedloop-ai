import { describe, expect, it } from "vitest";
import {
  computeLocPerDollarTerms,
  measuredCostSessionIds,
  type SessionLocCostEntry,
} from "./loc-per-dollar.ts";
import { LOC_SOURCE_BRANCH_FALLBACK, LOC_SOURCE_GIT } from "./session-loc.ts";

const REPO = "closedloop-ai/closedloop-ai";

function entry(
  overrides: Partial<SessionLocCostEntry> & { loc: number; cost: number }
): SessionLocCostEntry {
  return {
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: REPO,
    branch: "feature/a",
    costMeasured: true,
    ...overrides,
  };
}

describe("computeLocPerDollarTerms", () => {
  it("counts each session once and sums commit-sourced LOC per session", () => {
    const byId = new Map<string, SessionLocCostEntry>([
      ["s1", entry({ loc: 100, cost: 2 })],
      ["s2", entry({ loc: 50, cost: 1 })],
    ]);
    expect(computeLocPerDollarTerms(["s1", "s2", "s1"], byId)).toEqual({
      lines: 150,
      cost: 3,
    });
  });

  it("dedupes branch-fallback LOC per branch while still summing cost", () => {
    const byId = new Map<string, SessionLocCostEntry>([
      [
        "s1",
        entry({ loc: 400, cost: 1, locSource: LOC_SOURCE_BRANCH_FALLBACK }),
      ],
      [
        "s2",
        entry({ loc: 400, cost: 1, locSource: LOC_SOURCE_BRANCH_FALLBACK }),
      ],
    ]);
    expect(computeLocPerDollarTerms(["s1", "s2"], byId)).toEqual({
      lines: 400,
      cost: 2,
    });
  });

  it("skips unknown sessions and every impossible LOC or cost value", () => {
    const byId = new Map<string, SessionLocCostEntry>([
      ["ok", entry({ loc: 10, cost: 1 })],
      ["nan-cost", entry({ loc: 10, cost: Number.NaN })],
      ["inf-loc", entry({ loc: Number.POSITIVE_INFINITY, cost: 1 })],
      ["neg-cost", entry({ loc: 10, cost: -1 })],
      ["neg-loc", entry({ loc: -10, cost: 1 })],
    ]);
    expect(
      computeLocPerDollarTerms(
        ["ok", "missing", "nan-cost", "inf-loc", "neg-cost", "neg-loc"],
        byId
      )
    ).toEqual({ lines: 10, cost: 1 });
  });
});

describe("measuredCostSessionIds", () => {
  it("keeps measured costs, including a measured zero, in input order", () => {
    const byId = new Map<string, SessionLocCostEntry>([
      ["free", entry({ loc: 5, cost: 0 })],
      ["unpriced", entry({ loc: 5, cost: 0, costMeasured: false })],
      ["priced", entry({ loc: 0, cost: 3 })],
      ["broken", entry({ loc: 5, cost: Number.NaN })],
    ]);
    expect(
      measuredCostSessionIds(
        ["priced", "missing", "unpriced", "free", "broken"],
        byId
      )
    ).toEqual(["priced", "free"]);
  });
});
