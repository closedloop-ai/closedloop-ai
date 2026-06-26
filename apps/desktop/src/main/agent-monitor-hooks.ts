import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

import Store from "electron-store";
import type {
  AgentMonitorHooksResult,
  AgentMonitorHooksWarning,
} from "../shared/contracts.js";
import {
  createAgentMonitorHooksLifecycle,
  HOOK_TYPES,
  installAgentMonitorHooks,
  isClaudeEntry,
  makeClaudeHookEntry,
  uninstallAgentMonitorHooks,
} from "./agent-monitor-hooks-core.js";
import { resolveAgentMonitorHookPaths } from "./agent-monitor-path.js";
import { getCodexConfigPath } from "./codex-home-paths.js";
import { gatewayLog } from "./gateway-logger.js";
import { getOtlpReceiverState } from "./otlp-receiver-state.js";

const TAG = "agent-monitor-hooks";

type HooksFlagStore = {
  enabled: boolean;
};

let flagStore: Store<HooksFlagStore> | null = null;
function store(): Store<HooksFlagStore> {
  flagStore ??= new Store<HooksFlagStore>({ name: "agent-monitor-hooks" });
  return flagStore;
}

export function isAgentMonitorHooksEnabled(): boolean {
  return lifecycle.isAgentMonitorHooksEnabled();
}

// Same resolution as collectors/claude/claude-home.ts:
// CLAUDE_HOME || ~/.claude, then settings.json.
function claudeSettingsPath(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, "settings.json");
}

// A zero-dependency single file (pure node:http). Copying it to userData makes
// the installed hook command independent of the .app location (survives app
// move/rename and in-place updates).
function userDataHandlerPath(): string {
  return path.join(app.getPath("userData"), "agent-monitor", "hook-handler.js");
}

function refreshHandlerCopy(): string {
  const { hooksDir } = resolveAgentMonitorHookPaths();
  const src = path.join(hooksDir, "hook-handler.js");
  if (!existsSync(src)) {
    throw new Error(`hook-handler.js not found at ${src}`);
  }
  const dest = userDataHandlerPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const srcContent = readFileSync(src);
  if (!(existsSync(dest) && readFileSync(dest).equals(srcContent))) {
    copyFileSync(src, dest);
  }
  return dest;
}

function installHooks(): AgentMonitorHooksWarning[] {
  const handler = refreshHandlerCopy();
  const result = installAgentMonitorHooks({
    file: claudeSettingsPath(),
    hookTypes: HOOK_TYPES,
    isOurEntry: isClaudeEntry,
    makeEntry: (hookType) =>
      makeClaudeHookEntry(process.execPath, handler, hookType),
    codexConfigFile: getCodexConfigPath(),
    receiverState: getOtlpReceiverState(),
  });
  gatewayLog.info(
    TAG,
    `installed/repaired ${HOOK_TYPES.length} Claude Code hooks -> ${handler}`
  );
  return result.warnings;
}

function uninstallHooks(): AgentMonitorHooksWarning[] {
  const result = uninstallAgentMonitorHooks({
    file: claudeSettingsPath(),
    isOurEntry: isClaudeEntry,
    codexConfigFile: getCodexConfigPath(),
  });
  gatewayLog.info(
    TAG,
    `removed ${result.removed} Claude Code hook entr${result.removed === 1 ? "y" : "ies"}`
  );
  return result.warnings;
}

export function setAgentMonitorHooksEnabled(
  enabled: boolean
): AgentMonitorHooksResult {
  return lifecycle.setAgentMonitorHooksEnabled(enabled);
}

// Boot-time repair: re-copy the handler and re-write the entries so a
// moved/updated .app self-heals. No-op when disabled (and never throws into
// boot).
export function syncAgentMonitorHooksOnBoot(): void {
  lifecycle.syncAgentMonitorHooksOnBoot();
}

function logWarning(warning: AgentMonitorHooksWarning): void {
  gatewayLog.warn(
    TAG,
    `${warning.code} for ${warning.path}: ${warning.message}`
  );
}

const lifecycle = createAgentMonitorHooksLifecycle({
  getEnabled: () => store().get("enabled", false) === true,
  setEnabled: (enabled) => store().set("enabled", enabled),
  installHooks,
  uninstallHooks,
  onWarning: logWarning,
  onError: (message) => gatewayLog.error(TAG, message),
  onBootRepairError: (message) => gatewayLog.warn(TAG, message),
});
