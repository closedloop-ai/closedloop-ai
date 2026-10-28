/**
 * @file ISS-11283 branch coverage for
 * agent-monitor/agent-monitor-hooks-core.ts paths the existing suite
 * (agent-monitor-hooks-core.test.ts) never exercises: commandReferences'
 * defensive entry-shape guard and its top-level `.command` match (every
 * production entry nests `command` under `hooks[]`, never top-level),
 * applyHookUninstall's no-`hooks`-block and non-array-hook-list guards, and
 * every catch-block ternary in the lifecycle (installHooks/uninstallHooks
 * throwing an Error vs a non-Error, on both the enable/disable path and both
 * boot self-heal branches), plus the kill-switch-on-but-user-disabled early
 * return in syncAgentMonitorHooksOnBoot.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHookUninstall,
  createAgentMonitorHooksLifecycle,
  isClaudeEntry,
} from "../src/main/agent-monitor/agent-monitor-hooks-core.js";

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iss11283-hooks-core-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("commandReferences / isClaudeEntry: entry-shape and top-level-command branches", () => {
  it("returns false for a non-object entry (null, string, number)", () => {
    expect(isClaudeEntry(null)).toBe(false);
    expect(isClaudeEntry("just a string")).toBe(false);
    expect(isClaudeEntry(42)).toBe(false);
  });

  it("matches a TOP-LEVEL `.command` field directly, without a nested hooks[] array", () => {
    // No production factory (makeClaudeHookEntry) ever sets a top-level
    // `.command` — it always nests under `hooks: [{ command }]` — so this is
    // the direct-match arm a legacy or hand-authored entry shape would take.
    const entry = {
      command: 'ELECTRON_RUN_AS_NODE=1 "/x" "/fake/hook-handler.js" "Stop"',
    };
    expect(isClaudeEntry(entry)).toBe(true);
  });

  it("returns false when neither a top-level command nor a hooks[] array is present", () => {
    expect(isClaudeEntry({ foo: "bar" })).toBe(false);
    expect(isClaudeEntry({ command: 123, hooks: "not-an-array" })).toBe(false);
  });

  it("returns false for a top-level command string that does not reference the handler filename", () => {
    expect(isClaudeEntry({ command: "some unrelated shell command" })).toBe(
      false
    );
  });
});

describe("applyHookUninstall: missing/malformed hooks-block guards", () => {
  it("is a no-op when the settings file exists but has no hooks block", () => {
    const file = join(tempRoot, "settings.json");
    writeFileSync(file, "{}", "utf8");
    const result = applyHookUninstall({ file, isOurEntry: isClaudeEntry });
    expect(result).toEqual({ removed: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it("skips a hook-type entry whose value is not an array", () => {
    const file = join(tempRoot, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ hooks: { PreToolUse: "not-an-array" } }),
      "utf8"
    );
    const result = applyHookUninstall({ file, isOurEntry: isClaudeEntry });
    expect(result).toEqual({ removed: 0 });
  });

  it("actually removes a matched entry and preserves a foreign one and the non-array entry (proves the file was read, not treated as missing)", () => {
    const file = join(tempRoot, "settings.json");
    const ownedCommand =
      'ELECTRON_RUN_AS_NODE=1 "/x" "/fake/hook-handler.js" "SessionStart"';
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: ownedCommand }] },
            { hooks: [{ type: "command", command: "foreign-command" }] },
          ],
          PreToolUse: "not-an-array",
        },
      }),
      "utf8"
    );
    const result = applyHookUninstall({ file, isOurEntry: isClaudeEntry });

    expect(result).toEqual({ removed: 1 });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(written.hooks.SessionStart).toHaveLength(1);
    expect(written.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      "foreign-command"
    );
  });
});

describe("createAgentMonitorHooksLifecycle: setAgentMonitorHooksEnabled catch ternaries", () => {
  it("reports error.message and 'enable' when installHooks throws an Error", () => {
    const errors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => false,
      setEnabled: () => {},
      installHooks: () => {
        throw new Error("install-boom");
      },
      uninstallHooks: () => [],
      onWarning: () => {},
      onError: (message) => errors.push(message),
      onBootRepairError: () => {},
    });

    const result = lifecycle.setAgentMonitorHooksEnabled(true);

    expect(result).toEqual({
      ok: false,
      enabled: false,
      error: "install-boom",
    });
    expect(errors).toEqual(["failed to enable hooks: install-boom"]);
  });

  it("reports String(error) and 'disable' when uninstallHooks throws a non-Error value", () => {
    const errors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => true,
      setEnabled: () => {},
      installHooks: () => [],
      uninstallHooks: () => {
        // biome-ignore lint/style/useThrowOnlyError: pins the non-Error catch branch
        throw "uninstall-boom-string";
      },
      onWarning: () => {},
      onError: (message) => errors.push(message),
      onBootRepairError: () => {},
    });

    const result = lifecycle.setAgentMonitorHooksEnabled(false);

    expect(result).toEqual({
      ok: false,
      enabled: true,
      error: "uninstall-boom-string",
    });
    expect(errors).toEqual(["failed to disable hooks: uninstall-boom-string"]);
  });
});

describe("createAgentMonitorHooksLifecycle: syncAgentMonitorHooksOnBoot branches", () => {
  it("returns early without installing when the kill switch is on but the user's own toggle is off", () => {
    let installCalls = 0;
    const bootErrors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => false,
      setEnabled: () => {},
      installHooks: () => {
        installCalls += 1;
        return [];
      },
      uninstallHooks: () => [],
      onWarning: () => {},
      onError: () => {},
      onBootRepairError: (message) => bootErrors.push(message),
      isHookPathEnabled: () => true,
    });

    lifecycle.syncAgentMonitorHooksOnBoot();

    expect(installCalls).toBe(0);
    expect(bootErrors).toEqual([]);
  });

  it("logs error.message via onBootRepairError when installHooks throws an Error (hooks enabled)", () => {
    const bootErrors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => true,
      setEnabled: () => {},
      installHooks: () => {
        throw new Error("boot-repair-boom");
      },
      uninstallHooks: () => [],
      onWarning: () => {},
      onError: () => {},
      onBootRepairError: (message) => bootErrors.push(message),
      isHookPathEnabled: () => true,
    });

    lifecycle.syncAgentMonitorHooksOnBoot();

    expect(bootErrors).toEqual(["boot hook repair failed: boot-repair-boom"]);
  });

  it("logs String(error) via onBootRepairError when installHooks throws a non-Error value (hooks enabled)", () => {
    const bootErrors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => true,
      setEnabled: () => {},
      installHooks: () => {
        // biome-ignore lint/style/useThrowOnlyError: pins the non-Error catch branch
        throw "boot-repair-boom-string";
      },
      uninstallHooks: () => [],
      onWarning: () => {},
      onError: () => {},
      onBootRepairError: (message) => bootErrors.push(message),
      isHookPathEnabled: () => true,
    });

    lifecycle.syncAgentMonitorHooksOnBoot();

    expect(bootErrors).toEqual([
      "boot hook repair failed: boot-repair-boom-string",
    ]);
  });

  it("logs error.message via onBootRepairError when the kill-switch-off self-heal uninstall throws an Error", () => {
    const bootErrors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => true,
      setEnabled: () => {},
      installHooks: () => [],
      uninstallHooks: () => {
        throw new Error("kill-switch-uninstall-boom");
      },
      onWarning: () => {},
      onError: () => {},
      onBootRepairError: (message) => bootErrors.push(message),
      isHookPathEnabled: () => false,
    });

    lifecycle.syncAgentMonitorHooksOnBoot();

    expect(bootErrors).toEqual([
      "boot hook uninstall failed: kill-switch-uninstall-boom",
    ]);
  });

  it("logs String(error) via onBootRepairError when the kill-switch-off self-heal uninstall throws a non-Error value", () => {
    const bootErrors: string[] = [];
    const lifecycle = createAgentMonitorHooksLifecycle({
      getEnabled: () => true,
      setEnabled: () => {},
      installHooks: () => [],
      uninstallHooks: () => {
        // biome-ignore lint/style/useThrowOnlyError: pins the non-Error catch branch
        throw "kill-switch-uninstall-boom-string";
      },
      onWarning: () => {},
      onError: () => {},
      onBootRepairError: (message) => bootErrors.push(message),
      isHookPathEnabled: () => false,
    });

    lifecycle.syncAgentMonitorHooksOnBoot();

    expect(bootErrors).toEqual([
      "boot hook uninstall failed: kill-switch-uninstall-boom-string",
    ]);
  });
});
