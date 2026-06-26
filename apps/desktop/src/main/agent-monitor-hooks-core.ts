// Electron-free core of the Agent Monitor hook installer. Path resolution,
// `app.getPath()`, `electron-store`, and the `gatewayLog` logger live in the
// outer `agent-monitor-hooks.ts` shell; this module owns only the
// settings-file manipulation, hook-entry generation, and idempotent merge
// logic so the behavior can be exercised under `tsx --test` without an
// Electron runtime.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  AgentMonitorHooksResult,
  AgentMonitorHooksWarning,
} from "../shared/contracts.js";
import {
  type CodexOtelConfigInput,
  installCodexOtelConfig,
  uninstallCodexOtelConfig,
} from "./codex-otel-config-core.js";

export const CLAUDE_HANDLER_FILENAME = "hook-handler.js";

// Mirrors the upstream install-hooks.js contract: same event set, same
// matcher rule. Re-verify on every upstream bump.
export const HOOKS_WITH_MATCHER = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
] as const;
export const HOOKS_WITHOUT_MATCHER = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
] as const;
export const HOOK_TYPES = [...HOOKS_WITH_MATCHER, ...HOOKS_WITHOUT_MATCHER];

/**
 * Filename-boundary check: matches a path token equal to `filename` preceded
 * by a path separator, so a handler filename only matches its own entries.
 */
function commandReferences(entry: unknown, filename: string): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const e = entry as {
    command?: unknown;
    hooks?: Array<{ command?: unknown }>;
  };
  const haystack = (s: unknown) =>
    typeof s === "string" &&
    (s.includes(`/${filename}"`) ||
      s.includes(`/${filename} `) ||
      s.includes(`\\${filename}"`) ||
      s.includes(`\\${filename} `));
  if (haystack(e.command)) {
    return true;
  }
  if (Array.isArray(e.hooks)) {
    return e.hooks.some((h) => haystack(h?.command));
  }
  return false;
}

export function isClaudeEntry(entry: unknown): boolean {
  return commandReferences(entry, CLAUDE_HANDLER_FILENAME);
}

/**
 * Returns the shell-ready hook command. Caller supplies `execPath` (typically
 * `process.execPath`) so the command spawns the Electron binary as Node via
 * `ELECTRON_RUN_AS_NODE=1` — no system `node` is required.
 */
export function makeHookCommand(
  execPath: string,
  handler: string,
  hookType: string
): string {
  return `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${handler}" ${JSON.stringify(hookType)}`;
}

export function makeClaudeHookEntry(
  execPath: string,
  handler: string,
  hookType: string
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    hooks: [
      {
        type: "command",
        command: makeHookCommand(execPath, handler, hookType),
      },
    ],
  };
  if ((HOOKS_WITH_MATCHER as readonly string[]).includes(hookType)) {
    entry.matcher = "*";
  }
  return entry;
}

export function readSettingsFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) {
    return {};
  }
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Atomic-rename write: stage to a sibling `.tmp` file, then `rename` so a
 * crash mid-write never leaves a half-written settings file the user's
 * tooling has to recover from.
 */
export function writeSettingsFile(file: string, settings: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tempFile, file);
}

export type ApplyHooksInput = {
  /** Path to the JSON settings file to mutate. */
  file: string;
  /** Hook event names to install. */
  hookTypes: readonly string[];
  /** Identity predicate: returns true for an entry owned by this installer. */
  isOurEntry: (entry: unknown) => boolean;
  /** Factory: produce the canonical entry for one hook type. */
  makeEntry: (hookType: string) => Record<string, unknown>;
};

/**
 * Idempotent in-place install: replaces a stale entry of ours (self-heals a
 * moved handler path) or appends a fresh one. Mirrors upstream
 * `install-hooks.js`. Returns the number of entries installed plus the
 * number repaired.
 */
export function applyHookInstall(input: ApplyHooksInput): {
  installed: number;
  repaired: number;
} {
  const settings = readSettingsFile(input.file);
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  let installed = 0;
  let repaired = 0;

  for (const hookType of input.hookTypes) {
    const list = (hooks[hookType] ??= []);
    const idx = list.findIndex(input.isOurEntry);
    const entry = input.makeEntry(hookType);
    if (idx >= 0) {
      list[idx] = entry;
      repaired += 1;
    } else {
      list.push(entry);
      installed += 1;
    }
  }
  writeSettingsFile(input.file, settings);
  return { installed, repaired };
}

export type ApplyUninstallInput = {
  /** Path to the JSON settings file to clean. No-op if missing. */
  file: string;
  /** Identity predicate: returns true for an entry owned by this installer. */
  isOurEntry: (entry: unknown) => boolean;
};

/**
 * Removes only entries identified by `isOurEntry`. Preserves other entries.
 * Deletes empty per-event arrays and the outer `hooks` block when nothing
 * remains, so the file stays clean.
 */
export function applyHookUninstall(input: ApplyUninstallInput): {
  removed: number;
} {
  if (!existsSync(input.file)) {
    return { removed: 0 };
  }
  const settings = readSettingsFile(input.file);
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return { removed: 0 };
  }
  let removed = 0;
  for (const hookType of Object.keys(hooks)) {
    const list = hooks[hookType];
    if (!Array.isArray(list)) {
      continue;
    }
    const kept = list.filter((e) => {
      const ours = input.isOurEntry(e);
      if (ours) {
        removed += 1;
      }
      return !ours;
    });
    if (kept.length > 0) {
      hooks[hookType] = kept;
    } else {
      delete hooks[hookType];
    }
  }
  if (Object.keys(hooks).length === 0) {
    settings.hooks = undefined;
  }
  writeSettingsFile(input.file, settings);
  return { removed };
}

export type InstallAgentMonitorHooksInput = ApplyHooksInput & {
  codexConfigFile: string;
  receiverState: CodexOtelConfigInput["receiverState"];
  codexFs?: CodexOtelConfigInput["fs"];
  codexNow?: CodexOtelConfigInput["now"];
};

export type InstallAgentMonitorHooksResult = {
  installed: number;
  repaired: number;
  warnings: AgentMonitorHooksWarning[];
};

export function installAgentMonitorHooks(
  input: InstallAgentMonitorHooksInput
): InstallAgentMonitorHooksResult {
  const claudeResult = applyHookInstall(input);
  const codexResult = installCodexOtelConfig({
    file: input.codexConfigFile,
    receiverState: input.receiverState,
    fs: input.codexFs,
    now: input.codexNow,
  });
  return {
    ...claudeResult,
    warnings: codexResult.warnings ?? [],
  };
}

export type UninstallAgentMonitorHooksInput = ApplyUninstallInput & {
  codexConfigFile: string;
  codexFs?: CodexOtelConfigInput["fs"];
};

export type UninstallAgentMonitorHooksResult = {
  removed: number;
  warnings: AgentMonitorHooksWarning[];
};

export function uninstallAgentMonitorHooks(
  input: UninstallAgentMonitorHooksInput
): UninstallAgentMonitorHooksResult {
  const claudeResult = applyHookUninstall(input);
  const codexResult = uninstallCodexOtelConfig({
    file: input.codexConfigFile,
    fs: input.codexFs,
  });
  return {
    ...claudeResult,
    warnings: codexResult.warnings ?? [],
  };
}

export type AgentMonitorHooksLifecycleInput = {
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  installHooks: () => AgentMonitorHooksWarning[];
  uninstallHooks: () => AgentMonitorHooksWarning[];
  onWarning: (warning: AgentMonitorHooksWarning) => void;
  onError: (message: string) => void;
  onBootRepairError: (message: string) => void;
};

export function createAgentMonitorHooksLifecycle(
  input: AgentMonitorHooksLifecycleInput
): {
  isAgentMonitorHooksEnabled: () => boolean;
  setAgentMonitorHooksEnabled: (enabled: boolean) => AgentMonitorHooksResult;
  syncAgentMonitorHooksOnBoot: () => void;
} {
  const isAgentMonitorHooksEnabled = () => input.getEnabled() === true;

  return {
    isAgentMonitorHooksEnabled,
    setAgentMonitorHooksEnabled: (enabled) => {
      try {
        const warnings = enabled
          ? input.installHooks()
          : input.uninstallHooks();
        logLifecycleWarnings(warnings, input.onWarning);
        input.setEnabled(enabled);
        return warnings.length > 0
          ? { ok: true, enabled, warnings }
          : { ok: true, enabled };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.onError(
          `failed to ${enabled ? "enable" : "disable"} hooks: ${message}`
        );
        return {
          ok: false,
          enabled: isAgentMonitorHooksEnabled(),
          error: message,
        };
      }
    },
    syncAgentMonitorHooksOnBoot: () => {
      if (!isAgentMonitorHooksEnabled()) {
        return;
      }
      try {
        logLifecycleWarnings(input.installHooks(), input.onWarning);
      } catch (error) {
        input.onBootRepairError(
          `boot hook repair failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
  };
}

function logLifecycleWarnings(
  warnings: AgentMonitorHooksWarning[],
  onWarning: (warning: AgentMonitorHooksWarning) => void
): void {
  for (const warning of warnings) {
    onWarning(warning);
  }
}
