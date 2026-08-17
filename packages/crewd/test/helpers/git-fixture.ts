/**
 * @file git-fixture.ts
 * @description Shared support for the crewd suites that build throwaway git
 * repos and drive the audit pass against them (ISS-5403). Both `audit.test.ts`
 * and `audit-workspace.test.ts` need the same two things, so they live here
 * rather than being copied into each.
 */

import { execFileSync } from "node:child_process";
import { z } from "zod";

/**
 * Env that makes a fixture repo hermetic: git ignores the operator's global and
 * system config.
 *
 * Why this is required, not hygiene. `git` reads `~/.gitconfig` even inside a
 * throwaway repo under `mkdtemp`, so a developer whose global config sets
 * `core.hooksPath` has that hook run on every fixture commit. A global gitleaks
 * secret-scan pre-commit hook — a normal thing to have — measured **1933ms per
 * `git commit` versus 55ms hermetic** on the machine that reported ISS-5403.
 * Multiplied across the commits these fixtures make, that alone pushed the
 * suites past vitest's 5000ms default and failed them against unmodified
 * `main`. CI never saw it because its containers carry no such global config.
 *
 * A fixture repo must not inherit machine state: the suite asserts on the audit
 * pass, and any global-config-driven behavior is a variable it never meant to
 * take a dependency on.
 */
export const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

/**
 * Per-test timeout for the SLOWEST cases in these two suites.
 *
 * Read the criterion carefully before applying this elsewhere: it is "measured
 * near or past the 5000ms default", NOT "spawns git". Spawning git is far too
 * broad a rule — every `runAuditPass` call reaches `recentlyChangedFiles` and
 * so shells out to `git log`, which would sweep in 13 more tests that finish
 * comfortably inside the default and should keep it.
 *
 * Hermetic fixtures remove the pathological cost above but not the ordinary
 * one: these cases spawn a dozen-plus git child processes and copy real trees,
 * and process-spawn latency on a loaded developer machine dominates the run.
 * Measured post-fix on macOS at 1-min load 10.8–13.1, worst of three runs per
 * test: detached-worktree 4915ms, changed-since-main/clean 5637ms,
 * changed-since-main/hot-spots 7907ms, changed-since-main/45-files 8992ms.
 *
 * 30s is ~3.3x the worst observed, chosen so a load spike (ISS-5403 was first
 * seen at load 299) does not turn a slow spawn into a red suite. It is
 * deliberately per-test rather than a package-wide `testTimeout`, so the other
 * 17 crewd suites keep the 5000ms default and a genuine hang still fails fast.
 */
export const GIT_SPAWN_TEST_TIMEOUT_MS = 30_000;

/**
 * Per-CHILD timeout for a single `git` spawn in these fixtures.
 *
 * This is not a second flavor of the per-test budget above; it exists because
 * that budget cannot enforce itself. `execFileSync` blocks the worker thread
 * for the whole life of the child, so vitest never regains the event loop and
 * its per-test timer cannot fire. A `git` that wedges — waiting on an
 * `index.lock`, a hook prompting on stdin, a credential helper — therefore runs
 * PAST `GIT_SPAWN_TEST_TIMEOUT_MS` and is only stopped by the outer runner,
 * which reports a dead suite instead of the named test. Verified against the
 * unmodified wrapper: with a stubbed hanging `git` and a 3000ms per-test
 * timeout, vitest printed no result at all and ran until an external kill.
 *
 * Bounding the CHILD is what restores attribution: the spawn dies, the wrapper
 * throws inside the test body, and vitest fails that test by name.
 *
 * 10s is chosen to sit far above any real spawn and far below the per-test
 * budget. The slowest case measured in ISS-5403 was 8992ms for a whole test
 * making a dozen-plus spawns (~750ms mean each), so no single honest `git` can
 * approach 10s without being genuinely stuck — while 10s leaves 20s of headroom
 * under the 30s per-test budget, so even a wedge on the last of several slow
 * spawns still throws with room for vitest to attribute it.
 */
export const GIT_SPAWN_CHILD_TIMEOUT_MS = 10_000;

/**
 * Shape of the error `execFileSync` throws, which is what tells the two failure
 * modes apart: a timeout kill sets `code: "ETIMEDOUT"` and `signal: "SIGTERM"`
 * with a null `status`, while an ordinary non-zero exit sets `status` and
 * leaves `code` unset.
 */
const SPAWN_FAILURE = z.object({
  code: z.string().nullish(),
  signal: z.string().nullish(),
  status: z.number().nullish(),
  stderr: z.unknown().nullish(),
});

/**
 * Run `git` in a throwaway fixture repo: hermetic, and bounded so a wedged
 * child fails the named test instead of hanging the suite.
 *
 * Shared by `audit.test.ts` and `audit-workspace.test.ts`, which previously
 * kept near-identical private wrappers. Keeping one wrapper is what makes the
 * timeout impossible to apply to only one of the FIXTURES' own spawns. It does
 * not reach git spawned by the production code those fixtures drive
 * (`src/passes/audit-workspace.ts`, `src/exec-cli.ts`), which is plain async
 * `execFile` with no timeout — and does not need one, because async spawns
 * return the event loop to vitest, whose per-test timer then fires and
 * attributes the failure correctly.
 *
 * `stdio: "pipe"` is deliberate on both call sites: it keeps git's chatter out
 * of the test output and captures stderr onto the thrown error, where the
 * message below can surface it.
 *
 * `HERMETIC_GIT_ENV` is spread LAST, after `opts.env`: hermeticity is the
 * fixture's invariant, not a default a call site may override by passing its
 * own `GIT_CONFIG_GLOBAL`.
 */
export function runGitFixture(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): void {
  const timeoutMs = opts.timeoutMs ?? GIT_SPAWN_CHILD_TIMEOUT_MS;
  try {
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      timeout: timeoutMs,
      env: { ...process.env, ...opts.env, ...HERMETIC_GIT_ENV },
    });
  } catch (error) {
    throw new Error(describeGitFixtureFailure(cwd, args, timeoutMs, error), {
      cause: error,
    });
  }
}

/**
 * Turn `execFileSync`'s throw into a message that names the command.
 *
 * Raw, a timed-out spawn reports only `spawnSync git ETIMEDOUT` — it names
 * neither the subcommand nor the fixture repo, which is useless in a suite that
 * spawns a dozen-plus of them per test.
 */
function describeGitFixtureFailure(
  cwd: string,
  args: string[],
  timeoutMs: number,
  error: unknown
): string {
  const cmd = `git ${args.join(" ")} (cwd: ${cwd})`;
  const parsed = SPAWN_FAILURE.safeParse(error);
  if (!parsed.success) {
    return `git fixture command failed: ${cmd}`;
  }
  const { code, signal, status, stderr } = parsed.data;
  if (code === "ETIMEDOUT") {
    return `git fixture command timed out after ${timeoutMs}ms and was killed with ${signal ?? "a signal"}: ${cmd}. The child was still running, so this is a wedged git, not a slow one.`;
  }
  const tail = String(stderr ?? "").trim();
  const exit = status === null || status === undefined ? "unknown" : status;
  return `git fixture command failed (exit ${exit}): ${cmd}${tail ? `\n${tail}` : ""}`;
}
