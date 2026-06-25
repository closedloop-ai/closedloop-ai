/**
 * @file opencode-home.ts
 * @description Centralized OpenCode data-path management. OpenCode's canonical
 * session store is the SQLite database at `opencode.db`; the adjacent WAL/SHM
 * files carry live updates while the app is running.
 *
 * Supports a custom root via the OPENCODE_DATA_DIR environment variable (`~`
 * expanded). Default is `~/.local/share/opencode` on linux/mac and
 * `%APPDATA%/opencode` on win32.
 *
 * Ported from `scripts/agent-monitor-opencode/opencode-home.js` (logic
 * preserved exactly).
 */
import os from "node:os";
import path from "node:path";

export function getOpenCodeHome(): string {
  const raw = process.env.OPENCODE_DATA_DIR;
  if (raw?.trim()) {
    return raw.trim().replace(/^~(?=\/)/, os.homedir());
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "opencode"
    );
  }
  return path.join(home, ".local", "share", "opencode");
}

export function getOpenCodeDbPath(): string {
  return path.join(getOpenCodeHome(), "opencode.db");
}

export function getOpenCodeDbWatchFiles(): string[] {
  return ["opencode.db", "opencode.db-wal", "opencode.db-shm"];
}
