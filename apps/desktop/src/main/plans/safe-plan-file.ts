/**
 * @file safe-plan-file.ts
 * @description Validation guard for plan/log file paths handed to Electron's
 * `shell.openPath`. openPath delegates the path to the OS file association, so
 * a store row whose `filePath`/`sourceLogPath` points at a `.command`/`.app`/
 * shell script (via a poisoned sync record or a renderer reaching the
 * `desktop:db:open-plan` channel) would be *executed*, not opened in an editor.
 *
 * Plan files and session transcripts only ever originate from the local agent
 * homes — `~/.claude/plans/*.md(x)`, `~/.claude/projects/**​/*.jsonl` and
 * `~/.cursor/projects/**​/*.jsonl` — so before opening we resolve the real path
 * (following symlinks) and assert it (a) is a regular file inside one of those
 * roots and (b) carries an allowlisted, non-executable text extension. Anything
 * else is rejected. Pairs with the IPC sender gate on the `desktop:db:*`
 * handlers.
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getClaudeHome } from "../collectors/claude/claude-home.js";
import { getCursorHome } from "../collectors/cursor/cursor-home.js";

/**
 * Text/markdown/transcript extensions that are safe to hand to the OS opener.
 * Deliberately an allowlist (not a denylist): everything executable or
 * script-like — `.command`, `.app`, `.sh`, `.scpt`, `.bat`, … — is rejected by
 * omission.
 */
const OPENABLE_PLAN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".log",
]);

/** Mirrors the app-protocol containment check in window.ts. */
function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/**
 * Returns the resolved real path when `filePath` is a regular file inside an
 * allowed agent home and carries an allowlisted, non-executable extension;
 * otherwise `null`. Both the candidate and each root are passed through
 * `realpath` so a symlinked file cannot escape the allowed roots, and the
 * extension is checked on the resolved target rather than the (possibly
 * spoofed) symlink name.
 *
 * `extraRoots` lets a caller add roots it resolves differently than the
 * defaults — e.g. the open-plan handler passes Electron's `app.getPath("home")`
 * because plan backfill roots its `plansDir` there, which can diverge from
 * `os.homedir()` (used by `getClaudeHome`) in unusual environments.
 */
export function resolveOpenablePlanFilePath(
  filePath: string,
  extraRoots: readonly string[] = []
): string | null {
  let realFile: string;
  try {
    realFile = realpathSync(filePath);
    if (!statSync(realFile).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  if (
    !OPENABLE_PLAN_FILE_EXTENSIONS.has(path.extname(realFile).toLowerCase())
  ) {
    return null;
  }
  for (const root of [getClaudeHome(), getCursorHome(), ...extraRoots]) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (isPathInside(realFile, realRoot)) {
      return realFile;
    }
  }
  return null;
}
