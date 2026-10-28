// @ts-check

/**
 * ISS-5836 — git hermeticity for the desktop test suite.
 *
 * `git` reads `~/.gitconfig` (and `/etc/gitconfig`) even inside a throwaway repo
 * created under `mkdtemp`, so whatever the operator has configured globally
 * executes inside a fixture. A developer whose global config sets
 * `core.hooksPath` — pointing at, say, a `gitleaks` secret-scan `pre-commit`
 * hook, a normal thing to have — has that hook run on every fixture commit.
 *
 * Two distinct hazards, not one:
 *
 * 1. CORRECTNESS. An arbitrary hook (`pre-commit`, `post-checkout`, `pre-push`)
 *    executes inside a fixture repo and can mutate or REJECT it. Measured on the
 *    reporting machine before this fix: a rejecting global `pre-commit` failed
 *    3 of 22 tests in `git-action-diff-ops.test.ts` (and most of a multi-repo
 *    worktree suite since removed), purely from the operator's git config. A test asserting on repo state must never depend on it.
 * 2. SPEED. ISS-5403 measured the same mechanism in a sibling package at
 *    **1933ms per `git commit` versus 55ms hermetic** — ~35x — which pushed
 *    tests past their timeout and aborted the package's whole run.
 *
 * CI is green and stays green: CI containers set no global `core.hooksPath`, so
 * the mechanism cannot occur there. That is exactly what makes this expensive —
 * the cost is paid silently and repeatedly by whoever has that git config, and
 * the suite reports the failure as a defect in the code under test.
 *
 * WHY THIS LIVES IN `scripts/` AS `.mjs`, not in `test/helpers/*.ts`: it has two
 * consumers that cannot share a module format. `run-node-tests.mjs` is run by
 * plain `node` with no TypeScript loader, and the fixture helpers under `test/`
 * are TypeScript run through `tsx`. A `.mjs` module is importable by both, so
 * the literal `/dev/null` pair is declared exactly once instead of being copied
 * into each — the SSOT-drift-by-copy defect this repo names by name. The
 * sibling `run-node-tests-outcome.mjs` is imported the same way from
 * `test/ambient-host-env-hermeticity.test.ts`.
 *
 * The TypeScript side types this by INFERENCE: `tsconfig.tests.json` sets
 * `allowJs`, so `tsc` reads the objects below and a consumer's
 * `HERMETIC_GIT_ENV.GIT_ALLOW_PROTOCOL` is a compile error the moment that key
 * goes. There was a hand-written `hermetic-git-env.d.mts` here until ISS-10194
 * review; do not bring it back, because a declaration is a second copy of the
 * key set and it drifts with `tsc` green.
 *
 * APPLIED IN THREE PLACES, because none of them covers the others:
 *
 * - `run-node-tests.mjs` hands this env to the test process, so EVERY git spawn
 *   in the suite inherits it — including git spawned by the PRODUCTION code the
 *   tests drive (`git worktree add/remove/prune`, `git clone`, `git push`),
 *   which no fixture helper can reach. Verified: with an observation-only global
 *   `core.hooksPath`, `post-checkout` fired inside production-created worktree
 *   directories and `pre-push` fired on production pushes.
 * - `stress-node-tests.mjs` is the OTHER documented runner and spawns
 *   `tsx --test` itself rather than delegating to the one above, so fixing only
 *   that one left this hole open on the run most likely to hit it: point
 *   `STRESS_FILE` at a git-heavy suite and the hooks fire once per iteration,
 *   x50 by default, which is exactly how machine state gets misread as a flake.
 * - The shared fixture builders (`initGitRepo`, `initGitRepoWithOrigin`) set it
 *   on their own spawns, so a repo they build is hermetic BY CONSTRUCTION rather
 *   than by inheritance — which still holds when a developer runs a single file
 *   directly (`pnpm exec tsx --test test/foo.test.ts`) and bypasses the runner.
 *
 * This is the same fix ISS-5403 applied to that package's own git fixtures.
 */

/**
 * Env that makes a git invocation ignore the operator's global and system
 * config.
 *
 * Only an UNSET variable falls back to the real `~/.gitconfig`. An empty string
 * suppresses the global config just as well — verified empirically, so do not
 * "fix" a `""` here thinking it is a bug. `/dev/null` is still what this uses:
 * it is git's documented idiom and names a real readable path, where `""` reads
 * like a value someone forgot to fill in and is the shape an env-scrubbing layer
 * produces by accident.
 *
 * Deliberately NOT included: `GIT_CONFIG_NOSYSTEM`. `GIT_CONFIG_SYSTEM` already
 * covers the system file, and carrying both would be two spellings of one
 * decision.
 *
 * `GIT_ALLOW_PROTOCOL` is the ISS-10194 half, and it is the same mechanism
 * pointed at a second source of machine state: the network. A suite whose fake
 * `git` failed to install runs the REAL git, and the clone path builds
 * `https://github.com/<org>/<repo>.git`, so the assertions turn on network
 * conditions and on whether that repo name happens to exist. Measured on
 * 2026-09-14: `remote: Repository not found.` — a github.com response — reached
 * a unit suite. `file` is every transport the desktop fixtures actually use
 * (bare local remotes, cloned by path or `file://`); `https` and `ssh` are
 * refused by git itself, locally, before any DNS or TCP, with
 * `fatal: transport 'https' not allowed`. That message cannot be produced by a
 * network failure, so it names its own cause.
 *
 * These keys are SCREAMING_SNAKE because they are git's own contract, which is
 * the external-wire-format exception to the repo's camelCase rule.
 */
export const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ALLOW_PROTOCOL: "file",
};

/**
 * Env that makes an unusable EXPLICIT binary override a hard failure in the
 * test process instead of a silent fall-through to the real binary.
 *
 * Not part of {@link HERMETIC_GIT_ENV}: that object is git's own contract and
 * is also handed to individual git children, whereas this one configures OUR
 * resolver and only means anything in the process where `getResolvedGitPath()`
 * runs. Its name is read back by
 * `src/server/operations/binary-path-overrides.ts`; that is the ONLY other
 * place the name is written, and nothing pins the two spellings to each other
 * by name, so the guard is behavioural — see the `DESKTOP_TEST_STRICT_ENV`
 * cases in `test/iss-10194-binary-override-fallthrough.test.ts`, which apply
 * this exact object and assert the resolver's decision flips.
 */
export const DESKTOP_TEST_STRICT_ENV = {
  CLOSEDLOOP_DESKTOP_STRICT_BINARY_OVERRIDES: "1",
};

/**
 * Build a child env that is hermetic with respect to git config.
 *
 * `HERMETIC_GIT_ENV` is spread LAST, after `base`, on purpose: hermeticity is
 * the suite's invariant, not a default a caller may override by passing its own
 * `GIT_CONFIG_GLOBAL`. Spreading it first would let an inherited value from the
 * developer's shell win and silently restore the bug.
 *
 * Note that this does NOT strip repo-local config (`.git/config`) — fixtures
 * legitimately set `user.name`/`user.email` there, and must keep doing so, since
 * nulling the global config also removes any global identity they would
 * otherwise have inherited.
 *
 * @param {NodeJS.ProcessEnv} [base] Env to layer onto; defaults to the current
 *   process env, read at call time so callers that mutate `PATH`/`HOME` first
 *   (as several desktop suites do) still have those changes honored.
 * @returns {NodeJS.ProcessEnv}
 */
export function hermeticGitEnv(base = process.env) {
  return { ...base, ...HERMETIC_GIT_ENV };
}
