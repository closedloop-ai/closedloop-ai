// @ts-check

/**
 * ISS-5303 — the pure half of `reset-dashboard-db.mjs`.
 *
 * The entrypoint cannot be imported by a test: it calls `main()` at module
 * scope, and `main()` deletes the operator's real Agent Dashboard database. The
 * two pieces that are pure logic — where the database lives, and the removal
 * itself against a caller-supplied path — live here so they can be driven
 * against `mkdtemp` fixtures instead.
 *
 * The refusal-to-run-while-the-app-is-running guard deliberately stays in the
 * entrypoint. It is the safety interlock, not a helper, and nothing in this
 * module weakens it.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Electron `app.getName()` for this app; the userData directory is named after it. */
export const APP_NAME = "Closedloop";

/**
 * The SQLite data directory inside userData. Named `.pgdata` for historical
 * reasons (the store was PGlite before FEA-1503); it is a directory, not a file,
 * which is why removal is recursive.
 */
export const DB_DIR = "agent-dashboard.pgdata";

/**
 * Absolute path of the Agent Dashboard database directory.
 *
 * Mirrors `app.getPath("userData")` from the Electron main process, per
 * platform, then appends {@link DB_DIR}.
 *
 * KNOWN DIVERGENCE from `perf-prepare-dataset.mjs`'s `defaultSourceUserDataDir`,
 * preserved here rather than papered over: that helper honours
 * `XDG_CONFIG_HOME` on Linux and this one does not — it always resolves
 * `~/.config`. Electron itself honours `XDG_CONFIG_HOME`, so on a Linux box that
 * sets it, this script targets a directory the app does not use and reports
 * "nothing to do". ISS-5303 is a behaviour-preserving extraction, so the
 * divergence is named here and left for a ticket that owns the fix; unifying it
 * inside this PR would silently change which directory a destructive script
 * deletes.
 *
 * @param {string} [platformName] `process.platform`-shaped id.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function dashboardDbPath(
  platformName = platform(),
  env = process.env,
  home = homedir()
) {
  if (platformName === "darwin") {
    return join(home, "Library", "Application Support", APP_NAME, DB_DIR);
  }
  if (platformName === "win32") {
    return join(
      env.APPDATA || join(home, "AppData", "Roaming"),
      APP_NAME,
      DB_DIR
    );
  }
  return join(home, ".config", APP_NAME, DB_DIR);
}

/**
 * Recursively remove `dbPath` if it exists.
 *
 * A missing path is a no-op, not an error: the FTUE reset is idempotent, and a
 * machine that has never launched the app has no database to wipe.
 *
 * @param {string} dbPath Directory to remove, with everything under it —
 *   including the SQLite sidecars (`-wal`, `-shm`) the store leaves beside its
 *   main database file.
 * @param {(message: string) => void} [log] Injected so a test can assert that
 *   the removal was reported (and that the no-op branch reports nothing)
 *   without writing to the suite's stdout.
 * @returns {void}
 */
export function removeAll(dbPath, log = console.log) {
  if (existsSync(dbPath)) {
    rmSync(dbPath, { recursive: true, force: true });
    log(`[reset-dashboard-db] removed ${dbPath}`);
  }
}
