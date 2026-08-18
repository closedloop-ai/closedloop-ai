import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "../src/server/operations/git-gateway-constants.js";
import { registerGitWorktreeRoutes } from "../src/server/operations/git-worktree.js";
import { getResolvedGitPath } from "../src/server/operations/symphony-loop.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const WORKTREE_PATH = "/api/gateway/git/worktree";
const DELETE = "DELETE";
const POST = "POST";
const WORKTREE_PARENT_ENV = "SYMPHONY_WORKTREE_PARENT_DIR";

const { makeTempDir } = createGitOpTempDirs("git-worktree-op-");

const originalParentEnv = process.env[WORKTREE_PARENT_ENV];

afterEach(() => {
  if (originalParentEnv === undefined) {
    Reflect.deleteProperty(process.env, WORKTREE_PARENT_ENV);
  } else {
    process.env[WORKTREE_PARENT_ENV] = originalParentEnv;
  }
});

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function newDispatcher(
  allowed: string,
  fake: FakeProcessManager,
  symphonyDir = allowed
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitWorktreeRoutes(
    dispatcher,
    fake.asProcessManager(),
    () => [allowed],
    () => symphonyDir
  );
  return dispatcher;
}

describe(`registerGitWorktreeRoutes DELETE ${WORKTREE_PATH}`, () => {
  test("builds the worktree remove argv without --force by default", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const fake = new FakeProcessManager([ok("")]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(fake.calls[0].args, ["worktree", "remove", worktree]);
    assert.equal(fake.calls[0].command, getResolvedGitPath());
  });

  test("inserts --force into the argv when force=true", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const fake = new FakeProcessManager([ok("")]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree, force: true }),
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0].args, [
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);
  });

  test("returns 409 hasChanges when git reports uncommitted changes and no force", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const fake = new FakeProcessManager([
      fail("fatal: 'tree' contains modified or untracked files, use --force"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree }),
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.hasChanges, true);
  });

  test("falls back to fs.rm only after confirming the target is a registered worktree", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, "file.txt"), "data");
    // Forced git remove fails, then `worktree list --porcelain` confirms the
    // target IS a registered worktree, so the fs.rm fallback proceeds.
    const fake = new FakeProcessManager([
      fail("not a working tree"),
      ok(`worktree ${worktree}\nHEAD abc123\nbranch refs/heads/feature/x\n`),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree, force: true }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    // The directory was removed by the fs.rm fallback.
    assert.equal(
      await fs
        .stat(worktree)
        .then(() => true)
        .catch(() => false),
      false
    );
  });

  test("does NOT fs.rm a plain directory that is not a registered worktree", async () => {
    const allowed = makeTempDir();
    const plainDir = path.join(allowed, "not-a-worktree");
    await fs.mkdir(plainDir);
    await fs.writeFile(path.join(plainDir, "keep.txt"), "important");
    // Forced git remove fails; `worktree list` does NOT list this path, so the
    // fallback must refuse to recursively delete the directory.
    const fake = new FakeProcessManager([
      fail("not a working tree"),
      ok("worktree /some/other/registered/tree\nHEAD abc123\n"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: plainDir, force: true }),
    });

    assert.equal(response.statusCode, 500);
    // The directory survives — the fallback did not delete a non-worktree.
    assert.equal(
      await fs
        .stat(plainDir)
        .then(() => true)
        .catch(() => false),
      true
    );
  });

  test("does NOT fs.rm when the worktree-list probe itself fails", async () => {
    const allowed = makeTempDir();
    const ordinaryRepo = path.join(allowed, "ordinary-repo");
    await fs.mkdir(ordinaryRepo);
    await fs.writeFile(path.join(ordinaryRepo, "keep.txt"), "important");
    // Forced git remove fails and the probe also fails (e.g. an ordinary repo
    // root, not a linked worktree). The fallback must not delete it.
    const fake = new FakeProcessManager([
      fail("not a working tree"),
      fail("fatal: not a git repository"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: ordinaryRepo, force: true }),
    });

    assert.equal(response.statusCode, 500);
    assert.equal(
      await fs
        .stat(ordinaryRepo)
        .then(() => true)
        .catch(() => false),
      true
    );
  });

  test("succeeds without spawning git when the worktree does not exist", async () => {
    const allowed = makeTempDir();
    const missing = path.join(allowed, "gone");
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: missing }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a missing worktreePath with 400", async () => {
    const allowed = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ force: true }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a disallowed worktree path with 403", async () => {
    const allowed = makeTempDir();
    const outside = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: DELETE,
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: outside }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(fake.calls.length, 0);
  });
});

describe(`registerGitWorktreeRoutes POST ${WORKTREE_PATH} — stale cleanup`, () => {
  test("builds rev-parse + ls-remote argv and removes a worktree with no remote branch", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-42");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    const fake = new FakeProcessManager([
      ok("feature/gone\n"), // rev-parse --abbrev-ref HEAD
      ok(""), // ls-remote → empty (branch gone from origin)
      ok(""), // worktree remove
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.removed, [prDir]);
    assert.deepEqual(response.body.kept, []);
    assert.deepEqual(response.body.errors, []);
    // Runs with `cwd: prDir` and NO `-C`, so ProcessManager's exec-time sandbox
    // gate (which only checks `cwd`) revalidates the path at spawn time.
    assert.deepEqual(fake.calls[0].args, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(fake.calls[0].cwd, prDir);
    assert.deepEqual(fake.calls[1].args, [
      "ls-remote",
      "--heads",
      "origin",
      "feature/gone",
    ]);
    assert.equal(fake.calls[1].cwd, prDir);
    assert.deepEqual(fake.calls[2].args, ["worktree", "remove", prDir]);
    assert.equal(fake.calls[2].cwd, prDir);
    // Resolved via the centralized git resolver and carrying a finite deadline.
    for (const call of fake.calls) {
      assert.equal(call.command, getResolvedGitPath());
      assert.deepEqual(call.options, {
        timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS,
      });
    }
  });

  test("keeps a worktree whose branch still exists on origin", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-7");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    const fake = new FakeProcessManager([
      ok("feature/live\n"),
      ok("abcdef1234\trefs/heads/feature/live\n"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    assert.deepEqual(response.body.kept, [prDir]);
    assert.deepEqual(response.body.removed, []);
    assert.deepEqual(response.body.errors, []);
    // No worktree remove attempted.
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].cwd, prDir);
    assert.equal(fake.calls[1].cwd, prDir);
  });

  test("returns empty result sets when the parent dir does not exist", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "missing-worktrees");
    process.env[WORKTREE_PARENT_ENV] = parent;

    const fake = new FakeProcessManager();
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { removed: [], kept: [], errors: [] });
    assert.equal(fake.calls.length, 0);
  });

  test("only considers directories matching the -pr-<n> suffix", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    await fs.mkdir(path.join(parent, "not-a-pr-dir"), { recursive: true });
    await fs.mkdir(path.join(parent, "widget-pr-99"), { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    // rev-parse ok, ls-remote empty (branch gone), worktree remove ok.
    const fake = new FakeProcessManager([ok("feature/x\n"), ok(""), ok("")]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    // Only the widget-pr-99 dir triggered git calls; not-a-pr-dir was ignored.
    assert.deepEqual(response.body.removed, [
      path.join(parent, "widget-pr-99"),
    ]);
    // The dir now flows through `cwd` rather than a `-C <dir>` arg.
    assert.equal(fake.calls[0].cwd, path.join(parent, "widget-pr-99"));
  });

  test("records a rev-parse failure in errors, not kept", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-13");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    const fake = new FakeProcessManager([fail("fatal: not a git repository")]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    // A cleanup failure must be distinguishable from a live kept worktree.
    assert.deepEqual(response.body.errors, [prDir]);
    assert.deepEqual(response.body.kept, []);
    assert.deepEqual(response.body.removed, []);
  });

  test("records a failed worktree removal in errors, not kept", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-21");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    // rev-parse ok, ls-remote empty (branch gone), but the removal itself fails.
    const fake = new FakeProcessManager([
      ok("feature/gone\n"),
      ok(""),
      fail("fatal: could not remove worktree"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    assert.deepEqual(response.body.errors, [prDir]);
    assert.deepEqual(response.body.removed, []);
    assert.deepEqual(response.body.kept, []);
  });

  test("mixes a kept live worktree with a failed cleanup across two dirs", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const liveDir = path.join(parent, "alpha-pr-1");
    const brokenDir = path.join(parent, "beta-pr-2");
    await fs.mkdir(liveDir, { recursive: true });
    await fs.mkdir(brokenDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;

    // Dirs are processed in readdir order (alpha before beta): alpha stays live
    // (branch on origin), beta's rev-parse fails → errors.
    const fake = new FakeProcessManager([
      ok("feature/live\n"),
      ok("abcdef\trefs/heads/feature/live\n"),
      fail("fatal: not a git repository"),
    ]);
    const dispatcher = newDispatcher(allowed, fake);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: WORKTREE_PATH,
    });

    assert.deepEqual(response.body.kept, [liveDir]);
    assert.deepEqual(response.body.errors, [brokenDir]);
    assert.deepEqual(response.body.removed, []);
  });
});
