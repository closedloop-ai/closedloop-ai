/**
 * Shared desktop test helpers: environment save/restore, a hermetic git
 * fixture repo, and the sanctioned binary-override fall-through opt-out.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../scripts/hermetic-git-env.mjs";
import { GIT_FIXTURE_CHILD_TIMEOUT_MS } from "./helpers/git-fixture.js";

const execFileAsync = promisify(execFile);

export function saveEnvVars(
  keys: readonly string[]
): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return saved;
}

export function restoreEnvVars(
  saved: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Build a throwaway git repo for a test fixture.
 *
 * HERMETIC (ISS-5836): both spawns below run with `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` nulled, so the operator's `~/.gitconfig` cannot reach the
 * fixture. Without it, a global `core.hooksPath` runs that machine's
 * `pre-commit` hook on the commit below — measured rejecting 3 of 22 tests in
 * `git-action-diff-ops.test.ts` on the reporting machine, and green in CI, which
 * only containers lacking such a config ever see.
 *
 * The runner sets the same env process-wide, so this is belt-and-braces there.
 * It is the ONLY protection when a developer runs one file directly
 * (`pnpm exec tsx --test test/foo.test.ts`) and bypasses the runner.
 *
 * The repo-local `user.email`/`user.name` below are required, not incidental:
 * nulling the global config also removes any global identity the commit would
 * otherwise have inherited.
 */
export async function initGitRepo(
  repoPath: string,
  options: { allowEmpty?: boolean } = {}
): Promise<void> {
  const commitStep = options.allowEmpty
    ? "git commit --allow-empty -m initial"
    : `echo "# initial" > README.md && git add . && git commit -m initial`;
  await execFileAsync(
    "/bin/sh",
    [
      "-c",
      [
        `git init -b main "${repoPath}"`,
        `cd "${repoPath}"`,
        "git config user.email test@test.com",
        "git config user.name Test",
        commitStep,
      ].join(" && "),
    ],
    { env: hermeticGitEnv(), timeout: GIT_FIXTURE_CHILD_TIMEOUT_MS }
  );
  // Fail loudly if a fake git binary on PATH no-op'd init without creating
  // .git metadata. Otherwise callers that depend on real git state silently
  // break.
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoPath,
      stdio: "pipe",
      env: hermeticGitEnv(),
      timeout: GIT_FIXTURE_CHILD_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      `initGitRepo(${repoPath}): git init appeared to succeed but no .git ` +
        "metadata was created. A fake git binary on PATH is the most likely cause. " +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
