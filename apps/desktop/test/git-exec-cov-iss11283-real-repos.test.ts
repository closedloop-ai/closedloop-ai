/**
 * @file git-exec-cov-iss11283-real-repos.test.ts
 * @description ISS-11283 lane F — branch coverage for `git-exec.ts` against
 * REAL local git repositories. Every existing importer (`repo-identity.ts`,
 * `historical-backfill.ts`) mocks this module in its own suite
 * (`historical-backfill-coverage.test.ts`), so none of `gitExec`'s own
 * subprocess-outcome branches, `getRemoteUrl`/`listRemotes`/`getAbsoluteGitDir`/
 * `getAbsoluteGitCommonDir`/`getDefaultBranch`'s success paths, or
 * `normalizeRepoFullName`'s no-slash-path branch were exercised against a real
 * `git` process before this file.
 *
 * Every repo here is a throwaway local temp directory; no network remote is
 * ever configured (`git remote add` points at a local sibling path only).
 * Fixture repos are BUILT through `runGitFixture`, which hands each of its
 * spawns the hermetic git env itself, and each repo gets its own
 * `user.name`/`user.email`. The code under test spawns git with
 * `process.env`, so its own calls are only as hermetic as the runner's env.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  getAbsoluteGitCommonDir,
  getAbsoluteGitDir,
  getDefaultBranch,
  getRemoteUrl,
  gitExec,
  listRemotes,
  normalizeRepoFullName,
} from "../src/main/enrichment/git-exec.js";
import { runGitFixture } from "./helpers/git-fixture.js";

const GIT_PATH = "git";
const CEILING_ENV_KEY = "GIT_CEILING_DIRECTORIES";

const tempDirs: string[] = [];
const ceilingWasSet = Object.hasOwn(process.env, CEILING_ENV_KEY);
const originalCeiling = process.env[CEILING_ENV_KEY];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (ceilingWasSet) {
    process.env[CEILING_ENV_KEY] = originalCeiling;
  } else {
    Reflect.deleteProperty(process.env, CEILING_ENV_KEY);
  }
});

/**
 * Realpath'd so a path git reports back (it resolves symlinks) compares equal
 * on hosts whose tmpdir is a symlink, e.g. macOS `/var` → `/private/var`.
 */
function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/**
 * A temp dir git must treat as outside any repository, even when the host's
 * tmpdir itself sits inside a git work tree. The code under test spawns git
 * with `process.env`, so the ceiling is set there (restored in `afterEach`):
 * git's upward discovery then stops at the dir's parent.
 */
function makeNonRepoDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  process.env[CEILING_ENV_KEY] = path.dirname(dir);
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  await runGitFixture(["init", "--quiet"], dir);
  await runGitFixture(["config", "user.name", "ISS-11283 Test"], dir);
  await runGitFixture(
    ["config", "user.email", "iss11283-test@example.com"],
    dir
  );
}

async function commitFile(dir: string, name: string): Promise<void> {
  writeFileSync(path.join(dir, name), "content\n");
  await runGitFixture(["add", name], dir);
  await runGitFixture(["commit", "--quiet", "-m", `add ${name}`], dir);
}

async function headSha(dir: string): Promise<string> {
  const { stdout } = await runGitFixture(["rev-parse", "HEAD"], dir);
  return stdout.trim();
}

describe("gitExec subprocess-outcome branches", () => {
  test("rethrows a failure that carries neither a numeric exit code nor stdout (an argument containing a NUL byte)", async () => {
    // Node refuses to spawn at all when an argument contains a NUL byte, so
    // the error reaches gitExec's catch with a string `code` and no `stdout`.
    const argWithNul = `--version${String.fromCharCode(0)}`;

    await assert.rejects(
      gitExec(GIT_PATH, [argWithNul], makeTempDir("git-exec-cov-nul-arg-")),
      (error: unknown) =>
        error instanceof TypeError &&
        (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE"
    );
  });

  test("maps a spawn failure (nonexistent binary) to a non-number exit code fallback of 1", async () => {
    const result = await gitExec(
      "/nonexistent/git-binary-for-iss11283",
      ["--version"],
      makeTempDir("git-exec-cov-spawn-fail-")
    );

    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 1 });
  });
});

describe("normalizeRepoFullName", () => {
  test("returns null for a github.com URL with no owner/repo path segment", () => {
    assert.equal(normalizeRepoFullName("https://github.com/onlyowner"), null);
  });
});

describe("getRemoteUrl and listRemotes against a real repo", () => {
  test("getRemoteUrl returns the configured remote URL trimmed", async () => {
    const dir = makeTempDir("git-exec-cov-remote-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");
    const remoteTarget = makeTempDir("git-exec-cov-remote-target-");
    await runGitFixture(["remote", "add", "origin", remoteTarget], dir);

    const url = await getRemoteUrl(GIT_PATH, dir);

    assert.equal(url, remoteTarget);
  });

  test("getRemoteUrl returns null when the named remote does not exist", async () => {
    const dir = makeTempDir("git-exec-cov-no-remote-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");

    const url = await getRemoteUrl(GIT_PATH, dir);

    assert.equal(url, null);
  });

  test("listRemotes returns [] for a directory that is not a git repository", async () => {
    const dir = makeNonRepoDir("git-exec-cov-not-a-repo-");

    const remotes = await listRemotes(GIT_PATH, dir);

    assert.deepEqual(remotes, []);
  });

  test("listRemotes lists a configured remote and de-duplicates a second URL under the same name", async () => {
    const dir = makeTempDir("git-exec-cov-dup-remote-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");
    const firstUrl = makeTempDir("git-exec-cov-dup-remote-url1-");
    const secondUrl = makeTempDir("git-exec-cov-dup-remote-url2-");
    await runGitFixture(["remote", "add", "origin", firstUrl], dir);
    // A second `url` value under the SAME remote name produces a second
    // "origin ... (fetch)" line in `git remote -v`, exercising the
    // de-duplication branch rather than a second, differently-named remote.
    await runGitFixture(
      ["config", "--add", "remote.origin.url", secondUrl],
      dir
    );

    const remotes = await listRemotes(GIT_PATH, dir);

    assert.deepEqual(remotes, [{ name: "origin", url: firstUrl }]);
  });
});

describe("getAbsoluteGitDir and getAbsoluteGitCommonDir", () => {
  test("return the real .git directory for a git repository", async () => {
    const dir = makeTempDir("git-exec-cov-gitdir-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");

    const gitDir = await getAbsoluteGitDir(GIT_PATH, dir);
    const commonDir = await getAbsoluteGitCommonDir(GIT_PATH, dir);

    assert.equal(gitDir, path.join(dir, ".git"));
    assert.equal(commonDir, path.join(dir, ".git"));
  });

  test("return null for a directory that is not a git repository", async () => {
    const dir = makeNonRepoDir("git-exec-cov-gitdir-none-");

    assert.equal(await getAbsoluteGitDir(GIT_PATH, dir), null);
    assert.equal(await getAbsoluteGitCommonDir(GIT_PATH, dir), null);
  });
});

describe("getDefaultBranch", () => {
  test("prefers the origin/HEAD symbolic ref when it resolves", async () => {
    const dir = makeTempDir("git-exec-cov-default-branch-symref-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");
    const sha = await headSha(dir);
    // Pointed at a branch name that is NEITHER "origin/main" nor
    // "origin/master" — the loop fallback's own candidates — so a mutation
    // that skips the symbolic-ref shortcut cannot coincidentally land on the
    // same "main" answer through the fallback path.
    await runGitFixture(["update-ref", "refs/remotes/origin/trunk", sha], dir);
    await runGitFixture(
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
      dir
    );

    const branch = await getDefaultBranch(GIT_PATH, dir);

    assert.equal(branch, "trunk");
  });

  test("falls back to a matching origin/master ref when origin/main does not exist", async () => {
    const dir = makeTempDir("git-exec-cov-default-branch-fallback-");
    await initRepo(dir);
    await commitFile(dir, "a.txt");
    const sha = await headSha(dir);
    // Only "origin/master" exists, so the loop must genuinely try and reject
    // "origin/main" first — a mutation that short-circuits the loop's exit-code
    // check would wrongly report success on that first candidate instead.
    await runGitFixture(["update-ref", "refs/remotes/origin/master", sha], dir);
    // The LOCAL checked-out branch is deliberately renamed away from "master":
    // hermetic `git init` defaults to a local "master" branch too, so a
    // mutation that skips the loop and falls through to the final
    // `rev-parse --abbrev-ref HEAD` step would coincidentally answer "master"
    // as well. Renaming makes that fallthrough observably wrong.
    await runGitFixture(
      ["branch", "-m", "local-branch-name-is-not-the-default"],
      dir
    );

    const branch = await getDefaultBranch(GIT_PATH, dir);

    assert.equal(branch, "master");
  });

  test("falls back to the literal 'main' when nothing resolves at all", async () => {
    const dir = makeNonRepoDir("git-exec-cov-default-branch-none-");

    const branch = await getDefaultBranch(GIT_PATH, dir);

    assert.equal(branch, "main");
  });
});
