import { describe, expect, it } from "vitest";
import { deriveBilledModels } from "./agent-session-billed-models.ts";
import type { SyncedAgentSessionTokenUsage } from "./types/agent-session.ts";

function usage(
  overrides: Partial<SyncedAgentSessionTokenUsage> & { model: string }
): SyncedAgentSessionTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("deriveBilledModels (ISS-7895)", () => {
  it("returns [] for no rows at all", () => {
    expect(deriveBilledModels([])).toEqual([]);
  });

  it("excludes a row whose every counter and cost is zero", () => {
    expect(
      deriveBilledModels([usage({ model: "gpt-5.5", estimatedCostUsd: 0 })])
    ).toEqual([]);
  });

  it("excludes a zeroed row while keeping its billed sibling", () => {
    expect(
      deriveBilledModels([
        usage({ model: "gpt-5.5" }),
        usage({ model: "claude-sonnet-4", inputTokens: 120 }),
      ])
    ).toEqual(["claude-sonnet-4"]);
  });

  it.each([
    ["inputTokens", usage({ model: "m", inputTokens: 1 })],
    ["outputTokens", usage({ model: "m", outputTokens: 1 })],
    ["cacheReadTokens", usage({ model: "m", cacheReadTokens: 1 })],
    ["cacheWriteTokens", usage({ model: "m", cacheWriteTokens: 1 })],
    ["estimatedCostUsd", usage({ model: "m", estimatedCostUsd: 0.03 })],
  ])("counts a row billed on %s alone", (_field, row) => {
    expect(deriveBilledModels([row])).toEqual(["m"]);
  });

  it("deduplicates a model that billed across several rows", () => {
    expect(
      deriveBilledModels([
        usage({ model: "gpt-5.5", inputTokens: 10 }),
        usage({ model: "gpt-5.5", outputTokens: 5 }),
      ])
    ).toEqual(["gpt-5.5"]);
  });

  it("treats a model whose only billed row is a duplicate key as billed once", () => {
    expect(
      deriveBilledModels([
        usage({ model: "gpt-5.5" }),
        usage({ model: "gpt-5.5", inputTokens: 10 }),
      ])
    ).toEqual(["gpt-5.5"]);
  });

  it("excludes a row with an empty model string even when it billed", () => {
    expect(deriveBilledModels([usage({ model: "", inputTokens: 10 })])).toEqual(
      []
    );
  });

  it.each([
    ["negative", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["below zero", -100],
  ])("excludes a row whose counter is %s", (_label, inputTokens) => {
    expect(deriveBilledModels([usage({ model: "m", inputTokens })])).toEqual(
      []
    );
  });

  it("omits an undefined estimatedCostUsd rather than reading it as billed", () => {
    expect(deriveBilledModels([usage({ model: "m" })])).toEqual([]);
  });
});
