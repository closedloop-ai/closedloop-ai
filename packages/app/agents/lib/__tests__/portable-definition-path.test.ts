import { describe, expect, it } from "vitest";
import { portableDefinitionPath } from "../portable-definition-path";

/**
 * ISS-4805 — the org-shared rendering of a captured definition path.
 *
 * Two failures are in scope and the helper must avoid BOTH: publishing a
 * teammate's machine-rooted prefix to the whole org, and blanking the location
 * line for the common production case (an absolute `installPath`).
 */
describe("portableDefinitionPath", () => {
  it.each([
    [".claude/skills/foo/SKILL.md"],
    ["agents/a.md"],
    ["packages/app/agents/a.md"],
  ])("returns a workspace-relative path unchanged (%j)", (value) => {
    expect(portableDefinitionPath(value)).toBe(value);
  });

  it("trims surrounding whitespace on a relative path", () => {
    expect(portableDefinitionPath("  .claude/agents/a.md  ")).toBe(
      ".claude/agents/a.md"
    );
  });

  it.each([
    [
      "/Users/someone/Code/proj/.claude/skills/foo/SKILL.md",
      ".claude/skills/foo/SKILL.md",
    ],
    ["/home/dev/work/.codex/prompts/p.md", ".codex/prompts/p.md"],
    ["~/.agents/skills/s/SKILL.md", ".agents/skills/s/SKILL.md"],
    ["/Users/someone/proj/.opencode/agent/a.md", ".opencode/agent/a.md"],
  ])("reduces the machine-absolute %j to its portable tail", (value, tail) => {
    expect(portableDefinitionPath(value)).toBe(tail);
  });

  it("normalizes a Windows capture to forward slashes", () => {
    expect(
      portableDefinitionPath(String.raw`C:\Users\dev\proj\.claude\agents\a.md`)
    ).toBe(".claude/agents/a.md");
  });

  it("anchors on the OUTERMOST config root for a plugin-vendored definition", () => {
    // A plugin nests one config root inside another; the outer one is what makes
    // the whole locator readable, so the tail must start there.
    expect(
      portableDefinitionPath(
        "/Users/someone/.claude/plugins/cache/pack/.claude/skills/s/SKILL.md"
      )
    ).toBe(".claude/plugins/cache/pack/.claude/skills/s/SKILL.md");
  });

  it.each([
    ["/Users/mike.angstadt/Code/hermes-agent/optional/1password/SKILL.md"],
    ["/home/dev/agents/a.md"],
    ["~/agents/a.md"],
    [String.raw`C:\Users\dev\agents\a.md`],
    [String.raw`\\share\agents\a.md`],
  ])("returns null when nothing in %j is portable", (value) => {
    expect(portableDefinitionPath(value)).toBeNull();
  });

  it.each([[""], ["   "]])("returns null for the empty path %j", (value) => {
    expect(portableDefinitionPath(value)).toBeNull();
  });

  it("never leaks a machine-rooted prefix for any absolute input", () => {
    // The property that matters: whatever comes back, it is not rooted on the
    // capturing machine. A future anchor added to the set stays covered.
    const leaked =
      "/Users/mike.angstadt/Code/proj/.claude/skills/security/SKILL.md";
    const rendered = portableDefinitionPath(leaked) ?? "";

    expect(rendered).not.toContain("mike.angstadt");
    expect(rendered).not.toContain("/Users/");
    expect(rendered.startsWith("/")).toBe(false);
  });
});
