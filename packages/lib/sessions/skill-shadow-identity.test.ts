import { describe, expect, it } from "vitest";
import {
  carriesOwnDefinitionEvidence,
  isSkillInvokedSlashKey,
  type SkillShadowEvidence,
  slashKeyBareName,
} from "./skill-shadow-identity";

function evidence(
  resolvedSkillNames: string[],
  vouchedCommandKeys: string[] = []
): SkillShadowEvidence {
  return {
    resolvedSkillNames: new Set(resolvedSkillNames),
    vouchedCommandKeys: new Set(vouchedCommandKeys),
  };
}

describe("slashKeyBareName", () => {
  it("names the skill a slash key would resolve to", () => {
    expect(slashKeyBareName("/prune-tests")).toBe("prune-tests");
  });

  it("keeps a namespaced plugin skill's full key", () => {
    expect(slashKeyBareName("/code-review:deep")).toBe("code-review:deep");
  });

  it("rejects a non-slash key, a bare slash, and an absent key", () => {
    expect(slashKeyBareName("prune-tests")).toBeNull();
    expect(slashKeyBareName("/")).toBeNull();
    expect(slashKeyBareName(null)).toBeNull();
    expect(slashKeyBareName(undefined)).toBeNull();
  });
});

describe("isSkillInvokedSlashKey", () => {
  it("resolves a slash invocation of a resolved skill to the skill", () => {
    expect(
      isSkillInvokedSlashKey(
        evidence(["prune-tests"]),
        "prune-tests",
        "/prune-tests"
      )
    ).toBe(true);
  });

  // The guard that stops name equality from merging two genuinely different
  // components: a command that vouches for itself is a second entity.
  it("keeps a command that vouches for itself even when a skill shares its name", () => {
    expect(
      isSkillInvokedSlashKey(
        evidence(["deploy"], ["/deploy"]),
        "deploy",
        "/deploy"
      )
    ).toBe(false);
  });

  it("keeps a command with no same-named resolved skill", () => {
    expect(isSkillInvokedSlashKey(evidence([]), "deploy", "/deploy")).toBe(
      false
    );
  });

  // An unresolved skill row never reaches `resolvedSkillNames`, so a name merely
  // observed in passing cannot absorb a real command.
  it("is false when the bare name is absent", () => {
    expect(
      isSkillInvokedSlashKey(evidence(["prune-tests"]), null, "/prune-tests")
    ).toBe(false);
  });

  // Vouching is keyed on the SLASH key, not the bare name — a `deploy` skill
  // plus a vouched `/deploy` must not accidentally read as unvouched.
  it("matches vouching on the slash key rather than the bare name", () => {
    expect(
      isSkillInvokedSlashKey(
        evidence(["deploy"], ["deploy"]),
        "deploy",
        "/deploy"
      )
    ).toBe(true);
  });
});

// ISS-5260 (wongk review): the per-row exclusion both sides must apply before
// the inventory predicate runs, so a genuine command carrying its own
// definition is never folded — including when its inventory row has not synced.
describe("carriesOwnDefinitionEvidence", () => {
  it("excludes a row carrying a definition hash", () => {
    expect(
      carriesOwnDefinitionEvidence({ definitionHash: "a".repeat(64) })
    ).toBe(true);
  });

  it("excludes a row carrying definition content", () => {
    expect(
      carriesOwnDefinitionEvidence({ definitionContent: "# Deploy it" })
    ).toBe(true);
  });

  it("does not treat whitespace-only content as a definition", () => {
    expect(carriesOwnDefinitionEvidence({ definitionContent: "   \n" })).toBe(
      false
    );
  });

  // Absence is NOT proof of a phantom — the leading-slash-run population has
  // neither field and is protected by the collector's own witness instead.
  it("is false for a row carrying neither signal", () => {
    expect(
      carriesOwnDefinitionEvidence({
        definitionContent: null,
        definitionHash: null,
      })
    ).toBe(false);
    expect(carriesOwnDefinitionEvidence({})).toBe(false);
  });
});
