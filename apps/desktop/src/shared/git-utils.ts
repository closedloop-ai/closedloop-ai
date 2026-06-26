import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Returns true if the given directory contains a `.git` entry, indicating it
 * is the root of a git repository.
 */
export function isGitRepository(dirPath: string): boolean {
  return existsSync(path.join(dirPath, ".git"));
}
