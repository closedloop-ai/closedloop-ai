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
import { statSync } from "node:fs";
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

export function getOpenCodeDbPath(home = getOpenCodeHome()): string {
  return path.join(home, "opencode.db");
}

export function getOpenCodeDbWatchFiles(): string[] {
  return ["opencode.db", "opencode.db-wal", "opencode.db-shm"];
}

/**
 * The store files that exist under `home` right now — the db and whichever of
 * its WAL/SHM siblings SQLite currently has on disk.
 *
 * This is what the collector's parse actually reads, so it is the parse-lane
 * byte source for OpenCode (ISS-8506). ENOENT is the ordinary state for the
 * siblings and is not reported; any other stat failure keeps the path in the
 * listing so the caller's own `lstat` can classify it as unreadable rather than
 * silently omit it.
 */
export function listOpenCodeStoreFiles(home = getOpenCodeHome()): string[] {
  return getOpenCodeDbWatchFiles()
    .map((name) => path.join(home, name))
    .filter((filePath) => {
      try {
        statSync(filePath);
        return true;
      } catch (error) {
        // Only a genuinely missing sibling is omitted. ENOTDIR (a home that is
        // a file), EACCES and the rest are kept so the caller's own lstat can
        // say why the store could not be measured.
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    });
}

/**
 * OpenCode's CONFIG home — distinct from the data home above. Agent, command,
 * and other definition markdown files live here (ISS-4386), NOT in the
 * `opencode.db` data store. OpenCode resolves this to `$XDG_CONFIG_HOME/opencode`
 * (`~/.config/opencode` when `XDG_CONFIG_HOME` is unset) on linux/mac and
 * `%APPDATA%/opencode` on win32 — the same directory that holds `opencode.json`.
 *
 * Override precedence (matches OpenCode's own resolution):
 *   1. `OPENCODE_CONFIG_DIR` — the DIRECTORY override for the config home. Used
 *      verbatim (it already IS the dir that holds `agents/`/`commands/`). This
 *      is the correct knob for relocating agentic components (P1 review).
 *   2. `OPENCODE_CONFIG` — relocates an individual config FILE, NOT the
 *      component directory. Its parent is treated as the config home ONLY when
 *      the value actually resolves to a regular file; a value that is itself a
 *      directory, or a bare filename whose `dirname` is `.` (→ cwd-relative
 *      scanning of unrelated `agents/`), is ignored here so we don't
 *      mis-attribute a parent/`cwd` tree as OpenCode's config home (P1/P2
 *      review).
 *   3. The XDG/`%APPDATA%` default.
 */
export function getOpenCodeConfigHome(): string {
  const rawConfigDir = process.env.OPENCODE_CONFIG_DIR;
  if (rawConfigDir?.trim()) {
    return rawConfigDir.trim().replace(/^~(?=\/)/, os.homedir());
  }
  const rawConfig = process.env.OPENCODE_CONFIG;
  if (rawConfig?.trim()) {
    const expanded = rawConfig.trim().replace(/^~(?=\/)/, os.homedir());
    // Only honor the parent when the override is genuinely a config FILE. A
    // directory value or a bare filename (dirname === ".") is not a file
    // relocation and must not repoint the component scan root.
    if (path.dirname(expanded) !== "." && isExistingFile(expanded)) {
      return path.dirname(expanded);
    }
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "opencode"
    );
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const configBase = xdgConfig?.trim()
    ? xdgConfig.trim().replace(/^~(?=\/)/, os.homedir())
    : path.join(home, ".config");
  return path.join(configBase, "opencode");
}

/** True when `p` exists and is a regular file. Never throws (missing → false). */
function isExistingFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
