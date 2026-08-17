/**
 * @file git-fixture.ts
 * @description Shared builders for the symphony suites that need a REAL git repo
 * with a real origin — `symphony-loop-multi-repo-worktree.test.ts` and
 * `symphony-loop-branch-materialization.test.ts`, which carried byte-identical
 * private copies of `createRepoWithOrigin` before ISS-5836.
 *
 * Keeping one copy is what makes hermeticity impossible to apply to only one of
 * them: every git spawn here goes through `runGitFixture`, so a fixture repo
 * cannot be built non-hermetically by adding a call to the wrong helper.
 *
 * Full rationale for the hermetic env — why the operator's `~/.gitconfig`
 * reaching a `mkdtemp` repo is a correctness bug and not just a slow one — lives
 * in `apps/desktop/scripts/hermetic-git-env.mjs`.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../scripts/hermetic-git-env.mjs";

const execFileAsync = promisify(execFile);

/**
 * Per-CHILD timeout for one fixture `git` spawn.
 *
 * This is not a second flavor of the runner's per-test budget; it exists because
 * that budget cannot always enforce itself. A `git` that WEDGES — waiting on an
 * `index.lock`, a hook prompting on stdin, a credential helper — is not slow, it
 * is stuck, and an unbounded child either blocks the worker outright (the sync
 * spawns below) or leaks a live handle that keeps node:test's event loop from
 * draining. Either way the failure is reported by the coarse 900s whole-runner
 * cap as a dead suite rather than by the named test. Bounding the CHILD is what
 * restores attribution. This is the second half of the ISS-5403 lesson (PR
 * #4736, `wongk` review); that PR's `packages/crewd/test/helpers/git-fixture.ts`
 * is the reference.
 *
 * 60s is sized against desktop's `--test-timeout=120000` per-test cap, not
 * crewd's 30s one: it sits far above any honest spawn — the slowest WHOLE test
 * measured here made a dozen-plus spawns in ~9s on a machine at 1-min load 230 —
 * and at half the per-test cap it still leaves node:test room to attribute the
 * failure to the named test instead of the runner.
 */
export const GIT_FIXTURE_CHILD_TIMEOUT_MS = 60_000;

/**
 * Run one fixture `git` command hermetically, and bounded.
 *
 * `clone`, `commit` and `push` below each fire a hook, so a global
 * `core.hooksPath` would run the operator's hooks inside the fixture — measured
 * failing 8 of the 9 tests in the worktree suite before this fix.
 */
export function runGitFixture(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: hermeticGitEnv(),
    timeout: GIT_FIXTURE_CHILD_TIMEOUT_MS,
  });
}

/**
 * Build a repo at `<root>/<name>` with one commit on `main`, pushed to a local
 * bare origin at `<root>/<name>.git`, whose `origin` URL reads as
 * `git@github.com:org/<name>.git` while pushes still resolve to the local path.
 */
export async function createRepoWithOrigin(
  root: string,
  name: string
): Promise<{ repoPath: string; originPath: string; fullName: string }> {
  const originPath = path.join(root, `${name}.git`);
  const repoPath = path.join(root, name);
  await runGitFixture(["init", "--bare", "-b", "main", originPath]);
  await runGitFixture(["clone", originPath, repoPath]);
  // Required, not incidental: hermetic git has no global identity to inherit.
  await runGitFixture(["config", "user.email", "test@example.com"], repoPath);
  await runGitFixture(["config", "user.name", "Test User"], repoPath);
  await fs.writeFile(path.join(repoPath, "README.md"), `# ${name}\n`);
  await runGitFixture(["add", "README.md"], repoPath);
  await runGitFixture(["commit", "-m", "initial"], repoPath);
  await runGitFixture(["push", "-u", "origin", "main"], repoPath);
  const fullName = `org/${name}`;
  await runGitFixture(
    ["remote", "set-url", "origin", `git@github.com:${fullName}.git`],
    repoPath
  );
  await runGitFixture(
    ["remote", "set-url", "--push", "origin", originPath],
    repoPath
  );
  return { repoPath, originPath, fullName };
}

/** Resolve a branch to its sha in a bare origin built by `createRepoWithOrigin`. */
export async function remoteBranchSha(
  originPath: string,
  branchName: string
): Promise<string> {
  const result = await runGitFixture([
    "--git-dir",
    originPath,
    "rev-parse",
    branchName,
  ]);
  return result.stdout.trim();
}
