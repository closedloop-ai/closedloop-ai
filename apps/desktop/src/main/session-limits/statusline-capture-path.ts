/**
 * @file statusline-capture-path.ts
 * @description Resolve the directory holding the first-party statusline capture
 * script (FEA-3492). Packaged builds read the unpacked `extraResources/statusline`
 * copy; development builds read `apps/desktop/resources/statusline`. The script is
 * copied into userData at install time by `statusline-capture-install.ts`, so the
 * installed `statusLine.command` is independent of the .app location.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import { gatewayLog } from "../logging/gateway-logger.js";
import { STATUSLINE_SCRIPT_FILENAME } from "./statusline-capture-install-core.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const TAG = "statusline-capture-path";

/** Absolute path to the shipped statusline capture script. */
export function resolveStatuslineScriptPath(): string {
  const dir = resolveStatuslineDir();
  return path.join(dir, STATUSLINE_SCRIPT_FILENAME);
}

function resolveStatuslineDir(): string {
  if (app.isPackaged) {
    // electron-builder.yml extraResources: `to: statusline`.
    return path.join(process.resourcesPath, "statusline");
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "resources", "statusline"), // launched from apps/desktop
    path.join(cwd, "apps", "desktop", "resources", "statusline"), // repo root
    path.join(currentDir, "..", "..", "resources", "statusline"), // dist/main -> app
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, STATUSLINE_SCRIPT_FILENAME))) {
      return candidate;
    }
  }
  gatewayLog.warn(
    TAG,
    `unable to locate statusline capture script; defaulting to ${candidates[0]}`
  );
  return candidates[0];
}
