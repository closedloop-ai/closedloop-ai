/**
 * ISS-6132 — gateway operations must not block the Electron main thread.
 *
 * The desktop gateway's HTTP server is constructed inside the Electron main
 * process, so a gateway operation handler runs on the main thread. Before this
 * change the loop worktree checkout issued `git fetch origin` and
 * `git worktree add` through `execSync`, which holds the event loop for the
 * child's entire lifetime — every window, all IPC, the menu and the tray freeze.
 *
 * The regression assertions below are deliberately NOT wall-clock bounds
 * (AGENTS.md → Testing bans those). They are happens-before orderings enforced
 * by a release handshake: the fake `git` for the first call blocks until the
 * test's event loop observes it and releases it. If the git call runs
 * synchronously the observer can never run, so the ordering inverts and the
 * fake bails out on its own deadline instead of hanging the suite.
 *
 * Only entry points where the handshake was verified to actually discriminate —
 * i.e. the assertion was observed to fail against a restored `execFileSync`
 * implementation — carry an ordering assertion here. `removeWorktree`'s did not
 * (it passed in both states, which is false confidence), so its non-blocking
 * property is held by the AST guard in
 * `loop-worktree-git-no-sync-child-process.test.ts` instead.
 *
 * `FAKE_GIT_BAIL_OUT_SECONDS` is the flake margin: the correct implementation
 * only has to let a 10ms poll run once inside that window, so 15s absorbs a lot
 * of CI jitter, while a blocking implementation cannot let it run at all.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import {
  activeRepoRefLockCount,
  activeWorktreeLockCount,
  branchExistsAsync,
  createWorktreeCheckout,
  removeWorktree,
  replaceWorktreeCheckout,
  runGit,
  withRepoRefLock,
} from "../src/server/operations/loop-worktree-git.js";
import {
  configureBinaryPathsResolver,
  defaultWorktreeProvider,
} from "../src/server/operations/symphony-loop.js";

/** Ceiling for the whole handshake, so a regression fails instead of hanging. */
const HANDSHAKE_TEST_TIMEOUT_MS = 30_000;
/** The fake git's own bail-out, comfortably inside the test timeout. */
const FAKE_GIT_BAIL_OUT_SECONDS = 15;
/** Poll cadence for the observer that proves the event loop is still turning. */
const OBSERVER_POLL_MS = 10;

const OBSERVED = "observed-git-running";
const RESOLVED = "checkout-resolved";
/** The stderr the failing fake git emits, surfaced through the thrown error. */
const FAKE_GIT_REFUSAL_PATTERN = /fake git refused/;
/** The guard rejecting a ref git would parse as an option. */
const OPTION_LIKE_REF_PATTERN = /Ref starts with dash/;

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * Write a fake `git` that, for the command named by `blockOn`, announces itself
 * via a sentinel file and then waits for a release file before exiting. Every
 * other git command returns immediately with `exitCode`.
 */
async function writeHandshakeGit(options: {
  dir: string;
  blockOn: string;
  startedFile: string;
  releaseFile: string;
}): Promise<string> {
  const gitPath = path.join(options.dir, "fake-git");
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "${options.blockOn}" ]; then`,
    `  : > "${options.startedFile}"`,
    "  i=0",
    `  while [ ! -f "${options.releaseFile}" ]; do`,
    "    i=$((i + 1))",
    `    if [ "$i" -gt "${FAKE_GIT_BAIL_OUT_SECONDS * 10}" ]; then break; fi`,
    "    sleep 0.1",
    "  done",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  await fs.writeFile(gitPath, script, { mode: 0o755 });
  return gitPath;
}

/** Write a fake `git` that exits with `exitCode` for the named command. */
async function writeFailingGit(options: {
  dir: string;
  failOn: string;
  name: string;
}): Promise<string> {
  const gitPath = path.join(options.dir, options.name);
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "${options.failOn}" ]; then`,
    '  echo "fake git refused $*" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  await fs.writeFile(gitPath, script, { mode: 0o755 });
  return gitPath;
}

/**
 * Poll for `startedFile`; once seen, record the observation and release the
 * child. The poll only advances while the event loop is free to turn.
 */
function startReleaseObserver(options: {
  startedFile: string;
  releaseFile: string;
  order: string[];
}): { stop: () => void } {
  const poll = async (): Promise<void> => {
    try {
      await fs.access(options.startedFile);
    } catch {
      return;
    }
    if (!options.order.includes(OBSERVED)) {
      options.order.push(OBSERVED);
      await fs.writeFile(options.releaseFile, "");
    }
  };
  const timer = setInterval(() => {
    poll().catch(() => {
      // The child bails out on its own deadline if the release never lands.
    });
  }, OBSERVER_POLL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

afterEach(() => {
  configureBinaryPathsResolver(null);
});

after(async () => {
  await Promise.all(
    tempRoots.map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("ISS-6132 loop worktree git stays off the main thread", () => {
  test("createWorktreeCheckout lets the event loop turn while git runs", {
    timeout: HANDSHAKE_TEST_TIMEOUT_MS,
  }, async () => {
    const root = await makeTempRoot("iss6132-checkout-");
    const startedFile = path.join(root, "git-started");
    const releaseFile = path.join(root, "git-release");
    const gitBin = await writeHandshakeGit({
      dir: root,
      blockOn: "fetch",
      startedFile,
      releaseFile,
    });

    const order: string[] = [];
    const observer = startReleaseObserver({
      startedFile,
      releaseFile,
      order,
    });
    try {
      const created = await createWorktreeCheckout({
        gitBin,
        repoPath: root,
        worktreeDir: path.join(root, "worktrees", "loop"),
        branchName: "symphony/prd-abc",
        baseBranch: "main",
      });
      order.push(RESOLVED);
      assert.equal(created, true);
    } finally {
      observer.stop();
    }

    // With `execSync` the observer could not have run at all before the
    // checkout resolved, so this ordering is the whole regression.
    assert.deepEqual(order, [OBSERVED, RESOLVED]);
  });

  test("the production worktree provider inherits the non-blocking path", {
    timeout: HANDSHAKE_TEST_TIMEOUT_MS,
  }, async () => {
    const root = await makeTempRoot("iss6132-provider-");
    const startedFile = path.join(root, "git-started");
    const releaseFile = path.join(root, "git-release");
    const gitBin = await writeHandshakeGit({
      dir: root,
      blockOn: "fetch",
      startedFile,
      releaseFile,
    });
    // Drive the real gateway seam: `defaultWorktreeProvider.ensureWorktree` is
    // what `setupPrdWorktree` (the Generate PRD path) calls.
    configureBinaryPathsResolver(() => ({ git: gitBin }));

    const order: string[] = [];
    const observer = startReleaseObserver({
      startedFile,
      releaseFile,
      order,
    });
    try {
      await defaultWorktreeProvider.ensureWorktree(
        root,
        path.join(root, "worktrees", "loop"),
        "symphony/prd-abc",
        "main",
        "11111111-2222-3333-4444-555555555555"
      );
      order.push(RESOLVED);
    } finally {
      observer.stop();
    }

    assert.deepEqual(order, [OBSERVED, RESOLVED]);
  });
});

describe("ISS-6132 loop worktree git preserves operation semantics", () => {
  test("createWorktreeCheckout is a no-op when the worktree already exists", async () => {
    const root = await makeTempRoot("iss6132-exists-");
    const worktreeDir = path.join(root, "worktrees", "loop");
    await fs.mkdir(worktreeDir, { recursive: true });
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "fetch",
      name: "never-called-git",
    });

    const created = await createWorktreeCheckout({
      gitBin,
      repoPath: root,
      worktreeDir,
      branchName: "symphony/prd-abc",
      baseBranch: "main",
    });

    assert.equal(created, false);
  });

  test("createWorktreeCheckout throws when git worktree add fails", async () => {
    const root = await makeTempRoot("iss6132-addfail-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "worktree",
      name: "add-fails-git",
    });

    await assert.rejects(
      createWorktreeCheckout({
        gitBin,
        repoPath: root,
        worktreeDir: path.join(root, "worktrees", "loop"),
        branchName: "symphony/prd-abc",
        baseBranch: "main",
      }),
      FAKE_GIT_REFUSAL_PATTERN
    );
  });

  test("createWorktreeCheckout survives an unreachable origin", async () => {
    const root = await makeTempRoot("iss6132-offline-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "fetch",
      name: "offline-git",
    });

    const created = await createWorktreeCheckout({
      gitBin,
      repoPath: root,
      worktreeDir: path.join(root, "worktrees", "loop"),
      branchName: "symphony/prd-abc",
      baseBranch: "main",
    });

    assert.equal(created, true);
  });

  test("createWorktreeCheckout falls back to the local base branch", async () => {
    const root = await makeTempRoot("iss6132-local-base-");
    const selectedBaseFile = path.join(root, "selected-base");
    const gitBin = path.join(root, "local-base-git");
    await fs.writeFile(
      gitBin,
      [
        "#!/bin/sh",
        'if [ "$1" = "rev-parse" ] && [ "$3" = "origin/main" ]; then',
        "  exit 1",
        "fi",
        'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
        `  printf '%s' "$6" > "${selectedBaseFile}"`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const created = await createWorktreeCheckout({
      gitBin,
      repoPath: root,
      worktreeDir: path.join(root, "worktrees", "loop"),
      branchName: "symphony/prd-abc",
      baseBranch: "main",
    });

    assert.equal(created, true);
    assert.equal(await fs.readFile(selectedBaseFile, "utf8"), "main");
  });

  test("removeWorktree falls back to fs.rm when git refuses", async () => {
    const root = await makeTempRoot("iss6132-removefail-");
    const worktreeDir = path.join(root, "worktrees", "loop");
    await fs.mkdir(worktreeDir, { recursive: true });
    await fs.writeFile(path.join(worktreeDir, "file.txt"), "x");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "worktree",
      name: "remove-fails-git",
    });

    let fallbackReported = 0;
    await removeWorktree({
      gitBin,
      worktreeDir,
      repoPath: root,
      onRemoveFailed: () => {
        fallbackReported += 1;
      },
    });

    assert.equal(fallbackReported, 1);
    await assert.rejects(fs.access(worktreeDir));
  });

  test("worktree replacement holds one lock through post-create setup", async () => {
    const root = await makeTempRoot("iss6132-serialize-");
    const worktreeDir = path.join(root, "worktrees", "loop");
    await fs.mkdir(worktreeDir, { recursive: true });
    const gitBin = path.join(root, "worktree-git");
    await fs.writeFile(
      gitBin,
      [
        "#!/bin/sh",
        'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
        '  rm -rf "$4"',
        "fi",
        'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
        '  mkdir -p "$5"',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];
    const options = {
      gitBin,
      repoPath: root,
      worktreeDir,
      branchName: "symphony/prd-abc",
      baseBranch: "main",
    };
    const first = replaceWorktreeCheckout({
      ...options,
      afterCreate: async () => {
        order.push("first-entered");
        firstEntered.resolve();
        await releaseFirst.promise;
        order.push("first-released");
      },
    });
    await firstEntered.promise;
    assert.equal(activeWorktreeLockCount(), 1);

    const second = replaceWorktreeCheckout({
      ...options,
      afterCreate: () => {
        order.push("second-entered");
        return Promise.resolve();
      },
    });
    assert.equal(activeWorktreeLockCount(), 1);
    releaseFirst.resolve();

    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(order, [
      "first-entered",
      "first-released",
      "second-entered",
    ]);
  });

  test("worktree replacement skips setup when removal leaves the directory", async () => {
    const root = await makeTempRoot("iss6132-stale-remains-");
    const worktreeDir = path.join(root, "worktrees", "loop");
    await fs.mkdir(worktreeDir, { recursive: true });
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "never-matches",
      name: "no-op-git",
    });
    let afterCreateCalls = 0;

    const created = await replaceWorktreeCheckout({
      gitBin,
      repoPath: root,
      worktreeDir,
      branchName: "symphony/prd-abc",
      baseBranch: "main",
      afterCreate: () => {
        afterCreateCalls += 1;
        return Promise.resolve();
      },
    });

    assert.equal(created, false);
    assert.equal(afterCreateCalls, 0);
    await fs.access(worktreeDir);
  });

  test("the worktree lock map does not retain idle directories", async () => {
    const root = await makeTempRoot("iss6132-lockleak-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "worktree",
      name: "add-fails-git",
    });

    // A REJECTED operation must still release its key, or one failed checkout
    // leaks an entry per worktree directory for the life of the process.
    await assert.rejects(
      createWorktreeCheckout({
        gitBin,
        repoPath: root,
        worktreeDir: path.join(root, "worktrees", "loop"),
        branchName: "symphony/prd-abc",
        baseBranch: "main",
      })
    );

    assert.equal(activeWorktreeLockCount(), 0);
  });

  test("branchExistsAsync prefers the remote ref and falls back to false", async () => {
    const root = await makeTempRoot("iss6132-refs-");
    const okGit = await writeFailingGit({
      dir: root,
      failOn: "never-matches",
      name: "ok-git",
    });
    const failGit = await writeFailingGit({
      dir: root,
      failOn: "rev-parse",
      name: "revparse-fails-git",
    });

    assert.equal(await branchExistsAsync(okGit, root, "main"), true);
    assert.equal(await branchExistsAsync(failGit, root, "main"), false);
  });

  test("runGit reports failure instead of throwing", async () => {
    const root = await makeTempRoot("iss6132-rungit-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "status",
      name: "status-fails-git",
    });

    const failed = await runGit(gitBin, ["status"], root, 10_000);
    assert.equal(failed.ok, false);

    const succeeded = await runGit(gitBin, ["rev-parse"], root, 10_000);
    assert.equal(succeeded.ok, true);
  });

  test("runGit bounds a git process that never exits", async () => {
    const root = await makeTempRoot("iss6132-timeout-");
    // A `git` that never returns is the real-world trigger for this class of
    // freeze (an interactive credential prompt on fetch). The timeout must cap
    // it and report failure rather than hang.
    const gitBin = await writeHandshakeGit({
      dir: root,
      blockOn: "fetch",
      startedFile: path.join(root, "git-started"),
      releaseFile: path.join(root, "never-written"),
    });

    const result = await runGit(gitBin, ["fetch", "origin"], root, 500);

    assert.equal(result.ok, false);
  });

  test("createWorktreeCheckout rejects an option-like ref", async () => {
    const root = await makeTempRoot("iss6132-dashref-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "never-matches",
      name: "ok-git",
    });

    await assert.rejects(
      createWorktreeCheckout({
        gitBin,
        repoPath: root,
        worktreeDir: path.join(root, "worktrees", "loop"),
        branchName: "symphony/prd-abc",
        baseBranch: "--force",
      }),
      OPTION_LIKE_REF_PATTERN
    );
  });

  test("branchExistsAsync treats an option-like branch as unresolvable", async () => {
    const root = await makeTempRoot("iss6132-dashbranch-");
    const gitBin = await writeFailingGit({
      dir: root,
      failOn: "never-matches",
      name: "ok-git",
    });

    // The permissive git would answer "yes" to any rev-parse, so a null here can
    // only come from the guard.
    assert.equal(
      await branchExistsAsync(gitBin, root, "--upload-pack=x"),
      false
    );
  });

  test("repo-ref locks canonicalize paths and preserve cross-repo concurrency", async () => {
    const root = await makeTempRoot("iss6132-repolocks-");
    const otherRoot = await makeTempRoot("iss6132-repolocks-other-");
    const releaseFirst = deferred();
    const firstEntered = deferred();
    const otherEntered = deferred();
    const order: string[] = [];

    const first = withRepoRefLock(root, async () => {
      order.push("first-entered");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-released");
    });
    await firstEntered.promise;

    const sameRepo = withRepoRefLock(path.join(root, "."), () => {
      order.push("same-repo-entered");
      return Promise.resolve();
    });
    const otherRepo = withRepoRefLock(otherRoot, () => {
      order.push("other-repo-entered");
      otherEntered.resolve();
      return Promise.resolve();
    });
    assert.equal(activeRepoRefLockCount(), 2);
    await otherEntered.promise;
    assert.deepEqual(order, ["first-entered", "other-repo-entered"]);

    releaseFirst.resolve();
    await Promise.all([first, sameRepo, otherRepo]);
    assert.deepEqual(order, [
      "first-entered",
      "other-repo-entered",
      "first-released",
      "same-repo-entered",
    ]);
    assert.equal(activeRepoRefLockCount(), 0);
  });
});

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("ISS-6132 the production worktree provider preserves branchExists", () => {
  test("branchExists composes the async fetch and ref probe", async () => {
    const root = await makeTempRoot("iss6132-branchexists-");
    const okGit = await writeFailingGit({
      dir: root,
      failOn: "never-matches",
      name: "ok-git",
    });
    configureBinaryPathsResolver(() => ({ git: okGit }));
    assert.equal(
      await defaultWorktreeProvider.branchExists(root, "main"),
      true
    );

    const failGit = await writeFailingGit({
      dir: root,
      failOn: "rev-parse",
      name: "revparse-fails-git",
    });
    configureBinaryPathsResolver(() => ({ git: failGit }));
    assert.equal(
      await defaultWorktreeProvider.branchExists(root, "main"),
      false
    );
  });

  test("branchExists lets the event loop turn while git runs", {
    timeout: HANDSHAKE_TEST_TIMEOUT_MS,
  }, async () => {
    const root = await makeTempRoot("iss6132-branchexists-async-");
    const startedFile = path.join(root, "git-started");
    const releaseFile = path.join(root, "git-release");
    const gitBin = await writeHandshakeGit({
      dir: root,
      blockOn: "fetch",
      startedFile,
      releaseFile,
    });
    configureBinaryPathsResolver(() => ({ git: gitBin }));

    const order: string[] = [];
    const observer = startReleaseObserver({
      startedFile,
      releaseFile,
      order,
    });
    try {
      await defaultWorktreeProvider.branchExists(root, "main");
      order.push(RESOLVED);
    } finally {
      observer.stop();
    }

    assert.deepEqual(order, [OBSERVED, RESOLVED]);
  });
});
