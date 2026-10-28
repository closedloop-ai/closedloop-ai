import { existsSync } from "node:fs";
import path from "node:path";
import { isTccProtectedDirectory } from "./sandbox-policy.js";

/**
 * Returns true if the given directory contains a `.git` entry, indicating it
 * is the root of a git repository.
 *
 * FEA-3641: skips the `existsSync(<dir>/.git)` probe for TCC-protected user
 * folders (Music, Pictures, Documents, …). They are never git repositories the
 * user would sandbox to, so we short-circuit to `false` without touching the
 * filesystem. (ISS-11914 measured that the stat itself raises no permission
 * prompt; reading inside those folders does.)
 */
export function isGitRepository(dirPath: string): boolean {
  if (isTccProtectedDirectory(dirPath)) {
    return false;
  }
  return existsSync(path.join(dirPath, ".git"));
}
