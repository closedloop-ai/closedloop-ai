import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitBranchesRoutes } from "../src/server/operations/git-branches.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "../src/server/operations/git-gateway-constants.js";
import { getResolvedGitPath } from "../src/server/operations/symphony-loop.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const BRANCHES_PATH = "/api/gateway/git/branches";
const GET = "GET";

const { makeTempDir } = createGitOpTempDirs("git-branches-op-");

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "boom"): ExecResult {
  return { stdout: "", stderr, exitCode: 1 };
}

async function dispatchBranches(
  repoPath: string,
  fake: FakeProcessManager
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = new OperationDispatcher();
  registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
    repoPath,
  ]);
  return await dispatchOperation({
    dispatcher,
    method: GET,
    pathname: BRANCHES_PATH,
    query: { repo: repoPath },
  });
}

describe(`registerGitBranchesRoutes GET ${BRANCHES_PATH}`, () => {
  test("builds the git argv for default-branch, worktree, and branch reads", async () => {
    const repoPath = makeTempDir();
    // symbolic-ref, worktree list, branch -a
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(""),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      fake.calls.map((call) => call.args),
      [
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        ["worktree", "list", "--porcelain"],
        [
          "branch",
          "-a",
          "--format=%(refname:short)|%(committerdate:iso-strict)",
        ],
      ]
    );
    for (const call of fake.calls) {
      // Resolved via the centralized git resolver, not ambient bare `git`, and
      // carrying a finite exec deadline.
      assert.equal(call.command, getResolvedGitPath());
      assert.equal(call.cwd, repoPath);
      assert.deepEqual(call.options, {
        timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS,
      });
    }
  });

  test("parses origin/HEAD symbolic-ref into the default branch", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/develop\n"),
      ok(""),
      ok(""),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.body.defaultBranch, "develop");
  });

  test("falls back to branch --show-current when origin/HEAD is missing", async () => {
    const repoPath = makeTempDir();
    // symbolic-ref fails (no origin/HEAD), then branch --show-current, worktree, branch -a
    const fake = new FakeProcessManager([
      fail("no origin HEAD"),
      ok("feature/x\n"),
      ok(""),
      ok(""),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.body.defaultBranch, "feature/x");
    assert.deepEqual(fake.calls[1].args, ["branch", "--show-current"]);
  });

  test("defaults to main when neither symbolic-ref nor current branch resolve", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([fail(), ok("\n"), ok(""), ok("")]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.body.defaultBranch, "main");
  });

  test("parses worktree porcelain blocks and extracts ticket ids", async () => {
    const repoPath = makeTempDir();
    // Basename carries a ticket id → basename wins over the branch.
    const worktreeA = path.join(repoPath, "widget-ABC-123");
    // Basename has no ticket → id is derived from the branch instead.
    const worktreeB = path.join(repoPath, "plain-tree");
    // Neither basename nor branch carries a ticket → null.
    const worktreeC = path.join(repoPath, "scratch");
    const porcelain = [
      `worktree ${repoPath}`,
      "HEAD deadbeef",
      "branch refs/heads/main",
      "",
      `worktree ${worktreeA}`,
      "HEAD cafef00d",
      "branch refs/heads/feature/DEF-456-thing",
      "",
      `worktree ${worktreeB}`,
      "HEAD 00ff00ff",
      "branch refs/heads/feature/GHI-789-thing",
      "",
      `worktree ${worktreeC}`,
      "HEAD 11ee11ee",
      "branch refs/heads/plain",
    ].join("\n");
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(porcelain),
      ok(""),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    // The block whose path equals repoPath itself is skipped.
    assert.deepEqual(response.body.worktrees, [
      { path: worktreeA, branch: "feature/DEF-456-thing", ticketId: "ABC-123" },
      { path: worktreeB, branch: "feature/GHI-789-thing", ticketId: "GHI-789" },
      { path: worktreeC, branch: "plain", ticketId: null },
    ]);
  });

  test("parses branch --format output, dedupes local over remote, and sorts default first", async () => {
    const repoPath = makeTempDir();
    const branchOutput = [
      "main|2026-01-01T00:00:00+00:00",
      "origin/main|2026-01-01T00:00:00+00:00",
      "feature/new|2026-03-01T00:00:00+00:00",
      "feature/old|2026-02-01T00:00:00+00:00",
      "origin/HEAD -> origin/main|",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(branchOutput),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.deepEqual(response.body.branches, [
      {
        name: "main",
        isRemote: false,
        lastCommitDate: "2026-01-01T00:00:00+00:00",
      },
      {
        name: "feature/new",
        isRemote: false,
        lastCommitDate: "2026-03-01T00:00:00+00:00",
      },
      {
        name: "feature/old",
        isRemote: false,
        lastCommitDate: "2026-02-01T00:00:00+00:00",
      },
    ]);
  });

  test("promotes the default branch when git lists it after newer feature branches", async () => {
    const repoPath = makeTempDir();
    const branchOutput = [
      "feature/new|2026-03-01T00:00:00+00:00",
      "feature/old|2026-02-01T00:00:00+00:00",
      "main|2026-01-01T00:00:00+00:00",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(branchOutput),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      (response.body.branches as Array<{ name: string }>).map(
        ({ name }) => name
      ),
      ["main", "feature/new", "feature/old"]
    );
  });

  test("drops only the symbolic HEAD refs, keeping a branch whose name contains HEAD", async () => {
    const repoPath = makeTempDir();
    const branchOutput = [
      "main|2026-01-01T00:00:00+00:00",
      // A real branch whose name merely contains "HEAD" must survive.
      "feature/HEAD-fix|2026-04-01T00:00:00+00:00",
      // The symbolic origin/HEAD pointer and its alias row must be dropped.
      "origin/HEAD -> origin/main|",
      "origin/HEAD|2026-01-01T00:00:00+00:00",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(branchOutput),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.deepEqual(response.body.branches, [
      {
        name: "main",
        isRemote: false,
        lastCommitDate: "2026-01-01T00:00:00+00:00",
      },
      {
        name: "feature/HEAD-fix",
        isRemote: false,
        lastCommitDate: "2026-04-01T00:00:00+00:00",
      },
    ]);
  });

  test("returns empty worktrees and branches when those reads fail", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      fail("worktree failed"),
      fail("branch failed"),
    ]);

    const response = await dispatchBranches(repoPath, fake);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.worktrees, []);
    assert.deepEqual(response.body.branches, []);
  });

  test("rejects a missing repo parameter with 400 before spawning git", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: BRANCHES_PATH,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a repo outside the allowed directories with 403", async () => {
    const allowed = makeTempDir();
    const outside = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      allowed,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: BRANCHES_PATH,
      query: { repo: outside },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(fake.calls.length, 0);
  });

  test("returns 404 when the allowed repo path does not exist", async () => {
    const repoPath = makeTempDir();
    const missing = path.join(repoPath, "does-not-exist");
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: GET,
      pathname: BRANCHES_PATH,
      query: { repo: missing },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(fake.calls.length, 0);
  });
});
