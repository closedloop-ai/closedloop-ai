// Regression coverage for the electron-free hook-install core.
// The outer agent-monitor-hooks.ts shell imports `electron`, which the
// `tsx --test` runner cannot load. The core module owns the install/uninstall
// logic in isolation so the behavior contract — idempotent install, in-place
// self-heal of a moved handler path, and narrow-scope uninstall that leaves
// foreign entries alone — can be exercised here without an Electron runtime.

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  applyHookInstall,
  applyHookUninstall,
  createAgentMonitorHooksLifecycle,
  HOOK_TYPES,
  installAgentMonitorHooks,
  isClaudeEntry,
  makeClaudeHookEntry,
  uninstallAgentMonitorHooks,
} from "../src/main/agent-monitor-hooks-core.js";
import { getCodexConfigPath } from "../src/main/codex-home-paths.js";
import {
  buildManagedOtelBlock,
  type CodexOtelFileSystem,
} from "../src/main/codex-otel-config-core.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  type OtlpReceiverState,
} from "../src/main/otlp-receiver-state.js";
import {
  type AgentMonitorHooksWarning,
  AgentMonitorHooksWarningCode,
} from "../src/shared/contracts.js";

let tempRoot = "";
let previousCodexHome: string | undefined;
const FAKE_EXEC = "/fake/Electron";
const CLAUDE_HANDLER = "/fake/userData/agent-monitor/hook-handler.js";
const LIFECYCLE_LOGS_ENDPOINT_RE = /127\.0\.0\.1:54321/;
const LIFECYCLE_MANAGED_MARKER_RE = /closedloop_agent_monitor_managed = true/;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "fea1444-hooks-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = `${join(tempRoot, "codex")},${join(
    tempRoot,
    "ignored-codex"
  )}`;
});

afterEach(() => {
  restoreEnv("CODEX_HOME", previousCodexHome);
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("isClaudeEntry matches only its own handler entries", () => {
  const claudeCmd = `ELECTRON_RUN_AS_NODE=1 "${FAKE_EXEC}" "${CLAUDE_HANDLER}" "SessionStart"`;
  const otherCmd = `ELECTRON_RUN_AS_NODE=1 "${FAKE_EXEC}" "/fake/other-handler.js" "SessionStart"`;

  const claudeEntry = { hooks: [{ type: "command", command: claudeCmd }] };
  const otherEntry = { hooks: [{ type: "command", command: otherCmd }] };

  assert.equal(isClaudeEntry(claudeEntry), true);
  assert.equal(isClaudeEntry(otherEntry), false);
});

test("makeClaudeHookEntry applies '*' matcher only to gated events", () => {
  const tooled = makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, "PreToolUse");
  assert.equal(tooled.matcher, "*");
  const sessionStart = makeClaudeHookEntry(
    FAKE_EXEC,
    CLAUDE_HANDLER,
    "SessionStart"
  );
  assert.equal(sessionStart.matcher, undefined);
});

test("applyHookInstall creates a fresh settings file with all hook types", () => {
  const file = join(tempRoot, "settings.json");
  const result = applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });
  assert.equal(result.installed, HOOK_TYPES.length);
  assert.equal(result.repaired, 0);

  const settings = readJson(file) as {
    hooks: Record<string, unknown[]>;
  };
  for (const hookType of HOOK_TYPES) {
    assert.equal(settings.hooks[hookType].length, 1);
    assert.equal(isClaudeEntry(settings.hooks[hookType][0]), true);
  }
});

test("applyHookInstall is idempotent: re-running self-heals a moved handler path", () => {
  const file = join(tempRoot, "settings.json");
  // First install with the original path.
  applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });

  // Simulate the .app moving: re-install with a different handler path. The
  // stale entry must be replaced in place (NOT appended) so the file does
  // not grow unboundedly across upgrades.
  const newHandler = "/fake/userData2/agent-monitor/hook-handler.js";
  const result = applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, newHandler, h),
  });
  assert.equal(result.installed, 0);
  assert.equal(result.repaired, HOOK_TYPES.length);

  const settings = readJson(file) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  for (const hookType of HOOK_TYPES) {
    assert.equal(settings.hooks[hookType].length, 1);
    const cmd = settings.hooks[hookType][0].hooks[0].command;
    assert.match(cmd, /userData2/);
  }
});

test("applyHookInstall preserves user-installed foreign entries", () => {
  const file = join(tempRoot, "settings.json");
  // Pre-seed a foreign entry the user installed themselves.
  writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "echo my-own-thing" }] },
        ],
      },
    })
  );

  applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });

  const settings = readJson(file) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  // Foreign entry must still be present alongside ours.
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(
    settings.hooks.PreToolUse[0].hooks[0].command,
    "echo my-own-thing"
  );
  assert.equal(isClaudeEntry(settings.hooks.PreToolUse[1]), true);
});

test("applyHookUninstall removes only our entries and preserves foreign ones", () => {
  const file = join(tempRoot, "settings.json");
  // Install ours, then add a foreign entry.
  applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });
  const seeded = readJson(file) as {
    hooks: Record<string, unknown[]>;
  };
  seeded.hooks.PreToolUse.push({
    hooks: [{ type: "command", command: "echo my-own-thing" }],
  });
  writeFileSync(file, JSON.stringify(seeded));

  const result = applyHookUninstall({ file, isOurEntry: isClaudeEntry });
  assert.equal(result.removed, HOOK_TYPES.length);

  const after = readJson(file) as {
    hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  // The only surviving event is PreToolUse, with only the foreign entry.
  assert.deepEqual(Object.keys(after.hooks ?? {}), ["PreToolUse"]);
  assert.equal(after.hooks?.PreToolUse.length, 1);
  assert.equal(
    after.hooks?.PreToolUse[0].hooks[0].command,
    "echo my-own-thing"
  );
});

test("applyHookUninstall deletes the hooks block when nothing remains", () => {
  const file = join(tempRoot, "settings.json");
  applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });
  applyHookUninstall({ file, isOurEntry: isClaudeEntry });

  const after = readJson(file);
  assert.equal(
    Object.hasOwn(after, "hooks"),
    false,
    "outer `hooks` block must be removed when no entries remain"
  );
});

test("applyHookUninstall is a no-op when the settings file does not exist", () => {
  const result = applyHookUninstall({
    file: join(tempRoot, "does-not-exist.json"),
    isOurEntry: isClaudeEntry,
  });
  assert.equal(result.removed, 0);
});

test("applyHookUninstall removes only entries matched by isOurEntry", () => {
  // Defensive check: the filename-boundary predicate must remove only our own
  // handler entries and preserve any foreign entry that shares the file.
  const file = join(tempRoot, "settings.json");
  applyHookInstall({
    file,
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (h) => makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, h),
  });
  // Inject a foreign entry under PreToolUse that isClaudeEntry must not match.
  const settings = readJson(file) as { hooks: Record<string, unknown[]> };
  settings.hooks.PreToolUse.push({
    hooks: [{ type: "command", command: "/fake/other-handler.js" }],
  });
  writeFileSync(file, JSON.stringify(settings));

  applyHookUninstall({ file, isOurEntry: isClaudeEntry });

  const after = readJson(file) as { hooks: Record<string, unknown[]> };
  assert.equal(
    after.hooks.PreToolUse.length,
    1,
    "uninstall must keep the foreign PreToolUse entry and remove only ours"
  );
});

test("setAgentMonitorHooksEnabled installs Claude hooks and returns receiver-unavailable Codex warning", () => {
  const context = makeLifecycle();
  const result = context.lifecycle.setAgentMonitorHooksEnabled(true);

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(context.getEnabled(), true);
  assert.equal(
    result.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelReceiverUnavailable
  );
  assert.equal(context.loggedWarnings.length, 1);
  assert.equal(existsSync(getCodexConfigPath()), false);

  const settings = readJson(context.claudeFile) as {
    hooks: Record<string, unknown[]>;
  };
  for (const hookType of HOOK_TYPES) {
    assert.equal(settings.hooks[hookType].length, 1);
  }
});

test("setAgentMonitorHooksEnabled writes, no-ops, and removes Codex config through resolved home", () => {
  const context = makeLifecycle({ receiverState: receiver });
  const codexFile = getCodexConfigPath();

  const installResult = context.lifecycle.setAgentMonitorHooksEnabled(true);
  const installedText = readFileSync(codexFile, "utf8");
  const installedMtime = statSync(codexFile).mtimeMs;

  assert.equal(installResult.ok, true);
  assert.equal(installResult.enabled, true);
  assert.equal(installResult.warnings, undefined);
  assert.equal(codexFile, join(tempRoot, "codex", "config.toml"));
  assert.match(installedText, LIFECYCLE_MANAGED_MARKER_RE);
  assert.match(installedText, LIFECYCLE_LOGS_ENDPOINT_RE);

  const reinstallResult = context.lifecycle.setAgentMonitorHooksEnabled(true);
  assert.equal(reinstallResult.ok, true);
  assert.equal(readFileSync(codexFile, "utf8"), installedText);
  assert.equal(statSync(codexFile).mtimeMs, installedMtime);

  const uninstallResult = context.lifecycle.setAgentMonitorHooksEnabled(false);
  assert.equal(uninstallResult.ok, true);
  assert.equal(uninstallResult.enabled, false);
  assert.equal(readFileSync(codexFile, "utf8").includes("[otel]"), false);
});

test("setAgentMonitorHooksEnabled propagates custom otel conflict and skipped warnings", () => {
  const context = makeLifecycle({ receiverState: receiver });
  const codexFile = getCodexConfigPath();
  const customBlock = '[otel]\nexporter = "none"\n';
  mkdirSync(join(tempRoot, "codex"), { recursive: true });
  writeFileSync(codexFile, customBlock);

  const installResult = context.lifecycle.setAgentMonitorHooksEnabled(true);
  const uninstallResult = context.lifecycle.setAgentMonitorHooksEnabled(false);

  assert.equal(
    installResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelConflict
  );
  assert.equal(
    uninstallResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped
  );
  assert.equal(readFileSync(codexFile, "utf8"), customBlock);
  assert.deepEqual(
    context.loggedWarnings.map((warning) => warning.code),
    [
      AgentMonitorHooksWarningCode.CodexOtelConflict,
      AgentMonitorHooksWarningCode.CodexOtelUninstallSkipped,
    ]
  );
});

test("setAgentMonitorHooksEnabled ignores filename-only backups during disable", () => {
  const context = makeLifecycle({
    initialEnabled: true,
    receiverState: receiver,
  });
  const codexFile = getCodexConfigPath();
  mkdirSync(join(tempRoot, "codex"), { recursive: true });
  writeFileSync(
    codexFile,
    `${buildManagedOtelBlock(receiver)}[profiles.default]\nmodel = "gpt-5.5"\n`
  );
  writeFileSync(
    join(tempRoot, "codex", "config.toml.closedloop-bak.2026-06-17"),
    '[otel]\nexporter = "none"\n'
  );

  const result = context.lifecycle.setAgentMonitorHooksEnabled(false);

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  const text = readFileSync(codexFile, "utf8");
  assert.equal(text.includes('exporter = "none"'), false);
  assert.equal(text.includes("[profiles.default]"), true);
});

test("setAgentMonitorHooksEnabled keeps Claude lifecycle authoritative after Codex filesystem failures", () => {
  const writeFailingFs = makeFs({
    writeFileSync: ((target: Parameters<typeof writeFileSync>[0]) => {
      if (String(target).endsWith(".tmp")) {
        throw new Error("write blocked");
      }
    }) as typeof writeFileSync,
  });
  const installContext = makeLifecycle({
    codexFs: writeFailingFs,
    receiverState: receiver,
  });
  const installResult =
    installContext.lifecycle.setAgentMonitorHooksEnabled(true);

  assert.equal(installResult.ok, true);
  assert.equal(installResult.enabled, true);
  assert.equal(installContext.getEnabled(), true);
  assert.equal(
    installResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelWriteFailed
  );
  assert.equal(existsSync(installContext.claudeFile), true);

  const uninstallContext = makeLifecycle({
    codexFs: writeFailingFs,
    initialEnabled: true,
    receiverState: receiver,
  });
  const codexFile = getCodexConfigPath();
  mkdirSync(join(tempRoot, "codex"), { recursive: true });
  writeFileSync(codexFile, buildManagedOtelBlock(receiver));

  const uninstallResult =
    uninstallContext.lifecycle.setAgentMonitorHooksEnabled(false);

  assert.equal(uninstallResult.ok, true);
  assert.equal(uninstallResult.enabled, false);
  assert.equal(uninstallContext.getEnabled(), false);
  assert.equal(
    uninstallResult.warnings?.[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelUninstallFailed
  );
});

test("syncAgentMonitorHooksOnBoot logs Codex warnings without throwing", () => {
  const context = makeLifecycle({ initialEnabled: true });

  assert.doesNotThrow(() => context.lifecycle.syncAgentMonitorHooksOnBoot());

  assert.equal(
    context.loggedWarnings[0]?.code,
    AgentMonitorHooksWarningCode.CodexOtelReceiverUnavailable
  );
  assert.equal(context.bootErrors.length, 0);
  assert.equal(existsSync(getCodexConfigPath()), false);
});

function makeLifecycle({
  codexFs,
  initialEnabled = false,
  receiverState,
}: {
  codexFs?: CodexOtelFileSystem;
  initialEnabled?: boolean;
  receiverState?: OtlpReceiverState;
} = {}) {
  let enabled = initialEnabled;
  const loggedWarnings: AgentMonitorHooksWarning[] = [];
  const errors: string[] = [];
  const bootErrors: string[] = [];
  const claudeFile = join(tempRoot, "claude", "settings.json");
  const lifecycle = createAgentMonitorHooksLifecycle({
    getEnabled: () => enabled,
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled;
    },
    installHooks: () =>
      installAgentMonitorHooks({
        file: claudeFile,
        hookTypes: HOOK_TYPES,
        isOurEntry: isClaudeEntry,
        makeEntry: (hookType) =>
          makeClaudeHookEntry(FAKE_EXEC, CLAUDE_HANDLER, hookType),
        codexConfigFile: getCodexConfigPath(),
        receiverState,
        codexFs,
      }).warnings,
    uninstallHooks: () =>
      uninstallAgentMonitorHooks({
        file: claudeFile,
        isOurEntry: isClaudeEntry,
        codexConfigFile: getCodexConfigPath(),
        codexFs,
      }).warnings,
    onWarning: (warning) => loggedWarnings.push(warning),
    onError: (message) => errors.push(message),
    onBootRepairError: (message) => bootErrors.push(message),
  });

  return {
    bootErrors,
    claudeFile,
    errors,
    getEnabled: () => enabled,
    lifecycle,
    loggedWarnings,
  };
}

function makeFs(overrides: Partial<CodexOtelFileSystem>): CodexOtelFileSystem {
  return {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

const receiver: OtlpReceiverState = {
  available: true,
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 54_321,
};
