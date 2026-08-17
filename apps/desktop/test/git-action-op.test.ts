import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import {
  GitGatewayErrorCategory,
  GitHookType,
} from "@closedloop-ai/loops-api/friendly-error";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "../src/server/operations/git-gateway-constants.js";
import { getResolvedGitPath } from "../src/server/operations/symphony-loop.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const GIT_PATH = "/api/gateway/git";
const POST = "POST";

const { makeTempDir } = createGitOpTempDirs("git-action-op-");

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

async function dispatchAction(
  repoPath: string,
  fake: FakeProcessManager,
  body: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
    repoPath,
  ]);
  return await dispatchOperation({
    dispatcher,
    method: POST,
    pathname: GIT_PATH,
    body: JSON.stringify({ repoPath, ...body }),
  });
}

function argvOf(fake: FakeProcessManager): string[][] {
  return fake.calls.map((call) => call.args);
}

/**
 * Asserts the full exec record for every recorded call — command (`git`), args,
 * and cwd (the repo path). Pinning `command` and `cwd` catches a regression
 * where the handler stops passing `repoPath`, which would silently run git in
 * the Desktop process directory and still leave arg-only assertions green.
 */
function assertExecRecords(
  fake: FakeProcessManager,
  repoPath: string,
  expectedArgv: string[][]
): void {
  const actual = fake.calls.map((call) => ({
    command: call.command,
    cwd: call.cwd,
    args: call.args,
    options: call.options,
  }));
  const expected = expectedArgv.map((args) => ({
    // The gateway resolves git through the centralized login-shell resolver
    // rather than relying on ambient PATH lookup of a bare `git`.
    command: getResolvedGitPath(),
    cwd: repoPath,
    args,
    // Every gateway git call must carry a finite deadline so a hung child
    // cannot hold the request open indefinitely.
    options: { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS },
  }));
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called from test blocks
  assert.deepEqual(actual, expected);
}

describe(`registerGitActionRoutes POST ${GIT_PATH} — status`, () => {
  test("builds rev-parse + status --porcelain argv and buckets files", async () => {
    const repoPath = makeTempDir();
    // Porcelain output is column-significant (`XY <path>`); the parser reads the
    // untrimmed output so a leading worktree-only entry keeps its columns.
    const porcelain = [
      "MM src/staged-and-modified.ts",
      " M src/modified.ts",
      "A  src/added.ts",
      "?? src/untracked.ts",
      " D src/deleted.ts",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([ok("feature/x\n"), ok(porcelain)]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(argvOf(fake), [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["status", "--porcelain"],
    ]);
    assert.equal(response.body.currentBranch, "feature/x");
    assert.equal(response.body.hasChanges, true);
    assert.deepEqual(response.body.files, {
      modified: ["src/staged-and-modified.ts", "src/modified.ts"],
      created: ["src/added.ts", "src/untracked.ts"],
      deleted: ["src/deleted.ts"],
      // Only entries whose index (X) column is a real staged marker (not a
      // space or "?") land here: the ` M` and ` D` worktree-only changes are
      // excluded, but `MM` and `A ` are staged.
      staged: ["src/staged-and-modified.ts", "src/added.ts"],
    });
  });

  test("keeps the leading worktree column of a lone modified entry (no column shift)", async () => {
    const repoPath = makeTempDir();
    // A single worktree-modified entry. The leading status-column space must be
    // preserved: the entry is worktree-modified (Y column `M`), not staged, and
    // its filename must be reported intact.
    const fake = new FakeProcessManager([
      ok("feature/x\n"),
      ok(" M src/only.ts\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.deepEqual(response.body.files, {
      modified: ["src/only.ts"],
      created: [],
      deleted: [],
      staged: [],
    });
  });

  test("reports the rename destination as staged from a porcelain R entry", async () => {
    const repoPath = makeTempDir();
    // `R  old -> new`: a staged rename. The destination path is reported, and
    // the entry counts as staged (index column `R`).
    const fake = new FakeProcessManager([
      ok("feature/x\n"),
      ok("R  src/old-name.ts -> src/new-name.ts\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.deepEqual(response.body.files, {
      modified: [],
      created: [],
      deleted: [],
      staged: ["src/new-name.ts"],
    });
  });

  test("reports no changes and unknown branch on empty output", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("\n"), ok("")]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.equal(response.body.currentBranch, "unknown");
    assert.equal(response.body.hasChanges, false);
    assert.deepEqual(response.body.files, {
      modified: [],
      created: [],
      deleted: [],
      staged: [],
    });
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — branch`, () => {
  test("checks out an existing branch when git branch --list matches", async () => {
    const repoPath = makeTempDir();
    // branch --list returns a match, then checkout <branch>
    const fake = new FakeProcessManager([ok("  feature/x\n"), ok("")]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch",
      branchName: "feature/x",
    });

    assert.equal(response.statusCode, 200);
    assertExecRecords(fake, repoPath, [
      ["branch", "--list", "feature/x"],
      ["checkout", "feature/x"],
    ]);
    assert.equal(response.body.branchName, "feature/x");
  });

  test("creates a new branch with checkout -b when no match exists", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok(""), ok("")]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch",
      branchName: "feature/x",
    });

    assert.equal(response.statusCode, 200);
    assertExecRecords(fake, repoPath, [
      ["branch", "--list", "feature/x"],
      ["checkout", "-b", "feature/x"],
    ]);
  });

  test("rejects a branch name that reduces to a leading hyphen before any git call", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();

    const response = await dispatchAction(repoPath, fake, {
      action: "branch",
      branchName: "--force",
    });

    // `--force` survives the character sanitizer intact and would be parsed by
    // git as an option (`branch --list --force`, then `checkout --force` which
    // discards local changes). It must be rejected before either git call runs.
    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("sanitizes special characters in the branch name argv", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok(""), ok("")]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch",
      branchName: "feat/foo bar!$(rm)@x",
    });

    const sanitized = "feat/foo-bar---rm--x";
    assert.deepEqual(argvOf(fake), [
      ["branch", "--list", sanitized],
      ["checkout", "-b", sanitized],
    ]);
    assert.equal(response.body.branchName, sanitized);
  });

  test("requires branchName for the branch action", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();

    const response = await dispatchAction(repoPath, fake, { action: "branch" });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — commit`, () => {
  test("stages all then commits and parses the short hash", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""),
      ok("[feature/x 1a2b3c4] my message\n 1 file changed"),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "my message",
    });

    assert.equal(response.statusCode, 200);
    assertExecRecords(fake, repoPath, [
      ["add", "."],
      ["commit", "-m", "my message"],
    ]);
    assert.equal(response.body.commit, "1a2b3c4");
  });

  test("falls back to 'unknown' when the commit hash cannot be parsed", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok(""), ok("nothing to parse here")]);

    const response = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "m",
    });

    assert.equal(response.body.commit, "unknown");
  });

  test("requires a message for the commit action", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();

    const response = await dispatchAction(repoPath, fake, { action: "commit" });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — push / pull`, () => {
  test("push resolves HEAD then pushes with --set-upstream", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("feature/x\n"), ok("")]);

    const response = await dispatchAction(repoPath, fake, { action: "push" });

    assert.equal(response.statusCode, 200);
    assertExecRecords(fake, repoPath, [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["push", "origin", "feature/x", "--set-upstream"],
    ]);
    assert.equal(response.body.pushed, true);
  });

  test("pull resolves HEAD then pulls from origin", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("feature/x\n"), ok("")]);

    const response = await dispatchAction(repoPath, fake, { action: "pull" });

    assert.equal(response.statusCode, 200);
    assertExecRecords(fake, repoPath, [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["pull", "origin", "feature/x"],
    ]);
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — branch-diff`, () => {
  test("diffs against the default base branch and buckets name-status output", async () => {
    const repoPath = makeTempDir();
    const diff = ["M\tsrc/mod.ts", "A\tsrc/new.ts", "D\tsrc/gone.ts", ""].join(
      "\n"
    );
    const fake = new FakeProcessManager([ok("feature/x\n"), ok(diff)]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch-diff",
    });

    assert.deepEqual(argvOf(fake), [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["diff", "--name-status", "origin/main...HEAD"],
    ]);
    assert.equal(response.body.baseBranch, "main");
    assert.deepEqual(response.body.files, {
      modified: ["src/mod.ts"],
      created: ["src/new.ts"],
      deleted: ["src/gone.ts"],
    });
    assert.equal(response.body.totalChanges, 3);
  });

  test("parses tab-delimited name-status paths with spaces and rename/copy destinations", async () => {
    const repoPath = makeTempDir();
    // `--name-status` is TAB-delimited: a path with a space survives, and a
    // rename (`R100\told\tnew`) / copy (`C075\told\tnew`) reports its
    // destination (last field), not the obsolete source.
    const diff = [
      "M\tsrc/my file.ts",
      "R100\tsrc/old.ts\tsrc/renamed.ts",
      "C075\tsrc/base.ts\tsrc/copied.ts",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([ok("feature/x\n"), ok(diff)]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch-diff",
    });

    assert.deepEqual(response.body.files, {
      // A space-bearing path is preserved intact (not split at the space), and
      // renames/copies are modifications reporting the destination path.
      modified: ["src/my file.ts", "src/renamed.ts", "src/copied.ts"],
      created: [],
      deleted: [],
    });
    assert.equal(response.body.totalChanges, 3);
  });

  test("honors an explicit baseBranch in the diff triple-dot argv", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([ok("feature/x\n"), ok("")]);

    const response = await dispatchAction(repoPath, fake, {
      action: "branch-diff",
      baseBranch: "develop",
    });

    assert.deepEqual(fake.calls[1].args, [
      "diff",
      "--name-status",
      "origin/develop...HEAD",
    ]);
    assert.equal(response.body.baseBranch, "develop");
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — sync-status`, () => {
  test("fetches, resolves tracking branch, and parses the left-right counts", async () => {
    const repoPath = makeTempDir();
    // fetch, rev-parse HEAD, branch -r, rev-list --left-right --count
    const fake = new FakeProcessManager([
      ok(""),
      ok("feature/x\n"),
      ok("  origin/main\n  origin/feature/x\n"),
      ok("2\t3\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "sync-status",
    });

    assert.deepEqual(argvOf(fake), [
      ["fetch", "origin"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["branch", "-r"],
      ["rev-list", "--left-right", "--count", "feature/x...origin/main"],
    ]);
    assert.equal(response.body.aheadBy, 2);
    assert.equal(response.body.behindBy, 3);
    assert.equal(response.body.isUpToDate, false);
    assert.equal(response.body.trackingBranch, "origin/main");
  });

  test("prefers origin/master when origin/main is absent", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""),
      ok("feature/x\n"),
      ok("  origin/master\n"),
      ok("0\t0\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "sync-status",
    });

    assert.equal(response.body.trackingBranch, "origin/master");
    assert.equal(response.body.isUpToDate, true);
  });

  test("reports up-to-date with no tracking branch and skips rev-list", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""),
      ok("feature/x\n"),
      ok("  origin/other\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "sync-status",
    });

    assert.equal(response.body.trackingBranch, null);
    assert.equal(response.body.isUpToDate, true);
    // Only fetch, rev-parse, branch -r ran — no rev-list.
    assert.equal(fake.calls.length, 3);
  });

  test("does not mistake a prefix-collision ref (origin/mainline) for the default branch", async () => {
    const repoPath = makeTempDir();
    // Only `origin/mainline` / `origin/masterpiece` exist — neither is the
    // default branch. A substring match would wrongly pick one and then run
    // rev-list against a nonexistent ref; exact-ref parsing must resolve null.
    const fake = new FakeProcessManager([
      ok(""),
      ok("feature/x\n"),
      ok("  origin/mainline\n  origin/masterpiece\n"),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "sync-status",
    });

    assert.equal(response.body.trackingBranch, null);
    assert.equal(response.body.isUpToDate, true);
    // No rev-list ran — fetch, rev-parse, branch -r only.
    assert.equal(fake.calls.length, 3);
  });
});

describe(`registerGitActionRoutes POST ${GIT_PATH} — validation & errors`, () => {
  test("rejects an invalid JSON body with 400", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: GIT_PATH,
      body: "{not json",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects a missing repoPath with 400", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: GIT_PATH,
      body: JSON.stringify({ action: "status" }),
    });

    assert.equal(response.statusCode, 400);
  });

  test("rejects a disallowed repo with RepoNotAllowed", async () => {
    const allowed = makeTempDir();
    const outside = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      allowed,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: GIT_PATH,
      body: JSON.stringify({ repoPath: outside, action: "status" }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, LoopErrorCode.RepoNotAllowed);
    assert.deepEqual(response.body.details, {
      category: GitGatewayErrorCategory.RepoNotAllowed,
    });
  });

  test("returns RepoNotFound when the allowed repo path does not exist", async () => {
    const parent = makeTempDir();
    const missing = `${parent}/does-not-exist`;
    const fake = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    // Allow the parent so the missing child passes the allow-list check but
    // still fails the fs.access existence probe.
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      parent,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: POST,
      pathname: GIT_PATH,
      body: JSON.stringify({ repoPath: missing, action: "status" }),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.code, LoopErrorCode.RepoNotFound);
    assert.equal(fake.calls.length, 0);
  });

  test("rejects an unknown action with 400", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager();

    const response = await dispatchAction(repoPath, fake, {
      action: "teleport",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });

  test("classifies a spawn ENOENT failure as SpawnFailed", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      {
        stdout: "",
        stderr: "spawn git ENOENT",
        exitCode: 1,
        errorCode: "ENOENT",
        errorSyscall: "spawn git",
      },
    ]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.code, LoopErrorCode.SpawnFailed);
    const details = response.body.details as Record<string, unknown>;
    assert.equal(details.category, GitGatewayErrorCategory.SpawnFailed);
    assert.equal(details.action, "status");
  });

  test("classifies a pre-commit hook failure with the hook type", async () => {
    const repoPath = makeTempDir();
    // add succeeds, commit fails with husky/eslint output
    const fake = new FakeProcessManager([
      ok(""),
      fail("husky > pre-commit\neslint found problems", 1),
    ]);

    const response = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "m",
    });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.code, LoopErrorCode.ProcessFailed);
    const details = response.body.details as Record<string, unknown>;
    assert.equal(details.category, GitGatewayErrorCategory.PreCommitHook);
    assert.equal(details.hookType, GitHookType.Lint);
  });

  test("classifies a push auth failure", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("feature/x\n"),
      fail("remote: Permission denied\nfatal: Authentication failed", 128),
    ]);

    const response = await dispatchAction(repoPath, fake, { action: "push" });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.code, LoopErrorCode.ProcessFailed);
    const details = response.body.details as Record<string, unknown>;
    assert.equal(details.category, GitGatewayErrorCategory.GitPushAuth);
  });

  test("classifies a generic git command failure with exit code and excerpt", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      fail("fatal: not a git repository", 128),
    ]);

    const response = await dispatchAction(repoPath, fake, { action: "status" });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.code, LoopErrorCode.ProcessFailed);
    const details = response.body.details as Record<string, unknown>;
    assert.equal(details.category, GitGatewayErrorCategory.GitCommandFailed);
    assert.equal(details.exitCode, 128);
    assert.equal(details.stderrExcerpt, "fatal: not a git repository");
  });
});
