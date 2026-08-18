/**
 * ISS-5836 — the desktop suite must not read its result off the operator's git
 * config.
 *
 * `git` reads `~/.gitconfig` even inside a repo created under `mkdtemp`, so a
 * developer whose global config sets `core.hooksPath` had that machine's hooks
 * run inside every fixture: `pre-commit` on each fixture commit, `post-checkout`
 * and `pre-push` on the worktree and push operations the production code drives.
 * Measured against unmodified `main` with a rejecting global `pre-commit`:
 * 3 of 22 tests failed in `git-action-diff-ops.test.ts` and 8 of 9 in
 * `symphony-loop-multi-repo-worktree.test.ts`. CI never saw it, because CI
 * containers carry no such global config — which is precisely what made it
 * expensive, since the suite reported it as a defect in the code under test.
 *
 * This is the sibling of ISS-5403 (PR #4736), which fixed the same root cause in
 * `packages/crewd`.
 *
 * Every shared fixture entry point gets a test here, and every one of them sets
 * a HOSTILE global config the way a developer's machine would, then asserts the
 * fixture is unaffected: `initGitRepo` (both arms), `initGitRepoWithOrigin`, and
 * `createRepoWithOrigin` — which is also the coverage for `runGitFixture`, the
 * single spawn helper the whole of `helpers/git-fixture.ts` routes through. The
 * last block covers BOTH documented runners, since each spawns the suite itself.
 * All of them fail against unmodified `main`, which is what makes them
 * regression coverage rather than scaffolding. None assert on timing — the speed
 * hazard is real but the correctness hazard is deterministic, and this repo bans
 * timing assertions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HERMETIC_GIT_ENV,
  hermeticGitEnv,
} from "../scripts/hermetic-git-env.mjs";
import { initGitRepoWithOrigin } from "./attribution-test-helpers.js";
import {
  createRepoWithOrigin,
  remoteBranchSha,
} from "./helpers/git-fixture.js";
import { initGitRepo } from "./symphony-test-utils.js";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const RUNNER_SCRIPT = join(desktopDir, "scripts/run-node-tests.mjs");
const STRESS_SCRIPT = join(desktopDir, "scripts/stress-node-tests.mjs");

/** Spawning node plus a shell stub that exits immediately; far above that. */
const RUNNER_SPAWN_TIMEOUT_MS = 60_000;

/** A sha1 object id, as `git rev-parse` prints it. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The branch name a hostile global `init.defaultBranch` would impose. */
const HOSTILE_DEFAULT_BRANCH = "hostile-default-branch";

/** Every temp dir this file creates, removed in one `after` hook. */
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * Write a global git config that reproduces the reported machine state: a
 * `core.hooksPath` whose `pre-commit` hook records that it ran and then REJECTS
 * the commit, plus a non-default `init.defaultBranch`.
 *
 * Both halves matter. The hook is the correctness hazard ISS-5836 is about; the
 * default branch is an observable that does not need a hook at all, which is how
 * `initGitRepoWithOrigin` — whose `git init` runs no hooks — can be covered.
 */
function writeHostileGlobalConfig(): {
  configPath: string;
  markerPath: string;
} {
  const dir = makeTempDir("iss5836-hostile-config-");
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir);
  const markerPath = join(dir, "pre-commit-ran");
  const hook = join(hooksDir, "pre-commit");
  // Records, then rejects: the marker proves the hook RAN even in a case where
  // something else might have failed the commit, so a green assertion cannot be
  // satisfied by the fixture breaking for an unrelated reason.
  writeFileSync(hook, `#!/bin/sh\ntouch "${markerPath}"\nexit 1\n`, "utf8");
  chmodSync(hook, 0o755);
  const configPath = join(dir, "gitconfig");
  writeFileSync(
    configPath,
    `[core]\n\thooksPath = ${hooksDir}\n[init]\n\tdefaultBranch = ${HOSTILE_DEFAULT_BRANCH}\n`,
    "utf8"
  );
  return { configPath, markerPath };
}

/**
 * Point `GIT_CONFIG_GLOBAL` at a hostile config for the duration of `body`,
 * exactly as an operator's shell would, and restore the previous value.
 *
 * Restores by DELETING when the key was originally unset: assigning `undefined`
 * would leave the string `"undefined"` in `process.env`, which git would then
 * try to read as a config path.
 */
async function withHostileGlobalGitConfig<T>(
  configPath: string,
  body: () => T | Promise<T>
): Promise<T> {
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
  }
}

/**
 * Read a fixture repo's current branch, hermetically.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`: the latter needs a
 * commit to resolve, and `initGitRepoWithOrigin` deliberately makes none, so it
 * would report nothing on exactly the repo one of these tests inspects.
 */
function readRepoBranch(repoPath: string): string {
  const result = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
    env: hermeticGitEnv(),
  });
  // A helper precondition, not a test assertion: if git could not answer there
  // is no branch to compare, and the caller's assertion would report a confusing
  // empty-string diff instead of the real cause.
  if (result.status !== 0) {
    throw new Error(`git symbolic-ref failed in ${repoPath}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("hermeticGitEnv", () => {
  it("nulls both the global and the system config file", () => {
    const env = hermeticGitEnv({});
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  });

  it("wins over an inherited value rather than deferring to it", () => {
    // The ordering bug this guards: spreading HERMETIC_GIT_ENV *first* would let
    // the operator's own GIT_CONFIG_GLOBAL survive and silently restore the bug,
    // while every assertion about the returned object's other keys still passed.
    const env = hermeticGitEnv({
      GIT_CONFIG_GLOBAL: "/home/dev/.gitconfig",
      GIT_CONFIG_SYSTEM: "/etc/gitconfig",
      PATH: "/usr/bin",
    });
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    // Unrelated keys must pass through — this replaces the env, it does not
    // scrub it, and the fixtures depend on PATH/HOME surviving.
    assert.equal(env.PATH, "/usr/bin");
  });

  it("does not mutate the env it was handed", () => {
    const base = { GIT_CONFIG_GLOBAL: "/home/dev/.gitconfig" };
    hermeticGitEnv(base);
    assert.equal(base.GIT_CONFIG_GLOBAL, "/home/dev/.gitconfig");
  });
});

describe("fixture git repos ignore the operator's global git config", () => {
  it("initGitRepo commits even when a global pre-commit hook rejects", async () => {
    const { configPath, markerPath } = writeHostileGlobalConfig();
    const repoPath = makeTempDir("iss5836-init-git-repo-");

    await withHostileGlobalGitConfig(configPath, async () => {
      // Against unmodified `main` this REJECTS: the global hook runs, exits 1,
      // and `initGitRepo` throws "Command failed: /bin/sh -c git init ...".
      await initGitRepo(repoPath);
    });

    assert.equal(
      existsSync(markerPath),
      false,
      "the operator's global pre-commit hook must not run inside a fixture"
    );
    // The commit really happened, so this is not green merely because the hook
    // was skipped along with the work.
    assert.equal(readRepoBranch(repoPath), "main");
    assert.ok(existsSync(join(repoPath, "README.md")));
  });

  it("initGitRepo --allow-empty is hermetic on the same hook path", async () => {
    const { configPath, markerPath } = writeHostileGlobalConfig();
    const repoPath = makeTempDir("iss5836-init-git-repo-empty-");

    // The `allowEmpty` arm is a DIFFERENT shell command string, so it needs its
    // own coverage: a fix applied to only one branch would leave this red.
    await withHostileGlobalGitConfig(configPath, async () => {
      await initGitRepo(repoPath, { allowEmpty: true });
    });

    assert.equal(existsSync(markerPath), false);
    assert.equal(readRepoBranch(repoPath), "main");
  });

  it("initGitRepoWithOrigin ignores a global init.defaultBranch", async () => {
    const { configPath } = writeHostileGlobalConfig();
    const repoPath = makeTempDir("iss5836-init-git-origin-");

    await withHostileGlobalGitConfig(configPath, () => {
      // `git init` here passes no `-b`, so against unmodified `main` the branch
      // is whatever the operator configured globally — repo state the
      // attribution suites then assert against, decided by machine config.
      initGitRepoWithOrigin(repoPath, "acme/widgets");
    });

    assert.notEqual(readRepoBranch(repoPath), HOSTILE_DEFAULT_BRANCH);
  });

  it("createRepoWithOrigin clones, commits and pushes under a rejecting global pre-commit hook", async () => {
    const { configPath, markerPath } = writeHostileGlobalConfig();
    const root = makeTempDir("iss5836-create-repo-origin-");

    // The third shared fixture entry point, and the only one that reaches
    // `clone`/`commit`/`push` in one chain. Against unmodified `main` this
    // REJECTS at the commit: the operator's hook runs, records itself, exits 1,
    // and `runGitFixture` throws before an origin ref ever exists.
    const created = await withHostileGlobalGitConfig(configPath, () =>
      createRepoWithOrigin(root, "widgets")
    );

    assert.equal(
      existsSync(markerPath),
      false,
      "the operator's global pre-commit hook must not run inside a fixture"
    );
    // Resolving `main` in the bare origin needs the whole chain to have run, so
    // this cannot be green because the work was skipped along with the hook.
    // It also exercises `remoteBranchSha`, the helper the worktree suites read
    // their expected shas through.
    assert.match(
      await remoteBranchSha(created.originPath, "main"),
      SHA_PATTERN
    );
    assert.equal(created.fullName, "org/widgets");
  });
});

/**
 * Run a runner script with a stub `pnpm` first on PATH, and return the git
 * config env that stub was actually handed.
 *
 * Both runners spawn the suite on import and can therefore only be executed,
 * not imported — the same reason `run-node-tests-shard.test.ts` reaches the
 * runner's real argv through a stub. Asserting on the RECORDED child env is the
 * point: a runner that imports `hermeticGitEnv` but forgets to pass it to
 * `spawnSync` still satisfies any import- or source-shaped check.
 *
 * The seeded hostile values prove the runner SETS these rather than merely
 * forwarding what the operator's shell exported — without the fix the stub
 * reads them back verbatim.
 */
function recordChildGitConfigEnv(
  script: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { configGlobal: string; configSystem: string }[] {
  const sandbox = makeTempDir("iss5836-runner-env-");
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir);
  const envFile = join(sandbox, "env.txt");
  // `stdio: "inherit"` on run-node-tests.mjs's spawn, so the stub must not print.
  //
  // APPEND, and return one record PER SPAWN (ISS-4933). run-node-tests.mjs now
  // spawns twice — Vitest for the shim-compatible files, then `tsx --test` for
  // the remainder — and a truncating stub would leave this reading only the
  // second, so hermeticity on the lane carrying 776 of the 900 files would be
  // unasserted while the case still passed.
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM" >> ${JSON.stringify(envFile)}\nexit 0\n`,
    { mode: 0o755 }
  );

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: binDir, ...extraEnv };
  // A leaked GITHUB_STEP_SUMMARY would have the runner append to the real job
  // summary from inside a test.
  Reflect.deleteProperty(env, "GITHUB_STEP_SUMMARY");
  Reflect.deleteProperty(env, "NODE_TEST_SHARD");
  env.GIT_CONFIG_GLOBAL = "/home/dev/.gitconfig";
  env.GIT_CONFIG_SYSTEM = "/etc/gitconfig";

  const result = spawnSync(process.execPath, [script], {
    cwd: desktopDir,
    encoding: "utf8",
    env,
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  });
  // A helper precondition, not a test assertion: a runner that never reached its
  // spawn wrote no env file, and the caller would report a confusing read error
  // instead of the real cause.
  if (result.status !== 0) {
    throw new Error(
      `${script} exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  const lines = readFileSync(envFile, "utf8").split("\n").filter(Boolean);
  const spawns: { configGlobal: string; configSystem: string }[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    spawns.push({ configGlobal: lines[index], configSystem: lines[index + 1] });
  }
  if (spawns.length === 0) {
    throw new Error(`${script} spawned nothing through the stub`);
  }
  return spawns;
}

describe("both documented runners hand the test process a hermetic git env", () => {
  // The fixture builders above cannot cover git spawned by the PRODUCTION code
  // the suite drives (`git worktree add/remove/prune`, `git clone`, `git push`),
  // which inherits the test process env. Verified with an observation-only
  // global `core.hooksPath`: `post-checkout` fired inside production-created
  // worktree dirs and `pre-push` on production pushes. So each runner's env is
  // load-bearing, and neither inherits it from the other — they spawn the suite
  // independently.
  it("run-node-tests.mjs sets both git config variables on EVERY lane it spawns", () => {
    const spawns = recordChildGitConfigEnv(RUNNER_SCRIPT);
    // Both of them (ISS-4933). The production code under test shells out to git
    // identically on either runner, so one hermetic lane and one inherited one
    // is not a partial fix — it is a suite whose result still depends on the
    // operator's `~/.gitconfig`.
    assert.equal(spawns.length, 2, "the runner must spawn both lanes");
    for (const { configGlobal, configSystem } of spawns) {
      assert.equal(configGlobal, HERMETIC_GIT_ENV.GIT_CONFIG_GLOBAL);
      assert.equal(configSystem, HERMETIC_GIT_ENV.GIT_CONFIG_SYSTEM);
    }
  });

  it("stress-node-tests.mjs sets both git config variables on the spawned suite", () => {
    // `STRESS_FILE` routinely points at a git-heavy suite, and the stress runner
    // spawns `tsx --test` itself instead of going through run-node-tests.mjs, so
    // fixing only that one left this documented runner executing the operator's
    // hooks once per iteration. `STRESS_ITERS=1` because one recorded spawn
    // settles it; the default 50 would prove nothing extra.
    //
    // The stub is also what makes the stress runner executable from inside the
    // suite at all — it is what stops the recursion that kept this script in
    // TOOLING_REACH_LEDGER, so that entry is gone and must not come back while
    // this test exists.
    const [{ configGlobal, configSystem }] = recordChildGitConfigEnv(
      STRESS_SCRIPT,
      { STRESS_ITERS: "1" }
    );
    assert.equal(configGlobal, HERMETIC_GIT_ENV.GIT_CONFIG_GLOBAL);
    assert.equal(configSystem, HERMETIC_GIT_ENV.GIT_CONFIG_SYSTEM);
  });
});
