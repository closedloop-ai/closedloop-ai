import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import { gatewayLog } from "./gateway-logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = "agent-monitor-path";

export type AgentMonitorHookPaths = {
  /** Directory holding the first-party hook-handler.js. */
  hooksDir: string;
};

/**
 * Resolve the directory holding the first-party hook handler scripts (FEA-1503).
 * Packaged builds read the unpacked `extraResources/hooks` copy; development
 * builds read them from `apps/desktop/resources/hooks`. The handlers are copied
 * into userData at install time by `agent-monitor-hooks.ts`, so the installed hook
 * command is independent of the .app location.
 */
export function resolveAgentMonitorHookPaths(): AgentMonitorHookPaths {
  return { hooksDir: resolveHooksDir() };
}

function resolveHooksDir(): string {
  if (app.isPackaged) {
    // electron-builder.yml extraResources: `to: hooks`.
    return path.join(process.resourcesPath, "hooks");
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "resources", "hooks"), // launched from apps/desktop
    path.join(cwd, "apps", "desktop", "resources", "hooks"), // repo root
    path.join(__dirname, "..", "..", "resources", "hooks"), // dist/main -> app
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "hook-handler.js"))) {
      return candidate;
    }
  }
  gatewayLog.warn(
    TAG,
    `unable to locate hook handler scripts; defaulting to ${candidates[0]}`
  );
  return candidates[0];
}
