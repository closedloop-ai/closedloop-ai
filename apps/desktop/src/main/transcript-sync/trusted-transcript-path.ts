/**
 * @file trusted-transcript-path.ts
 * @description Anchor guard for hook-supplied Claude transcript paths. The
 * transcript hook listener is an unauthenticated localhost endpoint, so the
 * path it hands us is attacker-influenceable and drives a raw byte upload to
 * the cloud (a presigned S3 PUT). A path is trusted only when its REAL location
 * — resolved through `realpath`, so symlinks are followed — is a `.jsonl`
 * regular file contained in the real Claude projects root.
 *
 * String normalization alone (`path.resolve` + prefix check) is symlink-
 * bypassable: a `.jsonl` symlink placed anywhere under `~/.claude/projects`
 * pointing at e.g. `~/.ssh/id_rsa` or `~/.aws/credentials` satisfies the prefix,
 * and the executor's `open()` then follows it and exfiltrates the target's
 * bytes. Canonicalizing BOTH the candidate and the projects root with
 * `realpath` before the containment check closes that hole — the real target of
 * such a symlink lies outside the projects root.
 *
 * Like plans/safe-plan-file.ts (the mirrored convention), this RETURNS the
 * resolved real path rather than a boolean, so the caller uploads the vetted
 * canonical path instead of re-opening the original symlink. Re-opening the
 * un-resolved symlink would re-introduce the exact hole via a check-then-use
 * race (the link repointed at a secret between guard and open). Also mirrors the
 * `realpathSync` canonicalization used by the coaching-pack installer
 * (agent-coaching-packs.ts).
 *
 * Mirrors collectors/claude/claude-home `getProjectsDir`, but is resolved
 * locally: desktop boot files may NOT static-import collector modules
 * (agent-dashboard boundary).
 */
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mirrors the containment check in plans/safe-plan-file.ts / window.ts. */
function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/**
 * The Claude projects root: `$CLAUDE_HOME/projects`, else `~/.claude/projects`.
 * Resolved to its canonical real path (following symlinks) so that paths built
 * from this root and paths resolved through `realpathSync` in
 * {@link resolveTrustedClaudeTranscriptPath} share the same prefix. Without
 * canonicalization, a symlinked projects dir produces path-hash mismatches
 * between hook-driven uploads (which canonicalize the candidate) and discovery-
 * sweep entries (which start from this root).
 */
function claudeProjectsRoot(): string {
  const claudeHome =
    process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const raw = path.join(claudeHome, "projects");
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/**
 * Returns the resolved real path when `candidate` resolves (following symlinks)
 * to a `.jsonl` regular file whose real path is contained in the real Claude
 * projects root; otherwise `null`. A nonexistent candidate/root, a dangling
 * symlink, or a symlink escaping the root all return `null`. The caller must
 * open the returned real path (not the original candidate) so a symlink cannot
 * be repointed between the check and the read.
 */
export function resolveTrustedClaudeTranscriptPath(
  candidate: string
): string | null {
  let realFile: string;
  try {
    realFile = realpathSync(path.resolve(candidate));
    if (!statSync(realFile).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const realRoot = claudeProjectsRoot();
  return realFile.endsWith(".jsonl") && isPathInside(realFile, realRoot)
    ? realFile
    : null;
}
