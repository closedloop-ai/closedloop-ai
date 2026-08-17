import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { describe, expect, it } from "vitest";
import {
  agentSessionListQuerySchema,
  agentSessionUsageQuerySchema,
  baseAgentSessionQuerySchema,
} from "./validators";

describe("agentSessionUsageQuerySchema — comparison opt-in (ISS-5809)", () => {
  it("accepts the prior-period comparison on the usage read", () => {
    const parsed = agentSessionUsageQuerySchema.parse({
      startDate: "2026-07-08T00:00:00.000Z",
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(parsed.comparison).toBe(AgentSessionComparisonMode.Prior);
  });

  it("leaves comparison undefined when absent", () => {
    expect(agentSessionUsageQuerySchema.parse({}).comparison).toBeUndefined();
  });

  it("rejects an unrecognized comparison mode rather than dropping it", () => {
    expect(
      agentSessionUsageQuerySchema.safeParse({ comparison: "next" }).success
    ).toBe(false);
  });

  it("REJECTS comparison on the list and base schemas, which compute none", () => {
    // Accepting a filter a route cannot honor and silently dropping it is the
    // failure mode AGENTS.md forbids; the strict shapes reject it instead.
    expect(
      agentSessionListQuerySchema.safeParse({
        comparison: AgentSessionComparisonMode.Prior,
      }).success
    ).toBe(false);
    expect(
      baseAgentSessionQuerySchema.safeParse({
        comparison: AgentSessionComparisonMode.Prior,
      }).success
    ).toBe(false);
  });
});

describe("agentSessionListQuerySchema", () => {
  it("parses harness/model/autonomy/cost facets, normalizing single values to arrays", () => {
    const parsed = agentSessionListQuerySchema.parse({
      harnesses: ["claude", "codex"],
      models: "claude-opus-4",
      autonomyTiers: ["high", "unknown"],
      costBuckets: "from_50",
    });

    expect(parsed.harnesses).toEqual(["claude", "codex"]);
    expect(parsed.models).toEqual(["claude-opus-4"]);
    expect(parsed.autonomyTiers).toEqual(["high", "unknown"]);
    expect(parsed.costBuckets).toEqual(["from_50"]);
  });

  it("parses change-presence/pr-association facets, normalizing single values to arrays", () => {
    const parsed = agentSessionListQuerySchema.parse({
      changePresence: "has_changes",
      prAssociation: ["has_pr", "no_pr"],
    });

    expect(parsed.changePresence).toEqual(["has_changes"]);
    expect(parsed.prAssociation).toEqual(["has_pr", "no_pr"]);
  });

  it("leaves the new facets undefined when absent", () => {
    const parsed = agentSessionListQuerySchema.parse({});

    expect(parsed.harnesses).toBeUndefined();
    expect(parsed.models).toBeUndefined();
    expect(parsed.autonomyTiers).toBeUndefined();
    expect(parsed.costBuckets).toBeUndefined();
    expect(parsed.changePresence).toBeUndefined();
    expect(parsed.prAssociation).toBeUndefined();
    // FEA-3284/FEA-3345: the validator leaves absent quality undefined; the
    // server seam (`buildWhere`) resolves it to the `all` fail-open default, so
    // an ungated caller shows every session rather than inheriting the hide gate.
    expect(parsed.quality).toBeUndefined();
  });

  it("parses every FEA-4145 quality-segment value and rejects unknown values", () => {
    // All three Substantive | Idle | All segment values are accepted...
    for (const value of SESSION_QUALITY_VALUES) {
      expect(
        agentSessionListQuerySchema.parse({ quality: value }).quality
      ).toBe(value);
    }
    // ...including `idle`, which the FEA-4145 segment newly added.
    expect(agentSessionListQuerySchema.parse({ quality: "idle" }).quality).toBe(
      "idle"
    );
    // ...and an unsupported value is REJECTED, not silently dropped.
    expect(
      agentSessionListQuerySchema.safeParse({ quality: "bogus" }).success
    ).toBe(false);
  });

  it("rejects unsupported query params instead of silently dropping them", () => {
    const result = agentSessionListQuerySchema.safeParse({
      unknownFilter: "value",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported query params even when mixed with valid ones", () => {
    const result = agentSessionListQuerySchema.safeParse({
      limit: 10,
      offset: 0,
      bogus: "should-fail",
    });

    expect(result.success).toBe(false);
  });
});

describe("baseAgentSessionQuerySchema", () => {
  it("rejects unsupported query params instead of silently dropping them", () => {
    const result = baseAgentSessionQuerySchema.safeParse({
      unknownFilter: "value",
    });

    expect(result.success).toBe(false);
  });

  // AGENTS.md L87-96: version-skewed Desktop clients may still send `search`
  // after the API deploys ahead — the base schema accepts and ignores it so
  // those clients don't get 400'd.
  it("accepts search for backward compatibility with version-skewed Desktop clients", () => {
    const result = baseAgentSessionQuerySchema.safeParse({
      search: "some query",
    });

    expect(result.success).toBe(true);
  });
});
