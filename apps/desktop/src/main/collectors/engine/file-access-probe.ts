/**
 * @file file-access-probe.ts
 * @description FEA-3639 — detect when a harness's local transcript root exists
 * but the OS won't let us read it (a denied macOS file-access / TCC prompt, or a
 * classic permission error). The collectors are deliberately error-tolerant — a
 * denied root is silently skipped during discovery (`collectJsonlFiles` swallows
 * the readdir error), so the import quietly under-populates and the Sessions view
 * stalls with no explanation. This surfaces that block as a structured signal the
 * renderer can turn into "Waiting on file access to ~/.codex — allow it, then
 * Reload," instead of leaving the user staring at an empty list.
 *
 * Pure + Node-only (`node:fs`/`node:os`/`node:path`); the harness→roots registry
 * is supplied by the caller (the dashboard runtime maps it off
 * `BUILTIN_TRANSCRIPT_SOURCES`) so this module carries no collector/parser deps
 * and stays trivially testable.
 */
import fs from "node:fs";
import os from "node:os";

/** A harness whose local transcript root could not be read. */
export type FileAccessBlock = {
  /** Harness key (e.g. `"codex"`) whose root is unreadable. */
  harness: string;
  /** The unreadable root, home-abbreviated (e.g. `~/.codex/sessions`). */
  path: string;
};

/** The readability verdict for a single root. */
export type PathReadability = "readable" | "blocked" | "absent" | "unknown";

/** A harness paired with the local root(s) its transcripts live under. */
export type HarnessScanRoot = { harness: string; roots: string[] };

/**
 * Classify an fs error thrown while probing a root's readability.
 * `EACCES`/`EPERM` (including macOS TCC denials) mean the user must grant access
 * — a real block. `ENOENT` means the harness simply isn't installed here, which
 * is not a block. Anything else stays `unknown` so a transient/odd IO error
 * never over-reports a permission block.
 */
export function classifyAccessError(error: unknown): PathReadability {
  const code = readErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return "blocked";
  }
  if (code === "ENOENT") {
    return "absent";
  }
  return "unknown";
}

/** Whether a single root is readable, blocked on permission, or absent. */
export function checkPathReadable(root: string): PathReadability {
  try {
    // Open the directory — the exact operation the collector import performs
    // (`collectJsonlFiles` → `readdirSync`, which opendir()s first) and where a
    // macOS TCC / permission denial actually surfaces. A stat-family check
    // (`fs.accessSync`) can succeed on a TCC-blocked directory, so it would miss
    // the very block this probe exists to detect; mirror the real read path.
    fs.opendirSync(root).closeSync();
    return "readable";
  } catch (error) {
    return classifyAccessError(error);
  }
}

/**
 * Probe each harness's roots and return one block per harness whose root exists
 * but is unreadable. A harness is reported at most once (its first blocked
 * root): a denied permission usually blocks the whole home tree, so enumerating
 * every subdirectory would be noise. `checkReadable` is injected for tests.
 */
export function probeFileAccessBlocks(
  scanRoots: HarnessScanRoot[],
  checkReadable: (root: string) => PathReadability = checkPathReadable
): FileAccessBlock[] {
  const blocks: FileAccessBlock[] = [];
  for (const { harness, roots } of scanRoots) {
    const blockedRoot = roots.find((root) => checkReadable(root) === "blocked");
    if (blockedRoot !== undefined) {
      blocks.push({ harness, path: abbreviateHomePath(blockedRoot) });
    }
  }
  return blocks;
}

/** Read a string `code` off an unknown thrown value without an unsafe cast. */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Replace the home-directory prefix with `~` for a user-facing path. */
function abbreviateHomePath(absolute: string): string {
  const home = os.homedir();
  if (home && absolute.startsWith(home)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}
