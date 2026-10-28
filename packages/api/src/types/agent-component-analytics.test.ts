import { describe, expect, it } from "vitest";
import { AgentComponentKind } from "./agent-component.ts";
import {
  decodeComponentHashKey,
  decodeComponentSlug,
  decodeFingerprintIdentityKey,
  encodeComponentSlug,
  fingerprintIdentityKey,
  normalizeComponentKey,
  resolveVersionFingerprint,
  routableComponentHashKey,
  routableComponentSlug,
  shortFingerprint,
  usageVersionIdentityKey,
} from "./agent-component-analytics.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("normalizeComponentKey", () => {
  it("prefers componentKey over name", () => {
    expect(normalizeComponentKey("  Foo  ", "Bar")).toBe("foo");
  });

  it("falls back to name when componentKey is null", () => {
    expect(normalizeComponentKey(null, " Bar ")).toBe("bar");
  });

  it("falls back to name when componentKey is undefined", () => {
    expect(normalizeComponentKey(undefined, "Bar")).toBe("bar");
  });

  it("resolves to empty string when both are absent", () => {
    expect(normalizeComponentKey(null)).toBe("");
    expect(normalizeComponentKey(undefined, null)).toBe("");
  });
});

describe("encodeComponentSlug / decodeComponentSlug", () => {
  it("encodes kind and normalized key", () => {
    expect(encodeComponentSlug(AgentComponentKind.Skill, "Deploy")).toBe(
      "skill::deploy"
    );
  });

  it("decodes a valid slug", () => {
    expect(decodeComponentSlug("skill::deploy")).toEqual({
      kind: AgentComponentKind.Skill,
      key: "deploy",
    });
  });

  it("returns null for a slug with no separator", () => {
    expect(decodeComponentSlug("skilldeploy")).toBeNull();
  });

  it("decodes only up to the first separator, keeping the rest in key", () => {
    // pins current behavior; looks odd because indexOf finds the FIRST "::",
    // so a key that itself contains "::" is not further split.
    expect(decodeComponentSlug("skill::deploy::extra")).toEqual({
      kind: AgentComponentKind.Skill,
      key: "deploy::extra",
    });
  });
});

describe("routableComponentSlug", () => {
  it("returns null when normalized identity is empty", () => {
    expect(
      routableComponentSlug(AgentComponentKind.Skill, null, null)
    ).toBeNull();
    expect(
      routableComponentSlug(AgentComponentKind.Skill, "", undefined)
    ).toBeNull();
  });

  it("returns the encoded slug when identity is present", () => {
    expect(routableComponentSlug(AgentComponentKind.Skill, "Deploy")).toBe(
      "skill::deploy"
    );
  });
});

describe("resolveVersionFingerprint", () => {
  it("prefers definitionHash over contentHash", () => {
    expect(resolveVersionFingerprint(HASH_A, HASH_B)).toBe(HASH_B);
  });

  it("falls back to contentHash when definitionHash is undefined", () => {
    expect(resolveVersionFingerprint(HASH_A, undefined)).toBe(HASH_A);
  });

  it("falls back to contentHash when definitionHash is null", () => {
    expect(resolveVersionFingerprint(HASH_A, null)).toBe(HASH_A);
  });

  it("returns null when neither is present", () => {
    expect(resolveVersionFingerprint(null, undefined)).toBeNull();
    expect(resolveVersionFingerprint(undefined)).toBeNull();
  });
});

describe("routableComponentHashKey", () => {
  it("keys off the content fingerprint when present", () => {
    expect(
      routableComponentHashKey(AgentComponentKind.Skill, HASH_A, "deploy")
    ).toBe(`skill::${HASH_A}`);
  });

  it("falls back to the name-level slug when fingerprint is null", () => {
    expect(
      routableComponentHashKey(AgentComponentKind.Skill, null, "Deploy")
    ).toBe("skill::deploy");
  });

  it("falls back to the name-level slug when fingerprint is undefined", () => {
    expect(
      routableComponentHashKey(AgentComponentKind.Skill, undefined, "Deploy")
    ).toBe("skill::deploy");
  });
});

describe("decodeComponentHashKey", () => {
  it("returns null for a key with no separator", () => {
    expect(decodeComponentHashKey("skilldeploy")).toBeNull();
  });

  it("decodes a 64-char hex segment as a content fingerprint", () => {
    expect(decodeComponentHashKey(`skill::${HASH_A}`)).toEqual({
      kind: AgentComponentKind.Skill,
      fingerprint: HASH_A,
      key: null,
    });
  });

  it("decodes a non-hex segment as a name key", () => {
    expect(decodeComponentHashKey("skill::deploy")).toEqual({
      kind: AgentComponentKind.Skill,
      fingerprint: null,
      key: "deploy",
    });
  });

  it("decodes a short lowercase-hex name as a name key, not a fingerprint", () => {
    expect(decodeComponentHashKey("skill::deadbeef")).toEqual({
      kind: AgentComponentKind.Skill,
      fingerprint: null,
      key: "deadbeef",
    });
  });

  it("decodes a 64-char but non-hex-looking segment as a name key", () => {
    const notHex = `g${HASH_A.slice(1)}`;
    expect(decodeComponentHashKey(`skill::${notHex}`)).toEqual({
      kind: AgentComponentKind.Skill,
      fingerprint: null,
      key: notHex,
    });
  });
});

describe("fingerprintIdentityKey", () => {
  it("appends the fingerprint when present", () => {
    expect(fingerprintIdentityKey("skill::deploy", HASH_A)).toBe(
      `skill::deploy@${HASH_A}`
    );
  });

  it("returns the bare slug when fingerprint is null", () => {
    expect(fingerprintIdentityKey("skill::deploy", null)).toBe("skill::deploy");
  });
});

describe("shortFingerprint", () => {
  it("returns the first 8 chars when present", () => {
    expect(shortFingerprint(HASH_A)).toBe(HASH_A.slice(0, 8));
  });

  it("returns null when fingerprint is null", () => {
    expect(shortFingerprint(null)).toBeNull();
  });
});

describe("usageVersionIdentityKey", () => {
  it("folds into the matching version bucket when a hash is resolvable", () => {
    expect(usageVersionIdentityKey("skill::deploy", HASH_A)).toBe(
      `skill::deploy@${HASH_A}`
    );
  });

  it("prefers definitionHash over componentVersionHash", () => {
    expect(usageVersionIdentityKey("skill::deploy", HASH_A, HASH_B)).toBe(
      `skill::deploy@${HASH_B}`
    );
  });

  it("stays on the name-level bucket when no hash resolves", () => {
    expect(usageVersionIdentityKey("skill::deploy", null, undefined)).toBe(
      "skill::deploy"
    );
  });
});

describe("decodeFingerprintIdentityKey", () => {
  it("decodes a qualified id into kind/key/fingerprint", () => {
    expect(decodeFingerprintIdentityKey(`skill::deploy@${HASH_A}`)).toEqual({
      kind: AgentComponentKind.Skill,
      key: "deploy",
      fingerprint: HASH_A,
    });
  });

  it("returns null when the base slug has no separator", () => {
    expect(decodeFingerprintIdentityKey("deploy")).toBeNull();
  });

  it("returns null when there is no '@' in the key", () => {
    expect(decodeFingerprintIdentityKey("skill::deploy")).toBeNull();
  });

  it("returns null when '@' is the first character of the key", () => {
    expect(decodeFingerprintIdentityKey(`skill::@${HASH_A}`)).toBeNull();
  });

  it("returns null when the trailing segment is not a full 64-hex fingerprint", () => {
    expect(decodeFingerprintIdentityKey("skill::deploy@notahash")).toBeNull();
  });
});
