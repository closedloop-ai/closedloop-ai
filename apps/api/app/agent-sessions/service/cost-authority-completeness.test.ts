import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import { isAuthoritativeTokenEventCost } from "./cost-authority";

describe("token-event cost authority completeness", () => {
  it.each([
    ["legacy positive", 1, null, true],
    ["legacy literal zero", 0, null, false],
    ["complete explicit zero", 0, TokenCostCompleteness.Complete, true],
    ["partial positive", 1, TokenCostCompleteness.Partial, false],
    ["unavailable", null, TokenCostCompleteness.Unavailable, false],
  ])("classifies %s evidence", (_name, estimatedCost, completeness, expected) => {
    expect(
      isAuthoritativeTokenEventCost({
        estimatedCost,
        costCompleteness: completeness,
      })
    ).toBe(expected);
  });
});
