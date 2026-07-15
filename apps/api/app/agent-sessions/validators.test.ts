import { describe, expect, it } from "vitest";
import { agentSessionListQuerySchema } from "./validators";

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
  });
});
