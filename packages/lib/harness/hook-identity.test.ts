import { describe, expect, it } from "vitest";
import { hookComponentKey, normalizeHookCommand } from "./hook-identity";

// The literal `${CLAUDE_PLUGIN_ROOT}` placeholder, assembled from parts so the
// source has no `${…}` sequence Biome flags as a mistaken template string.
const PLUGIN_ROOT = `$${"{CLAUDE_PLUGIN_ROOT}"}`;
const NO_HOME_INTERIOR = /testuser6/;

describe("normalizeHookCommand (FEA-4093)", () => {
  it("returns null for a null or empty command", () => {
    expect(normalizeHookCommand(null)).toBeNull();
    expect(normalizeHookCommand("")).toBeNull();
    expect(normalizeHookCommand("   ")).toBeNull();
  });

  it("keeps a bare command with no path unchanged", () => {
    expect(normalizeHookCommand("rtk hook claude")).toBe("rtk hook claude");
  });

  it("preserves the portable CLAUDE_PLUGIN_ROOT token", () => {
    expect(
      normalizeHookCommand(`${PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`)
    ).toBe(`${PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`);
  });

  it("canonicalizes bare $CLAUDE_PLUGIN_ROOT to the braced token", () => {
    expect(normalizeHookCommand("$CLAUDE_PLUGIN_ROOT/hooks/x.sh")).toBe(
      `${PLUGIN_ROOT}/hooks/x.sh`
    );
  });

  it("masks a Linux /home/<user>/ prefix to ~", () => {
    expect(
      normalizeHookCommand(
        "python3 /home/testuser6/.claude/scripts/track-tokens.py"
      )
    ).toBe("python3 ~/.claude/scripts/track-tokens.py");
  });

  it("masks a macOS /Users/<user>/ prefix to ~", () => {
    expect(
      normalizeHookCommand("python3 /Users/someone/.claude/scripts/track.py")
    ).toBe("python3 ~/.claude/scripts/track.py");
  });

  it("resolves the same handler on two machines to one identity", () => {
    const linux = normalizeHookCommand(
      "/home/alice/.claude/hooks/notify.sh --x"
    );
    const mac = normalizeHookCommand("/Users/bob/.claude/hooks/notify.sh --x");
    expect(linux).toBe("~/.claude/hooks/notify.sh --x");
    expect(mac).toBe(linux);
  });

  it("leaves an existing ~ home prefix as the canonical sentinel", () => {
    expect(normalizeHookCommand("~/.claude/hooks/cbm-session-reminder")).toBe(
      "~/.claude/hooks/cbm-session-reminder"
    );
  });

  it("masks a $HOME prefix to ~", () => {
    expect(normalizeHookCommand("$HOME/.claude/hooks/x.sh")).toBe(
      "~/.claude/hooks/x.sh"
    );
  });

  it("masks a home path inside a quoted interpreter argument", () => {
    expect(
      normalizeHookCommand('node "/Users/dev/.claude/hooks/profiler.mjs"')
    ).toBe('node "~/.claude/hooks/profiler.mjs"');
  });

  it("collapses interior whitespace and trims surrounding whitespace", () => {
    expect(normalizeHookCommand("  rtk   hook  claude  ")).toBe(
      "rtk hook claude"
    );
  });

  it("does not rewrite an unrelated interior /home substring", () => {
    // No path boundary before /home, and no trailing slash after the token.
    expect(normalizeHookCommand("echo nohomehere")).toBe("echo nohomehere");
  });
});

describe("hookComponentKey (FEA-4093)", () => {
  it("is hookName alone when there is no command", () => {
    expect(hookComponentKey("PostToolUse:Edit", null)).toBe("PostToolUse:Edit");
  });

  it("appends the normalized command as a per-handler discriminator", () => {
    expect(hookComponentKey("PreToolUse:Bash", "rtk hook claude")).toBe(
      "PreToolUse:Bash rtk hook claude"
    );
  });

  it("keeps distinct handlers on the same matcher distinct", () => {
    const a = hookComponentKey("PreToolUse:Bash", "rtk hook claude");
    const b = hookComponentKey(
      "PreToolUse:Bash",
      `${PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`
    );
    expect(a).not.toBe(b);
  });

  it("does not leak a machine-specific home path into the key", () => {
    const key = hookComponentKey(
      "PostToolUse:Bash",
      "python3 /home/testuser6/.claude/scripts/track-tokens.py"
    );
    expect(key).toBe(
      "PostToolUse:Bash python3 ~/.claude/scripts/track-tokens.py"
    );
    expect(key).not.toMatch(NO_HOME_INTERIOR);
  });
});
