import fs from "node:fs";
import path from "node:path";

/**
 * electron-store files whose owners were removed with Loops (ISS-12435,
 * PRD-795; Q1 answered "drop"): the local loop job store and the encrypted
 * loop runner tokens. Nothing reads them, so boot deletes them.
 */
export const RETIRED_STORE_FILE_NAMES = [
  "desktop-job-store",
  "desktop-loop-tokens",
] as const;

/**
 * Files under the home directory whose owners were removed. The browser
 * command-key store wrote `~/.closedloop/authorized_keys.json` (ISS-12784,
 * PLN-2216 T-5.10). Only the file goes; `~/.closedloop` is shared and stays.
 */
export const RETIRED_HOME_FILE_PATHS = [
  path.join(".closedloop", "authorized_keys.json"),
] as const;

type RemoveFile = (filePath: string, options: { force: true }) => void;

/**
 * Deletes each retired store file under `userDataDir`. Best-effort: a failed
 * delete is logged and the next file is still attempted, so it never blocks
 * boot. `force` makes an already-absent file a no-op.
 */
export function deleteRetiredStoreFiles(
  userDataDir: string,
  log: (message: string) => void,
  removeFile: RemoveFile = fs.rmSync
): void {
  deleteRetiredFiles(
    userDataDir,
    RETIRED_STORE_FILE_NAMES.map((name) => `${name}.json`),
    log,
    removeFile
  );
}

/** The home-directory variant of {@link deleteRetiredStoreFiles}. */
export function deleteRetiredHomeFiles(
  homeDir: string,
  log: (message: string) => void,
  removeFile: RemoveFile = fs.rmSync
): void {
  deleteRetiredFiles(homeDir, RETIRED_HOME_FILE_PATHS, log, removeFile);
}

function deleteRetiredFiles(
  rootDir: string,
  relativePaths: readonly string[],
  log: (message: string) => void,
  removeFile: RemoveFile
): void {
  for (const relativePath of relativePaths) {
    try {
      removeFile(path.join(rootDir, relativePath), { force: true });
    } catch (error) {
      log(
        `Could not delete retired store file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
