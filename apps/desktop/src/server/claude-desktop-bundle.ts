import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Discovery of the copy of Claude Code that Claude Desktop ships and manages
 * itself, at `~/Library/Application Support/Claude/claude-code/<version>/
 * claude.app/Contents/MacOS/claude`. It cannot be a literal in
 * `KNOWN_BINARY_LOCATIONS` (`shell-path.ts`): that list is a flat `string[]`
 * with no globbing, and `<version>` moves on every Desktop update. ISS-7203.
 */

const CLAUDE_DESKTOP_SUPPORT_DIR = [
  "Library",
  "Application Support",
  "Claude",
  "claude-code",
] as const;

const CLAUDE_DESKTOP_BUNDLE_SUFFIX = [
  "claude.app",
  "Contents",
  "MacOS",
  "claude",
] as const;

const LEADING_VERSION_REGEX = /^\d+(?:\.\d+)*/;

/**
 * Where Claude Desktop keeps its per-version Claude Code installs, or `null`.
 * Deliberately macOS-only: the Windows and Linux bundle layouts are unverified,
 * so this declines rather than probing a guessed path (ISS-7203 out of scope).
 */
export function claudeDesktopBundleRoot(
  platform: NodeJS.Platform,
  homeDir: string
): string | null {
  if (platform !== "darwin") {
    return null;
  }
  return path.join(homeDir, ...CLAUDE_DESKTOP_SUPPORT_DIR);
}

/**
 * Candidate Claude Code executables under `root`, newest version first. Every
 * version is returned, not just the newest, so a half-removed or broken newest
 * install falls through to the previous one; callers still probe each path.
 */
export function discoverBundledClaudeBinaries(root: string): string[] {
  let versionDirs: string[];
  try {
    versionDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Claude Desktop is not installed, or its support dir is unreadable.
    return [];
  }
  return versionDirs
    .sort(compareVersionDirsNewestFirst)
    .map((name) => path.join(root, name, ...CLAUDE_DESKTOP_BUNDLE_SUFFIX));
}

function versionSortKey(name: string): number[] {
  const match = LEADING_VERSION_REGEX.exec(name);
  if (match === null) {
    return [];
  }
  return match[0].split(".").map(Number);
}

/**
 * Descending version order, so `2.1.219` beats `2.1.9` — a plain string sort
 * gets that pair backwards. Names with no leading version sort last.
 */
function compareVersionDirsNewestFirst(a: string, b: string): number {
  const left = versionSortKey(a);
  const right = versionSortKey(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (right[i] ?? -1) - (left[i] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return b.localeCompare(a);
}
