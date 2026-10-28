import { describe, expect, it } from "vitest";
import type { AgentSessionUsageQuery } from "../validators";
import { penseroSessionPopulationIsWhole } from "./pensero-population-alignment";

/**
 * ISS-11117 (chatgpt-codex-connector, PR #7863) — the Sessions points ratio may
 * publish only when its divisor covers the same work its numerator counts.
 *
 * The numerator is a branch-LIFETIME points total; the divisor is the cost of
 * the sessions the request matched. Any facet that drops a session which
 * touched an included branch shrinks the divisor and not the numerator, so the
 * ratio comes out high by an amount nothing on screen can show.
 */
describe("penseroSessionPopulationIsWhole", () => {
  it("is whole for a request carrying no filters", () => {
    expect(penseroSessionPopulationIsWhole(query({}))).toBe(true);
  });

  it.each([
    ["models", { models: ["claude-opus"] }],
    ["componentSlug", { componentSlug: "subagent::design-critic" }],
    ["userIds", { userIds: ["019c435c-9d43-747e-8d26-7b377f2c45c5"] }],
    ["repositories", { repositories: ["closedloop-ai/closedloop-ai"] }],
    ["statuses", { statuses: ["active"] }],
    ["status", { status: "active" }],
    ["harness", { harness: "claude-code" }],
    ["harnesses", { harnesses: ["codex"] }],
    ["quality", { quality: "substantive" }],
    ["teamId", { teamId: "019c435c-9d43-747e-8d26-7b377f2c45c6" }],
    ["projectIds", { projectIds: ["019c435c-9d43-747e-8d26-7b377f2c45c7"] }],
    ["prAssociation", { prAssociation: ["has_pr"] }],
    ["costBuckets", { costBuckets: ["high"] }],
    ["completedAfter", { completedAfter: "2026-09-01" }],
  ])("is NOT whole once %s narrows the population", (_name, filters) => {
    expect(
      penseroSessionPopulationIsWhole(
        query(filters as Partial<AgentSessionUsageQuery>)
      )
    ).toBe(false);
  });

  it("treats an EMPTY facet array as absent", () => {
    // Defensive, and deliberately not claimed as a URL shape: `?models=` is
    // REJECTED by the validator (`z.string().trim().min(1)`) rather than parsed
    // to `[]`, so this reaches the predicate only from a caller that builds the
    // query object directly — which the type admits. An empty array selects
    // every row, so withholding for it would refuse a derivation whose operands
    // are whole.
    expect(
      penseroSessionPopulationIsWhole(
        query({ models: [], userIds: [], repositories: [] })
      )
    ).toBe(true);
  });

  it("ignores params that select no rows", () => {
    // `comparison` opts into a second read, `search` is accepted for
    // version-skewed clients and unimplemented, and `viewerScope` carries its
    // narrowing through `teamId`. None of them changes the divisor's
    // population on its own, so none may withhold the ratio.
    expect(
      penseroSessionPopulationIsWhole(
        query({
          comparison: "prior",
          search: "anything",
          viewerScope: "organization",
        } as Partial<AgentSessionUsageQuery>)
      )
    ).toBe(true);
  });
});

function query(filters: Partial<AgentSessionUsageQuery>) {
  return filters as AgentSessionUsageQuery;
}
