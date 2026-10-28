import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import {
  findWorktreeForBranch,
  resolveRepoFullName,
  resolveRepoFullNameAsync,
} from "../src/server/operations/git-helpers.js";

/**
 * Regression tests for the PR #107 review: user-configurable git path must be
 * safe against paths containing spaces (legitimate, e.g. /Applications/.../git)
 * and against shell metacharacters (malicious, e.g. `/tmp/git;touch pwn`).
 *
 * These would both fail under `execSync(\`${gitPath} …\`)` interpolation.
 */
/** Relative on purpose — see `makeInjectionFixture`. */
const CANARY_NAME = "pwn-canary";

describe("git-helpers: git path override shell safety", () => {
  const tempPathsToClean: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(() => ({}));
    for (const p of tempPathsToClean) {
      rmSync(p, { recursive: true, force: true });
    }
    tempPathsToClean.length = 0;
  });

  test("resolveRepoFullName honors a git binary path containing spaces", () => {
    // A directory name with a space must survive the full spawn pipeline.
    // Shell-string interpolation would split on the space and fail with ENOENT.
    const tmpRoot = path.join(os.tmpdir(), `cl git space ${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    const gitPath = path.join(tmpRoot, "git");
    writeFileSync(
      gitPath,
      '#!/bin/sh\necho "git@github.com:acme/widgets.git"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    configureBinaryPathsResolver(() => ({ git: gitPath }));

    const result = resolveRepoFullName(repoDir);
    assert.equal(result, "acme/widgets");
  });

  test("resolveRepoFullNameAsync honors a git binary path containing spaces", async () => {
    const tmpRoot = path.join(os.tmpdir(), `cl git async ${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    const gitPath = path.join(tmpRoot, "git");
    writeFileSync(
      gitPath,
      '#!/bin/sh\necho "git@github.com:acme/widgets.git"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    configureBinaryPathsResolver(() => ({ git: gitPath }));

    const result = await resolveRepoFullNameAsync(repoDir);
    assert.equal(result, "acme/widgets");
  });

  /**
   * A git override whose path IS the whole metacharacter string, executable at
   * exactly that path (whitlockk).
   *
   * The earlier shape wrote the fake at `<tmp>/git` and handed the resolver
   * `<tmp>/git;touch <canary>`. Nothing is executable at THAT path, so the
   * resolver classified the override invalid and fell back to the host git: the
   * injected first segment never ran, the canary could not appear whatever the
   * spawn did, and the case passed without exercising the injection path at all.
   * Making the full string a real executable removes the vacuity — `execFile`
   * runs it verbatim as one argv[0] and nothing touches the canary, while an
   * `execSync` interpolation would run the first segment and then
   * `touch pwn-canary` in the child's cwd.
   *
   * The canary name is therefore RELATIVE: an absolute one puts a `/` inside the
   * file name, no such file can be created, and that is the constraint that
   * forced the earlier split. A shell would create it in `cwd`, which for these
   * calls is `repoDir`.
   *
   * These cases no longer suspend the ISS-10194 strict refusal. They do not need
   * to — the override is valid now — and keeping the guard on is what makes a
   * fake that failed to install fail loudly here instead of silently handing the
   * probe the host git again.
   */
  function makeInjectionFixture(prefix: string): {
    repoDir: string;
    injectedPath: string;
    ranMarker: string;
    canary: string;
  } {
    const tmpRoot = path.join(os.tmpdir(), `${prefix}${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    const ranMarker = path.join(tmpRoot, "fake-git-ran");
    const injectedPath = path.join(tmpRoot, `git;touch ${CANARY_NAME}`);
    writeFileSync(
      injectedPath,
      `#!/bin/sh\n: > ${JSON.stringify(ranMarker)}\necho "passthrough"\n`,
      { mode: 0o755 }
    );

    return {
      repoDir,
      injectedPath,
      ranMarker,
      canary: path.join(repoDir, CANARY_NAME),
    };
  }

  test("shell metacharacters in the git override cannot inject commands", () => {
    const { repoDir, injectedPath, ranMarker, canary } =
      makeInjectionFixture("cl-git-inject-");
    configureBinaryPathsResolver(() => ({ git: injectedPath }));

    // Don't care about return value -- the point is the canary must not appear.
    resolveRepoFullName(repoDir);

    // The vacuity guard, and the actual shell detector: `execFile` runs the
    // whole metacharacter string as argv[0], so the marker appears. ANY shell
    // splits it at the `;` and the executable at that path never runs.
    assert.equal(
      existsSync(ranMarker),
      true,
      "the metacharacter override never executed -- the canary assertion below would hold vacuously"
    );
    assert.equal(
      existsSync(canary),
      false,
      "canary file exists -- shell injection via git binary path succeeded"
    );
  });

  test("shell metacharacters in the async git override cannot inject commands", async () => {
    const { repoDir, injectedPath, ranMarker, canary } = makeInjectionFixture(
      "cl-git-async-inject-"
    );
    configureBinaryPathsResolver(() => ({ git: injectedPath }));

    await resolveRepoFullNameAsync(repoDir);

    assert.equal(
      existsSync(ranMarker),
      true,
      "the metacharacter override never executed -- the canary assertion below would hold vacuously"
    );
    assert.equal(
      existsSync(canary),
      false,
      "canary file exists -- shell injection via async git binary path succeeded"
    );
  });
});

// Moved out of a generic `gateway-*-coverage` bucket (ISS-9170) so these
// cases sit with the module's own suite.

describe("ISS-9170 — worktree listing and unparseable origin remotes", () => {
  const tempDirsToClean: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(null);
    for (const dir of tempDirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakeGitScript(dir: string, body: string): string {
    const filePath = path.join(dir, "git");
    writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return filePath;
  }

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirsToClean.push(dir);
    return dir;
  }

  const TWO_WORKTREE_PORCELAIN = [
    "cat <<'EOF'",
    "worktree /fake/main-worktree",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /fake/feature-worktree",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature-x",
    "EOF",
  ].join("\n");

  test("git-helpers: findWorktreeForBranch returns the worktree whose branch line matches, not the first one", async () => {
    const dir = makeTempDir("gh-worktree-match-");
    const gitPath = makeFakeGitScript(dir, TWO_WORKTREE_PORCELAIN);
    configureBinaryPathsResolver(() => ({ git: gitPath }));

    assert.equal(
      await findWorktreeForBranch(dir, "feature-x"),
      "/fake/feature-worktree"
    );
  });

  test("git-helpers: findWorktreeForBranch does not match a branch name that is only a suffix of another branch", async () => {
    const dir = makeTempDir("gh-worktree-nomatch-");
    const gitPath = makeFakeGitScript(
      dir,
      [
        "cat <<'EOF'",
        "worktree /fake/other-worktree",
        "HEAD 3333333333333333333333333333333333333333",
        "branch refs/heads/not-main",
        "EOF",
      ].join("\n")
    );
    configureBinaryPathsResolver(() => ({ git: gitPath }));

    assert.equal(await findWorktreeForBranch(dir, "main"), null);
  });

  test("git-helpers: findWorktreeForBranch returns null when the git command fails", async () => {
    const dir = makeTempDir("gh-worktree-fail-");
    const gitPath = makeFakeGitScript(dir, "exit 1");
    configureBinaryPathsResolver(() => ({ git: gitPath }));

    assert.equal(await findWorktreeForBranch(dir, "main"), null);
  });

  test("git-helpers: resolveRepoFullName returns null when the origin remote cannot be parsed into org/repo", () => {
    const dir = makeTempDir("gh-repo-noparse-");
    const gitPath = makeFakeGitScript(dir, 'echo "not-a-parseable-remote"');
    configureBinaryPathsResolver(() => ({ git: gitPath }));

    assert.equal(resolveRepoFullName(dir), null);
  });

  test("git-helpers: resolveRepoFullNameAsync returns null when the origin remote cannot be parsed into org/repo", async () => {
    const dir = makeTempDir("gh-repo-noparse-async-");
    const gitPath = makeFakeGitScript(dir, 'echo "not-a-parseable-remote"');
    configureBinaryPathsResolver(() => ({ git: gitPath }));

    assert.equal(await resolveRepoFullNameAsync(dir), null);
  });
});
