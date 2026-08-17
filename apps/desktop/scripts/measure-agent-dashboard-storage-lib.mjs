// @ts-check

/**
 * ISS-5303 — the decision-carrying half of
 * `measure-agent-dashboard-storage.mjs`.
 *
 * The entrypoint is a resolve-print-exit shell with nothing assertable in it:
 * it runs its whole body at module scope, so importing it from a test would
 * simply measure the developer's real machine and print to the runner's stdout.
 * Everything that actually decides something — argument parsing, the recursive
 * walk, the absent-directory branch — lives here instead, so a test can drive
 * the real functions against fixtures it controls.
 *
 * The measurement is READ-ONLY by construction. `existsSync`, `statSync` and
 * `readdirSync` never create anything, which is the property the script exists
 * for: asking "how big is the Agent Dashboard store" must not bring a store
 * into existence on a machine that has never launched the app.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** The CLI flag that overrides the platform-default userData directory. */
export const USER_DATA_FLAG = "--user-data";

/** The Agent Dashboard store, as a child of Electron's userData directory. */
export const AGENT_DASHBOARD_STORAGE_DIRNAME = "agent-dashboard.pgdata";

/**
 * The `mode` label carried on every emitted measurement. Preserved verbatim
 * from before the ISS-5303 extraction so the JSON this tool prints — which
 * operators paste into tickets — is byte-identical to what it printed before.
 */
export const AGENT_DASHBOARD_STORAGE_MODE = "sqlite";

/**
 * `--user-data <path>`, resolved to an absolute path, or `null` when the flag
 * was not passed at all.
 *
 * A flag with no value THROWS rather than falling back to the platform default:
 * the caller asked about one specific directory, and quietly measuring a
 * different one would report a true number about the wrong machine state.
 *
 * @param {readonly string[]} argv Full `process.argv`, or any argument list.
 * @returns {string | null}
 */
export function parseUserDataArg(argv) {
  const index = argv.indexOf(USER_DATA_FLAG);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${USER_DATA_FLAG} requires a path value`);
  }
  return path.resolve(value);
}

/**
 * Recursively total `targetPath`.
 *
 * A file is one file and zero directories; a directory counts itself plus
 * everything beneath it, so an empty directory is `0` files and `1` directory.
 * The caller is responsible for the path existing — see
 * `measureExistingDirectory` for the branch that tolerates absence.
 *
 * @param {string} targetPath
 * @returns {{ bytes: number, files: number, directories: number }}
 */
export function measurePath(targetPath) {
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) {
    return { bytes: stat.size, files: 1, directories: 0 };
  }

  let bytes = 0;
  let files = 0;
  let directories = 1;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const child = path.join(targetPath, entry.name);
    const measured = measurePath(child);
    bytes += measured.bytes;
    files += measured.files;
    directories += measured.directories;
  }
  return { bytes, files, directories };
}

/**
 * Measure a target that may legitimately not exist yet.
 *
 * An absent path reports `exists: false` with zeroed counts instead of
 * throwing — "the app has never run here" is an answer, not an error — and is
 * never created on the way to that answer.
 *
 * @param {{ mode: string, path: string }} target
 * @returns {{
 *   mode: string,
 *   path: string,
 *   exists: boolean,
 *   bytes: number,
 *   files: number,
 *   directories: number,
 * }}
 */
export function measureExistingDirectory(target) {
  if (!existsSync(target.path)) {
    return {
      mode: target.mode,
      path: target.path,
      exists: false,
      bytes: 0,
      files: 0,
      directories: 0,
    };
  }

  const measured = measurePath(target.path);
  return {
    mode: target.mode,
    path: target.path,
    exists: true,
    ...measured,
  };
}
