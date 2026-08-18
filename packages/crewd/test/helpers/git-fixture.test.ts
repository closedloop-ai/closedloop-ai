/**
 * @file git-fixture.test.ts
 * @description Covers the child-timeout guard on `runGitFixture` (ISS-5403
 * review follow-up). The per-test budget cannot police a synchronous spawn —
 * `execFileSync` holds the worker, so vitest's timer never fires and a wedged
 * `git` outlives the deadline — so the bound has to live on the child. These
 * tests drive a genuinely hanging `git` to prove it does.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_SPAWN_CHILD_TIMEOUT_MS,
  GIT_SPAWN_TEST_TIMEOUT_MS,
  runGitFixture,
} from "./git-fixture.js";

/** A stub `git` on PATH that never exits, standing in for a wedged child. */
function makeHangingGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewd-hanging-git-"));
  const stub = join(dir, "git");
  // `exec` replaces the shell, so SIGTERM reaches the sleep directly and
  // leaves no orphaned grandchild behind.
  writeFileSync(stub, "#!/bin/sh\nexec sleep 600\n", "utf8");
  chmodSync(stub, 0o755);
  return dir;
}

/**
 * A global git config whose `core.hooksPath` runs a marker-writing
 * `pre-commit` hook — the ISS-5403 root cause in miniature.
 */
function makeHookedGitConfig(): { configPath: string; markerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "crewd-hooked-config-"));
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir);
  const markerPath = join(dir, "hook-ran");
  const hook = join(hooksDir, "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch "${markerPath}"\n`, "utf8");
  chmodSync(hook, 0o755);
  const configPath = join(dir, "gitconfig");
  writeFileSync(configPath, `[core]\n\thooksPath = ${hooksDir}\n`, "utf8");
  return { configPath, markerPath };
}

describe("runGitFixture", () => {
  it("kills a wedged git child and throws an error naming the command", () => {
    const fakeGitDir = makeHangingGitDir();
    const repoDir = mkdtempSync(join(tmpdir(), "crewd-wedged-repo-"));

    // A short timeout keeps the test fast; the mechanism under test is the
    // child bound itself, not the production constant's magnitude.
    expect(() =>
      runGitFixture(repoDir, ["status"], {
        env: { PATH: `${fakeGitDir}:${process.env.PATH ?? ""}` },
        timeoutMs: 250,
      })
    ).toThrow("timed out after 250ms");
  });

  it("names the git subcommand and cwd so a wedge is attributable", () => {
    const fakeGitDir = makeHangingGitDir();
    const repoDir = mkdtempSync(join(tmpdir(), "crewd-wedged-named-"));

    // Raw, execFileSync reports only `spawnSync git ETIMEDOUT`, which names
    // neither the subcommand nor the fixture repo.
    try {
      runGitFixture(repoDir, ["worktree", "add", "--detach"], {
        env: { PATH: `${fakeGitDir}:${process.env.PATH ?? ""}` },
        timeoutMs: 250,
      });
      expect.unreachable("wedged git should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("git worktree add --detach");
      expect(message).toContain(repoDir);
      expect(message).toContain("SIGTERM");
    }
  });

  it("surfaces exit code and stderr for an ordinary git failure", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "crewd-nonrepo-"));

    // Not a git repo, so this exits non-zero rather than timing out — the
    // other branch of the failure description.
    try {
      runGitFixture(repoDir, ["rev-parse", "--verify", "HEAD"]);
      expect.unreachable("git rev-parse outside a repo should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Both halves matter: the rendered exit code proves `status` handling
      // still resolves a real number rather than the "unknown" fallback, and
      // git's own stderr proves `stdio: "pipe"` plus the tail concatenation
      // still carry it onto the message.
      expect(message).toContain("exit 128");
      expect(message).toContain("not a git repository");
      expect(message).not.toContain("timed out");
    }
  });

  it(
    "applies the default child timeout when the caller passes none",
    () => {
      const fakeGitDir = makeHangingGitDir();
      const repoDir = mkdtempSync(join(tmpdir(), "crewd-default-timeout-"));

      // No `timeoutMs` — the shape every real call site uses, so the default
      // is the only thing standing between a wedged git and an unbounded
      // spawn. Costs ~10s of real time by construction, hence the explicit
      // per-test budget.
      expect(() =>
        runGitFixture(repoDir, ["status"], {
          env: { PATH: `${fakeGitDir}:${process.env.PATH ?? ""}` },
        })
      ).toThrow(`timed out after ${GIT_SPAWN_CHILD_TIMEOUT_MS}ms`);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "stays hermetic, so an operator's global git hook never runs",
    () => {
      const { configPath, markerPath } = makeHookedGitConfig();
      const repoDir = mkdtempSync(join(tmpdir(), "crewd-hermetic-repo-"));

      // Leaked the way a call site would leak it, through `opts.env`.
      // Hermetic has to win over both `process.env` and the caller, or the
      // fixture takes a dependency on machine state it never meant to.
      const run = (args: string[]) =>
        runGitFixture(repoDir, args, {
          env: { GIT_CONFIG_GLOBAL: configPath },
        });
      run(["init", "-q", "-b", "main"]);
      run(["config", "user.email", "t@t.test"]);
      run(["config", "user.name", "T"]);
      writeFileSync(join(repoDir, "base.txt"), "base\n", "utf8");
      run(["add", "-A"]);
      run(["commit", "-q", "-m", "base"]);

      expect(existsSync(markerPath)).toBe(false);
    },
    // Six spawns; measured 5290ms on a loaded machine, i.e. past the 5000ms
    // default — the same criterion the sibling slow cases apply.
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it("bounds the child well below the per-test budget", () => {
    // The whole point of the child bound: it must fire first, leaving vitest
    // room to attribute the failure to the named test.
    expect(GIT_SPAWN_CHILD_TIMEOUT_MS).toBeLessThan(GIT_SPAWN_TEST_TIMEOUT_MS);
  });
});
