import { describe, expect, it } from "vitest";
import {
  decodeComponentHashKey,
  decodeComponentSlug,
  encodeComponentSlug,
  normalizeComponentKey,
  routableComponentHashKey,
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

// FEA-4335: a component's IDENTITY is its content byte hash (Mike Angstadt's
// product decision) — two components are the SAME iff their content hashes are
// identical and DIFFERENT iff they differ, regardless of name, `kind::slug`, or
// install path. The routable detail-URI key must therefore key off the content
// fingerprint, not the name-level slug, so the pre-FEA-4335 `kind::slug`
// collision (two materially-different components normalizing to one name) is
// resolved while byte-identical installs (any name/path) share one identity.
describe("routableComponentHashKey — content-hash identity (FEA-4335)", () => {
  // sha256-length lowercase-hex content fingerprints for two DISTINCT contents.
  const hashDeployA = "a".repeat(64);
  const hashDeployB = "b".repeat(64);

  it("gives two same-named components with DIFFERENT content bytes DISTINCT keys", () => {
    // Both normalize to `skill::deploy` under the name-level slug — the exact
    // collision FEA-4335 fixes — but their content fingerprints differ, so the
    // routable keys must differ.
    const nameSlug = encodeComponentSlug("skill", "deploy", null);
    const keyA = routableComponentHashKey("skill", hashDeployA, "deploy", null);
    const keyB = routableComponentHashKey("skill", hashDeployB, "deploy", null);

    expect(keyA).not.toBe(keyB);
    // Neither content-hash key equals the colliding name-level slug.
    expect(keyA).not.toBe(nameSlug);
    expect(keyB).not.toBe(nameSlug);
    expect(keyA).toBe(`skill::${hashDeployA}`);
    expect(keyB).toBe(`skill::${hashDeployB}`);
  });

  it("gives two byte-identical installs (different name AND path) the SAME key", () => {
    // The identical `testing_agent.md` installed at two paths under two display
    // names is ONE tracked component: same bytes → same fingerprint → one key,
    // regardless of name/path.
    const atUserDir = routableComponentHashKey(
      "agent",
      hashDeployA,
      "testing_agent",
      "Testing Agent (user)"
    );
    const atPluginDir = routableComponentHashKey(
      "agent",
      hashDeployA,
      "gstack-testing-agent",
      "GStack Testing Agent (plugin)"
    );

    expect(atUserDir).toBe(atPluginDir);
    expect(atUserDir).toBe(`agent::${hashDeployA}`);
  });

  it("falls back to the name-level slug when the row has no content fingerprint (skew-safe)", () => {
    // A legacy / event-minted row with no captured definition keeps the
    // name-level routing so old links still resolve.
    expect(routableComponentHashKey("skill", null, "Deploy", null)).toBe(
      encodeComponentSlug("skill", "Deploy", null)
    );
    expect(routableComponentHashKey("command", undefined, null, "Build")).toBe(
      encodeComponentSlug("command", null, "Build")
    );
  });

  it("round-trips a content-hash key back to { kind, fingerprint }", () => {
    const key = routableComponentHashKey("skill", hashDeployA, "deploy", null);
    expect(decodeComponentHashKey(key)).toEqual({
      kind: "skill",
      fingerprint: hashDeployA,
      key: null,
    });
  });

  it("decodes a legacy name-level key back to { kind, key } (no fingerprint)", () => {
    const nameSlug = encodeComponentSlug("skill", "Deploy", null);
    expect(decodeComponentHashKey(nameSlug)).toEqual({
      kind: "skill",
      fingerprint: null,
      key: "deploy",
    });
  });

  it("returns null for a key with no `::` separator", () => {
    expect(decodeComponentHashKey("not-a-key")).toBeNull();
  });

  it("treats a short-hex NAME as a name, not a mis-read fingerprint", () => {
    // A legacy hash-less component literally named `deadbeef` must decode as a
    // NAME so its detail still resolves by name — only a full 64-char hex string
    // is a content fingerprint. Regression for the `{8,64}` over-match.
    const shortHexSlug = encodeComponentSlug("skill", "deadbeef", null);
    expect(decodeComponentHashKey(shortHexSlug)).toEqual({
      kind: "skill",
      fingerprint: null,
      key: "deadbeef",
    });
    // A 63-hex (one short of a sha256) name is also a name, not a fingerprint.
    const almost = encodeComponentSlug("skill", "c".repeat(63), null);
    expect(decodeComponentHashKey(almost)?.fingerprint).toBeNull();
    expect(decodeComponentHashKey(almost)?.key).toBe("c".repeat(63));
  });
});
