import { describe, expect, it } from "vitest";
import {
  decodeComponentSlug,
  encodeComponentSlug,
  normalizeComponentKey,
} from "../agent-component-analytics";

// This codec is a cross-surface CONTRACT: desktop (`apps/desktop`) and cloud
// (`apps/api`) must encode/decode the org-identity slug identically or component
// identities silently mismatch between the two surfaces. These tests pin the
// `::` separator and the `(componentKey ?? name ?? "").toLowerCase().trim()`
// normalization so the SSOT can never drift from either consumer (FEA-3039).

describe("normalizeComponentKey", () => {
  it("prefers componentKey, lowercases and trims", () => {
    expect(normalizeComponentKey("  MyKey  ")).toBe("mykey");
  });

  it("falls back to name when componentKey is null/undefined", () => {
    expect(normalizeComponentKey(null, "  DisplayName ")).toBe("displayname");
    expect(normalizeComponentKey(undefined, "Other")).toBe("other");
  });

  it("returns an empty string when both are nullish", () => {
    expect(normalizeComponentKey(null, null)).toBe("");
    expect(normalizeComponentKey(undefined)).toBe("");
  });
});

describe("encodeComponentSlug", () => {
  it("encodes kind and normalized key joined by the :: separator", () => {
    expect(encodeComponentSlug("subagent", "  Reviewer  ")).toBe(
      "subagent::reviewer"
    );
  });

  it("uses the name fallback for the key half", () => {
    expect(encodeComponentSlug("command", null, "Deploy")).toBe(
      "command::deploy"
    );
  });

  it("preserves the kind verbatim while normalizing only the key", () => {
    expect(encodeComponentSlug("MCP", "Server", null)).toBe("MCP::server");
  });
});

describe("decodeComponentSlug", () => {
  it("splits on the first `::` separator", () => {
    expect(decodeComponentSlug("skill::my-skill")).toEqual({
      kind: "skill",
      key: "my-skill",
    });
  });

  it("keeps `::` occurrences inside the key intact", () => {
    expect(decodeComponentSlug("plugin::a::b")).toEqual({
      kind: "plugin",
      key: "a::b",
    });
  });

  it("returns null for a slug with no separator", () => {
    expect(decodeComponentSlug("no-separator")).toBeNull();
  });

  it("round-trips with encodeComponentSlug", () => {
    const slug = encodeComponentSlug("hook", "  PreCommit  ");
    expect(slug).toBe("hook::precommit");
    expect(decodeComponentSlug(slug)).toEqual({
      kind: "hook",
      key: "precommit",
    });
  });
});

// FEA-3117: `apps/api/app/agent-components/service.ts` previously carried a
// byte-identical local copy of this codec (`orgIdentitySlug` /
// `identitySlugFromSlug`) that has been removed in favour of this SSOT. These
// cases pin the exact call shapes that cloud consumer relies on so the
// consolidation stays behaviour-preserving and can never silently drift.
describe("encodeComponentSlug — consolidated cloud-consumer call shapes", () => {
  it("is idempotent for already-normalized keys (callers pass normKey)", () => {
    // The list-view fold pre-normalizes the key before encoding; re-normalizing
    // an already-normalized value must be a no-op.
    const normKey = normalizeComponentKey("  Reviewer  ");
    expect(normKey).toBe("reviewer");
    expect(encodeComponentSlug("subagent", normKey, "Reviewer")).toBe(
      encodeComponentSlug("subagent", "  Reviewer  ", "Reviewer")
    );
  });

  it("matches the removed orgIdentitySlug output across a (kind, key) matrix", () => {
    // Reference implementation = the exact logic deleted from service.ts.
    const legacy = (
      kind: string,
      key: string | null,
      name: string | null
    ): string => `${kind}::${(key ?? name ?? "").toLowerCase().trim()}`;
    const cases: [string, string | null, string | null][] = [
      ["subagent", "  General-Purpose  ", "General Purpose"],
      ["command", null, "Deploy"],
      ["skill", "MyKey", null],
      ["MCP", null, null],
      ["hook", "a::b", "ignored"],
    ];
    for (const [kind, key, name] of cases) {
      expect(encodeComponentSlug(kind, key, name)).toBe(
        legacy(kind, key, name)
      );
    }
  });

  it("orphan-usage path (null name arg) still normalizes the key", () => {
    // Mirrors `encodeComponentSlug(usage.componentKind, normKey, null)`.
    expect(encodeComponentSlug("command", "Build", null)).toBe(
      "command::build"
    );
  });
});
