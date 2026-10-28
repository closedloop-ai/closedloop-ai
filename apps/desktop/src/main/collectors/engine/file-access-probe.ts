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
import path from "node:path";

/** A harness whose local transcript root could not be read. */
export type FileAccessBlock = {
  /** Harness key (e.g. `"codex"`) whose root is unreadable. */
  harness: string;
  /** The unreadable root, home-abbreviated (e.g. `~/.codex/sessions`). */
  path: string;
};

/**
 * The readability verdict for a single root.
 *
 * ISS-8506 added the const object beside the pre-existing union so consumers
 * compare against members instead of repeating the four literals; the type is
 * unchanged, so every existing comparison keeps compiling.
 */
export const PathReadability = {
  Readable: "readable",
  Blocked: "blocked",
  Absent: "absent",
  Unknown: "unknown",
} as const;
export type PathReadability =
  (typeof PathReadability)[keyof typeof PathReadability];

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
    return PathReadability.Blocked;
  }
  if (code === "ENOENT") {
    return PathReadability.Absent;
  }
  return PathReadability.Unknown;
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
    return PathReadability.Readable;
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
    const blockedRoot = roots.find(
      (root) => checkReadable(root) === PathReadability.Blocked
    );
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

/**
 * Replace the home-directory prefix with `~` for a user-facing path.
 *
 * Exported for ISS-8506's byte-inventory evidence, which reports the same roots
 * this probe classifies and must abbreviate them the same way.
 */
export function abbreviateHomePath(absolute: string): string {
  const home = os.homedir();
  if (!home) {
    return absolute;
  }
  if (absolute === home) {
    return "~";
  }
  // A bare `startsWith(home)` also matches a SIBLING whose name merely begins
  // with the home basename, and ISS-12521's picker hands this any folder the
  // user chooses: with home `/Users/bob`, `/Users/bobby/code` abbreviated to
  // `~by/code` (tamsinb, PR #8917). The separator is what makes it a
  // descendant.
  if (absolute.startsWith(`${home}${path.sep}`)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}

/**
 * Whether a single FILE is present and readable.
 *
 * {@link checkPathReadable} opens a directory, which is the right granularity
 * for a TCC/permission denial on a harness root but cannot answer "does this
 * file exist" — it throws `ENOTDIR` on a regular file. ISS-8506 needs the file
 * question for `opencode.db`, whose presence is what says OpenCode is installed
 * at all (its home directory can exist without it). Same error classification,
 * so the two verdicts read from one vocabulary.
 */
export function checkFilePresence(filePath: string): PathReadability {
  try {
    fs.statSync(filePath);
    return PathReadability.Readable;
  } catch (error) {
    return classifyAccessError(error);
  }
}

/**
 * The same verdict as {@link checkPathReadable}, off the calling thread.
 *
 * Required for any probe of a path the USER chose while on the Electron main
 * thread: `opendirSync` against a stalled network volume under `/Volumes`
 * blocks the whole app until the mount times out (marisolashgrove, PR #8917,
 * ISS-12521). The synchronous twin stays for the harness-root sweeps
 * (`probeFileAccessBlocks`, `probeTranscriptHarnesses`), whose roots are local
 * dotfolders and whose callers are synchronous end to end.
 */
export async function checkPathReadableAsync(
  root: string
): Promise<PathReadability> {
  try {
    const dir = await fs.promises.opendir(root);
    await dir.close();
    return PathReadability.Readable;
  } catch (error) {
    return classifyAccessError(error);
  }
}
