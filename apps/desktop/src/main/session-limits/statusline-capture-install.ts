/**
 * @file statusline-capture-install.ts
 * @description Electron shell for the statusline-capture install/compose UX
 * (FEA-3492 / PRD-539). Wires the pure transforms in
 * `statusline-capture-install-core.ts` to the real filesystem: it copies the
 * shipped capture script into userData (so the installed `statusLine.command` is
 * independent of the .app location), bakes a config file the script reads
 * (snapshot destination + the wrapped user command), sets/removes the user's
 * `statusLine` behind an explicit opt-in persisted in an `electron-store`, and
 * restores the prior config exactly on opt-out.
 *
 * SECURITY BOUNDARY: nothing here reads the user's OAuth credential; the capture
 * script only consumes the payload Claude Code passes it on stdin.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import Store from "electron-store";

import type { StatuslineCaptureResult } from "../../shared/session-limits-channel.js";
import {
  readSettingsFile,
  writeSettingsFile,
} from "../agent-monitor/agent-monitor-hooks-core.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  planInstall,
  planUninstall,
  type StatusLineEntry,
} from "./statusline-capture-install-core.js";
import { resolveStatuslineScriptPath } from "./statusline-capture-path.js";

const TAG = "statusline-capture-install";

// Re-export the shared result type from this module's public surface so existing
// consumers importing it from here keep working, without duplicating the shape.
export type { StatuslineCaptureResult } from "../../shared/session-limits-channel.js";

type StatuslineCaptureStore = {
  enabled: boolean;
  /** The user's prior `statusLine`, persisted so opt-out restores it exactly. */
  backup: StatusLineEntry | null;
};

let flagStore: Store<StatuslineCaptureStore> | null = null;
function store(): Store<StatuslineCaptureStore> {
  flagStore ??= new Store<StatuslineCaptureStore>({
    name: "statusline-capture",
  });
  return flagStore;
}

/**
 * FEA-3523: default the statusline-capture opt-in ON so the hook self-installs
 * on boot without a settings-UI toggle (there is no renderer caller for the
 * `set` IPC yet), lighting up the RICH session-limit source. The install is
 * fully reversible — it backs up and composes (wraps) any pre-existing
 * `statusLine`, and opt-out via `setStatuslineCaptureEnabled(false)` restores
 * the prior config exactly — and the capture script never reads credentials
 * (see the SECURITY BOUNDARY note above). An explicit stored `false` (a user who
 * opted out) is still honored.
 */
export function isStatuslineCaptureEnabled(): boolean {
  return store().get("enabled", true) === true;
}

// Resolve CLAUDE_HOME || ~/.claude, then settings.json — inlined (not imported
// from collectors/claude/claude-home.ts) to keep this boot-path module clear of
// the design-system/collector runtime the `boot-no-design-system-runtime`
// dependency-cruiser rule forbids. Same resolution as agent-monitor-hooks.ts.
function claudeSettingsPath(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, "settings.json");
}

function userDataScriptPath(): string {
  return path.join(
    app.getPath("userData"),
    "statusline",
    "statusline-capture.js"
  );
}

function configPath(): string {
  return path.join(
    app.getPath("userData"),
    "statusline",
    "statusline-capture-config.json"
  );
}

function snapshotPath(): string {
  return statuslineSnapshotPath();
}

/**
 * Absolute path to the statusline capture snapshot the install script writes.
 * Exported so the statusline reader (FEA-3523) can poll the same file the
 * installer bakes into the script's config.
 */
export function statuslineSnapshotPath(): string {
  return path.join(
    app.getPath("userData"),
    "session-limits",
    "statusline-snapshot.json"
  );
}

/** Copy the shipped script into userData, refreshing a stale copy. */
function refreshScriptCopy(): string {
  const src = resolveStatuslineScriptPath();
  if (!existsSync(src)) {
    throw new Error(`statusline-capture.js not found at ${src}`);
  }
  const dest = userDataScriptPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const srcContent = readFileSync(src);
  if (!(existsSync(dest) && readFileSync(dest).equals(srcContent))) {
    copyFileSync(src, dest);
  }
  return dest;
}

/**
 * Build the shell command written to `statusLine.command`. Runs the userData
 * script copy via the Electron binary as Node (ELECTRON_RUN_AS_NODE) — no system
 * `node` required — with the config path passed in the environment.
 */
function makeStatuslineCommand(scriptCopy: string): string {
  return `CLOSEDLOOP_STATUSLINE_CONFIG=${JSON.stringify(configPath())} ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${scriptCopy}"`;
}

function installStatusLine(): void {
  const scriptCopy = refreshScriptCopy();
  const settings = readSettingsFile(claudeSettingsPath());
  const plan = planInstall({
    settings,
    storedBackup: store().get("backup", null),
    ourCommand: makeStatuslineCommand(scriptCopy),
  });

  // Write the config the script reads BEFORE the settings that make Claude start
  // invoking it, so the first render already has a snapshot destination + the
  // wrapped command.
  writeSettingsFile(configPath(), {
    snapshotPath: snapshotPath(),
    wrappedCommand: plan.wrappedCommand,
  });
  writeSettingsFile(claudeSettingsPath(), plan.nextSettings);
  store().set("backup", plan.backupToStore);

  gatewayLog.info(
    TAG,
    `installed statusLine capture -> ${scriptCopy}${
      plan.wrappedCommand ? " (wrapping existing statusLine)" : ""
    }`
  );
}

function uninstallStatusLine(): void {
  const settings = readSettingsFile(claudeSettingsPath());
  const plan = planUninstall({
    settings,
    storedBackup: store().get("backup", null),
  });
  if (plan.removed) {
    writeSettingsFile(claudeSettingsPath(), plan.nextSettings);
  }
  store().set("backup", null);
  gatewayLog.info(
    TAG,
    plan.removed
      ? "removed statusLine capture (restored prior config)"
      : "statusLine capture not present; nothing to remove"
  );
}

/** Set the explicit opt-in, installing or restoring the user's `statusLine`. */
export function setStatuslineCaptureEnabled(
  enabled: boolean
): StatuslineCaptureResult {
  try {
    if (enabled) {
      installStatusLine();
    } else {
      uninstallStatusLine();
    }
    store().set("enabled", enabled);
    return { ok: true, enabled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatewayLog.error(
      TAG,
      `failed to ${enabled ? "enable" : "disable"} statusline capture: ${message}`
    );
    return { ok: false, enabled: isStatuslineCaptureEnabled(), error: message };
  }
}

/**
 * Boot-time repair: re-copy the script and re-write the entry so a moved/updated
 * .app self-heals. No-op when disabled; never throws into boot.
 */
export function syncStatuslineCaptureOnBoot(): void {
  if (!isStatuslineCaptureEnabled()) {
    return;
  }
  try {
    installStatusLine();
  } catch (error) {
    gatewayLog.warn(
      TAG,
      `boot statusline repair failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
