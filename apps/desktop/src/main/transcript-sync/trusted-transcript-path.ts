/**
 * @file trusted-transcript-path.ts
 * @description Anchor guard for hook-supplied harness transcript paths. The
 * transcript hook listener is an unauthenticated localhost endpoint, so the
 * path it hands us is attacker-influenceable and drives a raw byte upload to
 * the cloud (a presigned S3 PUT). A path is trusted only when its REAL location
 * — resolved through `realpath`, so symlinks are followed — is a `.jsonl`
 * regular file contained in one of the real harness transcript roots: the
 * Claude projects root OR a Codex sessions/archived root (Codex sessions are
 * cloud-parseable too, so a Codex rollout file whose cloud read fails must be
 * accepted for the local fallback — otherwise Codex sessions can never fall
 * back and always show the cloud error).
 *
 * String normalization alone (`path.resolve` + prefix check) is symlink-
 * bypassable: a `.jsonl` symlink placed anywhere under a trusted root pointing
 * at e.g. `~/.ssh/id_rsa` or `~/.aws/credentials` satisfies the prefix, and the
 * executor's `open()` then follows it and exfiltrates the target's bytes.
 * Canonicalizing BOTH the candidate and each root with `realpath` before the
 * containment check closes that hole — the real target of such a symlink lies
 * outside every trusted root.
 *
 * Like plans/safe-plan-file.ts (the mirrored convention), this RETURNS the
 * resolved real path rather than a boolean, so the caller uploads the vetted
 * canonical path instead of re-opening the original symlink. Re-opening the
 * un-resolved symlink would re-introduce the exact hole via a check-then-use
 * race (the link repointed at a secret between guard and open). Also mirrors the
 * `realpathSync` canonicalization used by the coaching-pack installer
 * (agent-coaching-packs.ts).
 *
 * Mirrors collectors/claude/claude-home `getProjectsDir` and the Codex home
 * paths, but is resolved locally: desktop boot files may NOT static-import
 * collector modules (agent-dashboard boundary). `codex-home-paths.ts` is a leaf
 * module (only `node:os`/`node:path`), so importing it does not pull the
 * collector graph in.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCodexArchivedDir,
  getCodexSessionsDir,
} from "../util/codex-home-paths.js";

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

/** Canonicalize a root (following symlinks); fall back to the raw path when it does not exist. */
function canonicalizeRoot(raw: string): string {
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/**
 * The desktop-materialized OpenCode transcript RAW root, or null when not wired.
 * FEA-3932: OpenCode projections live under `<stateDir>/transcript-materialized/
 * opencode`, which the archive lane uploads. Set once at boot (the state dir is a
 * runtime value, not a fixed home). Stored RAW and canonicalized LAZILY in
 * {@link trustedTranscriptRoots} on every read (matching the Claude/Codex roots)
 * because the materialized root does NOT exist yet at registration time — the
 * first materialize creates it. Canonicalizing at set-time would fall back to the
 * raw path, so once the dir later materializes behind a symlinked userData dir the
 * cached raw prefix would no longer match a `realpath`-resolved candidate and the
 * anchor would wrongly reject a legitimately-materialized file. A null/unset root
 * simply adds no extra trusted location (Claude/Codex behavior unchanged).
 */
let materializedOpencodeRawRoot: string | null = null;

/**
 * Register the materialized OpenCode root as a trusted transcript root. Called
 * once at boot with `<stateDir>/transcript-materialized/opencode`. Idempotent.
 * Stores the RAW path; canonicalization happens lazily per read in
 * {@link trustedTranscriptRoots} (see {@link materializedOpencodeRawRoot} for
 * why). Passing null clears it.
 */
export function setMaterializedOpencodeTranscriptRoot(
  root: string | null
): void {
  materializedOpencodeRawRoot = root;
}

/**
 * Every trusted transcript root, canonicalized: the Claude projects root, the
 * Codex sessions + archived-sessions roots, and (when registered) the
 * materialized OpenCode root. A candidate is accepted when its real path is
 * contained in ANY of these. Codex is included because its rollout `.jsonl`
 * files live outside `~/.claude/projects` yet are cloud-parseable; the
 * materialized OpenCode root holds the desktop-generated projection files the
 * lane uploads (FEA-3932).
 */
function trustedTranscriptRoots(): readonly string[] {
  const roots = [
    claudeProjectsRoot(),
    canonicalizeRoot(getCodexSessionsDir()),
    canonicalizeRoot(getCodexArchivedDir()),
  ];
  if (materializedOpencodeRawRoot !== null) {
    // Canonicalize lazily on each read: the dir is created by the first
    // materialize AFTER registration, so a set-time realpath would have cached
    // the raw path and stopped matching once it later resolved behind a symlink.
    roots.push(canonicalizeRoot(materializedOpencodeRawRoot));
  }
  return roots;
}

/**
 * Returns the resolved real path when `candidate` resolves (following symlinks)
 * to a `.jsonl` regular file whose real path is contained in ANY trusted harness
 * transcript root (Claude projects, a Codex sessions/archived root, or the
 * materialized OpenCode root); otherwise `null`. A nonexistent candidate/root, a
 * dangling symlink, or a symlink escaping every root all return `null`. The
 * caller must open the returned real path (not the original candidate) so a
 * symlink cannot be repointed between the check and the read.
 *
 * NAME: kept as `...Claude...` for call-site stability, but it now vets Claude,
 * Codex, and materialized OpenCode transcript roots (see
 * {@link trustedTranscriptRoots}).
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
  if (!realFile.endsWith(".jsonl")) {
    return null;
  }
  const isInsideATrustedRoot = trustedTranscriptRoots().some((root) =>
    isPathInside(realFile, root)
  );
  return isInsideATrustedRoot ? realFile : null;
}

/**
 * Walk up from `start` to the nearest EXISTING ancestor directory and return its
 * canonical real path (symlinks followed), or `null` if no ancestor exists.
 */
function nearestExistingRealDir(start: string): string | null {
  let dir = start;
  let parent = path.dirname(dir);
  while (parent !== dir) {
    try {
      return realpathSync(dir);
    } catch {
      dir = parent;
      parent = path.dirname(dir);
    }
  }
  // `dir` is the filesystem root — try it once (dirname of "/" is "/").
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Classifies a candidate that {@link resolveTrustedClaudeTranscriptPath} would
 * REJECT (return `null` for) into "benign not-yet-flushed race" vs. "genuinely
 * untrusted". Returns `true` only for the benign race: the `<uuid>.jsonl` is not
 * on disk yet but WOULD live under a trusted transcript root — Claude Code emits
 * the transcript hook at `SessionStart` and the first `UserPromptSubmit` before
 * the file is created/flushed, so the anchor's own ENOENT path fires and the
 * caller would otherwise log it as an untrusted rejection and defeat the live-
 * hook fast path (FEA-3464).
 *
 * This NEVER authorizes an upload and does NOT loosen the anchor: a `true` here
 * only suppresses a spurious log (and lets the caller re-resolve later). Before a
 * byte is read the caller still re-runs the full `realpath` anchor
 * ({@link resolveTrustedClaudeTranscriptPath}), so a path that later materializes
 * as an escaping symlink is still followed and rejected at upload time.
 *
 * Only a genuinely ABSENT path is a race: if anything already exists at the
 * location (a regular file, a directory, or a symlink — including one whose
 * target escapes the root) it is a real rejection, not a race, so this returns
 * `false` and the caller logs it. Containment is decided by canonicalizing the
 * nearest existing ancestor directory (so a symlinked projects root still
 * matches), never by trusting the raw candidate string.
 */
export function isPendingTrustedTranscriptPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  if (!resolved.endsWith(".jsonl")) {
    return false;
  }
  // `lstat` (no symlink follow): a race means NOTHING is at the path yet. An
  // existing symlink/dir/file is a real rejection to be logged, not a race.
  try {
    lstatSync(resolved);
    return false;
  } catch {
    // Absent (ENOENT) — fall through to the ancestor-containment check.
  }
  const realDir = nearestExistingRealDir(path.dirname(resolved));
  if (realDir === null) {
    return false;
  }
  return trustedTranscriptRoots().some((root) => isPathInside(realDir, root));
}
