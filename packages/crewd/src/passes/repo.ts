/** Small git helpers used by the passes. */
import { execCommand } from "../exec-cli.js";

export function git(args: string[], cwd: string): Promise<string> {
  return execCommand("git", args, { cwd });
}

/** Distinct files touched by the last `n` commits — the reviewer's hot-spot hint. */
export async function recentlyChangedFiles(
  repoDir: string,
  n = 40
): Promise<string[]> {
  const out = await git(
    ["log", "-n", String(n), "--name-only", "--pretty=format:"],
    repoDir
  ).catch(() => "");
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const f = line.trim();
    if (f) {
      seen.add(f);
    }
  }
  return [...seen];
}

/** Candidate names for a repo's primary/default branch, tried in order. */
const MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;

/**
 * Resolve the repo's default-branch ref for a diff base, preferring the tracked
 * remote head (`origin/main`) and falling back to a local `main`/`master`.
 * Returns null when none resolve (a shallow clone with no main, a detached
 * checkout) so the caller can degrade gracefully.
 */
export async function resolveMainRef(repoDir: string): Promise<string | null> {
  for (const branch of MAIN_BRANCH_CANDIDATES) {
    for (const ref of [`origin/${branch}`, branch]) {
      const ok = await git(["rev-parse", "--verify", "--quiet", ref], repoDir)
        .then((out) => out.trim().length > 0)
        .catch(() => false);
      if (ok) {
        return ref;
      }
    }
  }
  return null;
}

/**
 * Files changed vs. the merge-base with the repo's main branch — the
 * `changed-since-main` scope (FEA-3850 M4). Unions three sources, all scoped to
 * the branch's OWN work:
 *   - `git diff --name-only <mainRef>...HEAD` — the three-dot (symmetric) diff
 *     against the merge base, so committed branch work only, never divergence
 *     that landed on main after the branch forked.
 *   - `git diff --name-only HEAD` — staged + unstaged working-tree changes vs.
 *     HEAD (the branch's uncommitted work). Diffing against HEAD, NOT `mainRef`,
 *     is deliberate: `git diff <mainRef>` would fold every upstream-only file
 *     into the branch audit once main advances, silently widening the scope.
 *   - `git ls-files --others --exclude-standard` — untracked files, so a
 *     not-yet-committed new file is still in scope.
 * Returns `null` when the repo's main branch cannot be resolved (so the caller
 * can degrade to a whole-repo review); returns a (possibly empty) file list
 * when main IS resolved — an empty list then means "resolved, but the branch is
 * clean", which the caller must honor as "review nothing", NOT widen to
 * whole-repo. Never throws.
 */
export async function changedSinceMain(
  repoDir: string
): Promise<string[] | null> {
  const mainRef = await resolveMainRef(repoDir);
  if (!mainRef) {
    return null;
  }
  const committed = await git(
    ["diff", "--name-only", `${mainRef}...HEAD`],
    repoDir
  ).catch(() => "");
  const working = await git(["diff", "--name-only", "HEAD"], repoDir).catch(
    () => ""
  );
  const untracked = await git(
    ["ls-files", "--others", "--exclude-standard"],
    repoDir
  ).catch(() => "");
  const seen = new Set<string>();
  for (const out of [committed, working, untracked]) {
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) {
        seen.add(f);
      }
    }
  }
  return [...seen];
}
