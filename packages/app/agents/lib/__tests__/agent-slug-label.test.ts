import { describe, expect, it } from "vitest";
import {
  agentBreadcrumbLabel,
  detailHeaderSubtitle,
  normalizeAgentSlug,
} from "../agent-slug-label";

describe("agentBreadcrumbLabel (FEA-3977)", () => {
  it("shows the identity key, not the internal `kind::` prefix", () => {
    expect(agentBreadcrumbLabel("tool::_add_comment_to_issue")).toBe(
      "_add_comment_to_issue"
    );
    expect(agentBreadcrumbLabel("subagent::my-agent")).toBe("my-agent");
  });

  it("never renders our internal `kind::` identity in the crumb", () => {
    expect(agentBreadcrumbLabel("tool::read")).not.toContain("::");
  });

  it("leaves a key that legitimately contains a `%` untouched (no decode)", () => {
    // `load%20test` is a valid normalized key; decoding it would corrupt it to
    // `load test`. Next already decodes the route param, so this stays raw.
    expect(agentBreadcrumbLabel("tool::load%20test")).toBe("load%20test");
  });

  it("falls back to the whole slug when there is no `::` separator", () => {
    expect(agentBreadcrumbLabel("plain-name")).toBe("plain-name");
  });

  // FEA-4335: a content-hash route's `::`-suffix is a 64-hex digest, not a name.
  const HASH_SLUG = `tool::${"a".repeat(64)}`;

  it("never renders the 64-hex content-hash digest as the crumb", () => {
    const label = agentBreadcrumbLabel(HASH_SLUG);
    expect(label).not.toContain("a".repeat(64));
    expect(label).toBe("Agent");
  });

  it("prefers the resolved component name over the content-hash digest", () => {
    expect(agentBreadcrumbLabel(HASH_SLUG, "My Reviewer")).toBe("My Reviewer");
  });

  it("prefers the resolved name for a legacy name-level slug too", () => {
    expect(agentBreadcrumbLabel("tool::read", "Read File")).toBe("Read File");
  });

  it("ignores a blank resolved name and keeps the legacy key suffix", () => {
    expect(agentBreadcrumbLabel("tool::read", "   ")).toBe("read");
  });

  // ISS-4776: when the whole `kind::key` identity arrived percent-ENCODED
  // (a router hop double-encoded the segment), the crumb must decode it and
  // never leak `%3A%3A`/`%2F` into the UI.
  describe("percent-encoded slug (ISS-4776)", () => {
    const ENCODED_SLUG = "command%3A%3A%2F%2Fcl-ci-babysit";

    it("decodes the mangled slug and shows the identity key, no percent-encoding", () => {
      const label = agentBreadcrumbLabel(ENCODED_SLUG);
      // The decoded key is the identity `key` (`//cl-ci-babysit`), not the raw
      // `%3A%3A%2F%2F` blob nor the `command::` prefix.
      expect(label).toBe("//cl-ci-babysit");
      expect(label).not.toContain("%3A");
      expect(label).not.toContain("%2F");
      expect(label).not.toContain("::");
    });

    it("prefers the resolved component name over the mangled slug", () => {
      const label = agentBreadcrumbLabel(ENCODED_SLUG, "/cl-ci-babysit");
      expect(label).toBe("/cl-ci-babysit");
      expect(label).not.toContain("%3A");
      expect(label).not.toContain("%2F");
    });

    it("decodes an encoded content-hash slug to the neutral fallback, not the digest", () => {
      const label = agentBreadcrumbLabel(`tool%3A%3A${"a".repeat(64)}`);
      expect(label).toBe("Agent");
      expect(label).not.toContain("%3A");
    });

    it("leaves a legitimate literal `%` key untouched (only the separator is repaired)", () => {
      // `load%20test` carries a literal `::`, so the repair never fires and the
      // `%20` in the key is preserved (decoding it would corrupt the key).
      expect(agentBreadcrumbLabel("tool::load%20test")).toBe("load%20test");
    });

    it("falls back to the raw slug when a malformed percent sequence cannot decode", () => {
      // A lone `%` with no valid hex pair makes decodeURIComponent throw; the
      // crumb must not crash and simply keeps the raw value.
      expect(agentBreadcrumbLabel("plain%name")).toBe("plain%name");
    });
  });
});

describe("detailHeaderSubtitle (FEA-3978)", () => {
  it("uses the path when it differs from the name", () => {
    // ISS-4805: a WORKSPACE-RELATIVE path. An absolute one is no longer an
    // admissible subtitle — see the ISS-4805 block below.
    expect(
      detailHeaderSubtitle({
        name: "My Agent",
        path: ".claude/agents/my-agent.md",
        slug: "subagent::my-agent",
      })
    ).toBe(".claude/agents/my-agent.md");
  });

  it("falls back to the identity key when the path equals the name", () => {
    // The identity key is a distinct locator from the display name, so it adds
    // information the title does not.
    expect(
      detailHeaderSubtitle({
        name: "Add comment to issue",
        path: "Add comment to issue",
        slug: "tool::_add_comment_to_issue",
      })
    ).toBe("_add_comment_to_issue");
  });

  it("falls back to the identity key when the path is empty", () => {
    expect(
      detailHeaderSubtitle({
        name: "readme",
        path: "",
        slug: "tool::my-tool",
      })
    ).toBe("my-tool");
  });

  it("omits the subtitle when path and key would only restate the name", () => {
    expect(
      detailHeaderSubtitle({
        name: "my-tool",
        path: "my-tool",
        slug: "tool::my-tool",
      })
    ).toBeNull();
  });

  it("omits the subtitle when the key restates the name only in a different case", () => {
    // Orphan path sets name = key, but the normalized key is lowercased, so a
    // title-cased name and its lowercase key must still count as identical.
    expect(
      detailHeaderSubtitle({
        name: "Explore",
        path: "explore",
        slug: "subagent::explore",
      })
    ).toBeNull();
  });

  it("treats a whitespace-padded duplicate as identical to the name", () => {
    expect(
      detailHeaderSubtitle({
        name: "my-tool",
        path: "  my-tool  ",
        slug: "tool::my-tool",
      })
    ).toBeNull();
  });
});

/**
 * ISS-4805 — a machine-absolute definition path is never published to the
 * org-shared header.
 *
 * The path is captured on whichever machine discovered the definition, so it can
 * be an absolute per-user path. This catalog is shared org-wide, so rendering it
 * disclosed the author's username and their machine's directory layout to every
 * member who opened the component — while telling the reader nothing actionable,
 * since the path does not resolve on their machine.
 */
describe("detailHeaderSubtitle path disclosure (ISS-4805)", () => {
  /** The exact value observed in production. */
  const LEAKED_PATH =
    "/Users/mike.angstadt/Code/hermes-agent/optional-skills/security/1password/SKILL.md";

  it("never renders the absolute home path observed in production", () => {
    // `?? ""`: dropping the subtitle entirely is also a pass — the assertion is
    // that nothing machine-specific is rendered, not that something is.
    const subtitle =
      detailHeaderSubtitle({
        name: "1password",
        path: LEAKED_PATH,
        slug: "skill::1password",
      }) ?? "";

    expect(subtitle).not.toBe(LEAKED_PATH);
    expect(subtitle).not.toContain("mike.angstadt");
    expect(subtitle).not.toContain("/Users/");
  });

  it("falls back to the portable identity key instead", () => {
    expect(
      detailHeaderSubtitle({
        name: "1password",
        path: LEAKED_PATH,
        slug: "skill::1password-security",
      })
    ).toBe("1password-security");
  });

  it("drops the subtitle entirely when the key would only restate the name", () => {
    expect(
      detailHeaderSubtitle({
        name: "1password",
        path: LEAKED_PATH,
        slug: "skill::1password",
      })
    ).toBeNull();
  });

  it.each([
    ["/home/dev/agents/a.md"],
    ["~/agents/a.md"],
    ["C:\\Users\\dev\\agents\\a.md"],
    ["\\\\share\\agents\\a.md"],
  ])("rejects the machine-absolute path %j", (path) => {
    expect(
      detailHeaderSubtitle({ name: "a", path, slug: "subagent::a-key" })
    ).toBe("a-key");
  });

  it.each([
    [".claude/agents/a.md"],
    ["agents/a.md"],
    ["packages/app/agents/a.md"],
  ])("still renders the workspace-relative path %j", (path) => {
    expect(
      detailHeaderSubtitle({ name: "a", path, slug: "subagent::a-key" })
    ).toBe(path);
  });
});

// ISS-5518: one screen, two opposite rulings on one value — the crumb refused to
// print the content-hash digest (FEA-4335) while the subtitle printed all 64 hex
// characters of it. `routableKey` makes the content-hash slug the DEFAULT route
// shape, so this was every agent with a captured definition, not an edge case.
describe("detailHeaderSubtitle content-hash identity (ISS-5518)", () => {
  const HASH_SLUG = `skill::${"c".repeat(64)}`;

  it("never publishes the 64-hex digest under the title", () => {
    const subtitle = detailHeaderSubtitle({
      honest: true,
      name: "My Skill",
      // No definition path captured — the case that fell through to the key.
      path: "",
      slug: HASH_SLUG,
    });

    expect(subtitle).toBeNull();
  });

  it("still prefers a real definition path over dropping the subtitle", () => {
    // Suppression applies to the KEY fallback only. A content-hash route with a
    // captured path still has something worth saying, and losing it would trade
    // one silent screen for another.
    expect(
      detailHeaderSubtitle({
        honest: true,
        name: "My Skill",
        path: ".claude/skills/my-skill/SKILL.md",
        slug: HASH_SLUG,
      })
    ).toBe(".claude/skills/my-skill/SKILL.md");
  });

  it("leaves a legacy name-level slug's key fallback alone", () => {
    // A non-digest suffix IS the human key and is the whole point of the
    // fallback; only a digest is unreadable.
    expect(
      detailHeaderSubtitle({
        honest: true,
        name: "Read",
        path: "",
        slug: "tool::_read_file",
      })
    ).toBe("_read_file");
  });

  it("flag OFF still prints the digest, exactly as it shipped", () => {
    expect(
      detailHeaderSubtitle({ name: "My Skill", path: "", slug: HASH_SLUG })
    ).toBe("c".repeat(64));
  });
});

describe("normalizeAgentSlug (ISS-4776)", () => {
  it("decodes a double-encoded slug back to its literal `kind::key` identity", () => {
    // This is the identity the detail fetch and token-trend fetch key off, so it
    // must resolve to the same literal `::`-bearing value the breadcrumb shows —
    // not stay `%3A%3A%2F%2F`-encoded (which the API lookup would miss, 404ing
    // the body under a crumb that already decoded).
    expect(normalizeAgentSlug("command%3A%3A%2F%2Fcl-ci-babysit")).toBe(
      "command:://cl-ci-babysit"
    );
  });

  it("leaves an already-decoded slug (literal `::`) untouched", () => {
    expect(normalizeAgentSlug("tool::_add_comment_to_issue")).toBe(
      "tool::_add_comment_to_issue"
    );
  });

  it("leaves a key with a legitimate literal `%` untouched (it already has `::`)", () => {
    // `load%20test` carries a literal `::`, so the repair never fires and the
    // `%20` is preserved — decoding it would corrupt the key to `load test`.
    expect(normalizeAgentSlug("tool::load%20test")).toBe("tool::load%20test");
  });

  it("leaves a `%`-bearing slug that does not decode to a `::` untouched", () => {
    // No literal `::` and decoding never reveals one, so it is not a mangled
    // identity — keep it raw.
    expect(normalizeAgentSlug("just%20a%20name")).toBe("just%20a%20name");
  });

  it("returns the raw slug when a malformed percent sequence cannot decode", () => {
    expect(normalizeAgentSlug("plain%name")).toBe("plain%name");
  });
});
