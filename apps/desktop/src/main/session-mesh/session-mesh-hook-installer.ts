import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveAgentMonitorHookPaths } from "../agent-monitor/agent-monitor-path.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { getOtlpReceiverState } from "../telemetry/otlp-receiver-state.js";
import { getCodexConfigPath } from "../util/codex-home-paths.js";
import { installSessionMeshCommandPack } from "./session-mesh-command-pack.js";
import { detectSessionMeshHarnessSupport } from "./session-mesh-harness-support.js";
import { installSessionMeshHooks } from "./session-mesh-hook-installer-core.js";
import { sessionMeshLocalToken } from "./session-mesh-local-auth.js";

const TAG = "session-mesh-hooks";

/** Nonblocking boot entrypoint; golden fixtures never mutate real config. */
export function startSessionMeshHookInstallation(enabled: boolean): void {
  if (!enabled) {
    return;
  }
  syncSessionMeshHooksOnBoot().catch((error) => {
    gatewayLog.warn(TAG, `Hook installation failed: ${String(error)}`);
  });
}

function claudeSettingsPath(): string {
  const home =
    process.env.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_HOME ||
    path.join(os.homedir(), ".claude");
  return path.join(home, "settings.json");
}

function userDataHandlerPath(): string {
  return path.join(
    app.getPath("userData"),
    "session-mesh",
    "session-mesh-hook-handler.js"
  );
}

function refreshHandlerCopy(): string {
  const source = path.join(
    resolveAgentMonitorHookPaths().hooksDir,
    "session-mesh-hook-handler.js"
  );
  if (!existsSync(source)) {
    throw new Error(`session-mesh-hook-handler.js not found at ${source}`);
  }
  const destination = userDataHandlerPath();
  mkdirSync(path.dirname(destination), { recursive: true });
  const sourceContent = readFileSync(source);
  if (
    !(
      existsSync(destination) && readFileSync(destination).equals(sourceContent)
    )
  ) {
    copyFileSync(source, destination);
  }
  return destination;
}

/**
 * Runs on every normal Desktop boot. This is intentionally not behind the
 * Agent Monitor toggle: installing Desktop makes a running Claude Code/Codex
 * session Mesh-aware without a separate bridge process or repo setup.
 */
export async function syncSessionMeshHooksOnBoot(): Promise<void> {
  try {
    const nativeAsyncSupport = await detectSessionMeshHarnessSupport();
    sessionMeshLocalToken(app.getPath("userData"));
    const handler = refreshHandlerCopy();
    for (const harness of ["claude", "codex"] as const) {
      try {
        installSessionMeshCommandPack({
          harness,
          handler,
          execPath: process.execPath,
          skillsDirectory: path.join(
            path.dirname(
              harness === "claude" ? claudeSettingsPath() : getCodexConfigPath()
            ),
            "skills"
          ),
        });
      } catch (error) {
        gatewayLog.warn(
          TAG,
          `Command pack unavailable for ${harness}: ${String(error)}`
        );
      }
    }
    const result = installSessionMeshHooks({
      file: claudeSettingsPath(),
      execPath: process.execPath,
      handler,
      codexConfigFile: getCodexConfigPath(),
      receiverState: getOtlpReceiverState(),
      nativeAsyncSupport,
    });
    if (!(nativeAsyncSupport.claude && nativeAsyncSupport.codex)) {
      gatewayLog.warn(
        TAG,
        "Native Mesh hooks skipped for an unavailable or unverified harness version; normal agent execution is unaffected"
      );
    }
    gatewayLog.info(
      TAG,
      `reconciled ${result.installed} Claude hook entr${result.installed === 1 ? "y" : "ies"} (${result.repaired} repaired)`
    );
    for (const warning of result.warnings) {
      gatewayLog.warn(
        TAG,
        `${warning.code} for ${warning.path}: ${warning.message}`
      );
    }
  } catch (error) {
    gatewayLog.warn(
      TAG,
      `Session Mesh hook reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
