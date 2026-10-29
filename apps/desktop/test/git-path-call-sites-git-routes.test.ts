/**
 * ISS-11596 characterization: the gateway git routes keep their observable
 * behavior when their git binary resolution moves from the synchronous
 * `getResolvedGitPath()` to `await getResolvedGitPathAsync()`.
 *
 * Every assertion here must pass UNCHANGED on `origin/main` (sync resolver)
 * and on the branch (async resolver). Each site is driven at its route twice:
 * with a working override (the response, and the executed command is the
 * override), and with the override made unusable just before that site's
 * resolution, so the ISS-10194 strict refusal shows where the route surfaces a
 * resolver failure. Sites S1 to S10 are numbered as in PLN-2165.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { GitGatewayErrorCategory } from "@closedloop-ai/loops-api/friendly-error";
import { afterEach, describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import { registerGitBranchesRoutes } from "../src/server/operations/git-branches.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import {
  GitLocalChangesRoute,
  registerGitLocalChangesRoutes,
} from "../src/server/operations/git-local-changes.js";
import { registerGitWorktreeRoutes } from "../src/server/operations/git-worktree.js";
import {
  type ExecResult,
  ProcessManager,
} from "../src/server/process-manager.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resolveExecutablesOnPathSync,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";
import {
  assertStrictBinaryOverrides,
  type RevocableBinary,
  revocableBinary,
  snapshotEnv,
  strictRefusalPattern,
} from "./helpers/git-path-resolution-fixtures.js";

const WORKTREE_PATH = "/api/gateway/git/worktree";
const GIT_PATH = "/api/gateway/git";
const BRANCHES_PATH = "/api/gateway/git/branches";
const DIFF_PATH = "/api/gateway/git/diff";
const WORKTREE_PARENT_ENV = "SYMPHONY_WORKTREE_PARENT_DIR";
const INTERNAL_ERROR_BODY = { error: "internal error" };
const FAILED_TO_REMOVE_WORKTREE = /^Failed to remove worktree: /;

const { makeTempDir } = createGitOpTempDirs("iss11596-routes-");
const restoreEnv = snapshotEnv([WORKTREE_PARENT_ENV]);
const servers: DesktopGatewayServer[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  restoreEnv();
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string): ExecResult {
  return { stdout: "", stderr, exitCode: 1 };
}

/** A `FakeProcessManager` that runs `beforeExec(index)` before recording each call. */
class HookedProcessManager extends FakeProcessManager {
  private readonly beforeExec: (index: number) => void;

  constructor(results: ExecResult[], beforeExec: (index: number) => void) {
    super(results);
    this.beforeExec = beforeExec;
  }

  override exec(
    command: string,
    args: string[] = [],
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    this.beforeExec(this.calls.length);
    return super.exec(command, args, cwd, options);
  }
}

/** A usable fake git override, configured process-wide. */
function configureFakeGit(dir: string): RevocableBinary {
  const git = revocableBinary(dir, "git", "#!/bin/sh\nexit 0\n");
  configureBinaryPathsResolver(() => ({ git: git.path }));
  return git;
}

async function startGateway(
  allowedDir: string,
  git: RevocableBinary
): Promise<string> {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "iss-11596",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(allowedDir, "electron-port"),
    getSymphonyDir: () => allowedDir,
    getGatewayId: () => "iss-11596",
    getBinaryPaths: () => ({ git: git.path }),
  });
  servers.push(server);
  await server.start();
  return `http://127.0.0.1:${server.getActivePort()}`;
}

async function httpJson(
  url: string,
  init: RequestInit
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
}

describe("S1: DELETE /api/gateway/git/worktree", () => {
  test("a working override removes the worktree through the override", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const git = configureFakeGit(allowed);
    const fake = new FakeProcessManager([ok("")]);
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [allowed],
      () => allowed
    );

    const response = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree }),
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      success: true,
      message: "Worktree removed successfully",
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].command, git.path);
  });

  test("an unusable override rejects the route before any git runs", async () => {
    assertStrictBinaryOverrides();
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const git = configureFakeGit(allowed);
    git.revoke();
    const fake = new FakeProcessManager([]);
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [allowed],
      () => allowed
    );

    await assert.rejects(
      dispatchOperation({
        dispatcher,
        method: "DELETE",
        pathname: WORKTREE_PATH,
        body: JSON.stringify({ worktreePath: worktree }),
      }),
      strictRefusalPattern(git.path)
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(worktree), true);
  });

  test("over HTTP the router answers 500 internal error and keeps the worktree", async () => {
    assertStrictBinaryOverrides();
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const git = revocableBinary(allowed, "git", "#!/bin/sh\nexit 0\n");
    git.revoke();
    const base = await startGateway(allowed, git);

    const response = await httpJson(`${base}${WORKTREE_PATH}`, {
      method: "DELETE",
      body: JSON.stringify({ worktreePath: worktree }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, INTERNAL_ERROR_BODY);
    assert.equal(existsSync(worktree), true);
  });

  test("a worktree removed while git is being resolved gives the same answer on both revisions", async () => {
    // PLN-2165 AC-006 (Daveth, Q-002 option a): the `existsSync` check and the
    // spawn no longer share one event-loop turn. A removal that lands inside
    // the resolution must produce a response the route already gives today.
    // The fake login shell deletes the worktree while it computes the PATH, so
    // the removal lands between the check and the spawn on both revisions.
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const binDir = path.join(allowed, "bin");
    await fs.mkdir(binDir);
    const [hostGit] = resolveExecutablesOnPathSync(
      "git",
      process.env.PATH ?? ""
    );
    assert.ok(hostGit, "the test needs a host git on PATH");
    await fs.symlink(hostGit, path.join(binDir, "git"));
    const shell = path.join(allowed, "deleting-shell");
    await fs.writeFile(
      shell,
      `#!/bin/sh\nrm -rf ${JSON.stringify(worktree)}\necho "__CLPATH_START__${binDir}:/usr/bin:/bin__CLPATH_END__"\n`,
      { mode: 0o755 }
    );
    configureBinaryPathsResolver(null);
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      new ProcessManager({ getAllowedDirectories: () => [allowed] }),
      () => [allowed],
      () => allowed
    );

    const response = await withShellPathEnvForTest(
      { ...process.env, SHELL: shell, PATH: `${binDir}:/usr/bin:/bin` },
      () =>
        dispatchOperation({
          dispatcher,
          method: "DELETE",
          pathname: WORKTREE_PATH,
          body: JSON.stringify({ worktreePath: worktree }),
        })
    );

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), FAILED_TO_REMOVE_WORKTREE);
    assert.equal(existsSync(worktree), false);
  });
});

describe("S2: isRegisteredWorktree, the forced-delete fallback", () => {
  test("an override made unusable after the failed remove rejects without deleting", async () => {
    assertStrictBinaryOverrides();
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const git = configureFakeGit(allowed);
    // The hook runs after the forced remove's own resolution, so only the
    // fallback's resolution sees the unusable override.
    const fake = new HookedProcessManager(
      [fail("fatal: not a working tree")],
      (index) => {
        if (index === 0) {
          git.revoke();
        }
      }
    );
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [allowed],
      () => allowed
    );

    await assert.rejects(
      dispatchOperation({
        dispatcher,
        method: "DELETE",
        pathname: WORKTREE_PATH,
        body: JSON.stringify({ worktreePath: worktree, force: true }),
      }),
      strictRefusalPattern(git.path)
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(existsSync(worktree), true);
  });

  test("over HTTP the router answers 500 internal error and keeps the directory", async () => {
    assertStrictBinaryOverrides();
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    const binDir = path.join(allowed, "bin");
    await fs.mkdir(binDir);
    // Fails the forced remove, then makes itself unusable, so the fallback's
    // own resolution is the one that refuses.
    const git = revocableBinary(
      binDir,
      "git",
      '#!/bin/sh\nchmod 644 "$0"\necho "fatal: not a working tree" >&2\nexit 1\n'
    );
    const base = await startGateway(allowed, git);

    const response = await httpJson(`${base}${WORKTREE_PATH}`, {
      method: "DELETE",
      body: JSON.stringify({ worktreePath: worktree, force: true }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, INTERNAL_ERROR_BODY);
    assert.equal(existsSync(worktree), true);
  });
});

describe("S3, S4, S5: POST /api/gateway/git/worktree cleanup", () => {
  async function cleanupWithRevokeBefore(execIndex: number): Promise<{
    response: Awaited<ReturnType<typeof dispatchOperation>>;
    fake: HookedProcessManager;
    prDir: string;
    git: RevocableBinary;
  }> {
    assertStrictBinaryOverrides();
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-7");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;
    const git = configureFakeGit(allowed);
    if (execIndex === 0) {
      git.revoke();
    }
    const fake = new HookedProcessManager(
      [ok("feature/gone\n"), ok(""), ok("")],
      (index) => {
        // Exec `index` already resolved its binary; the next one sees this.
        if (index + 1 === execIndex) {
          git.revoke();
        }
      }
    );
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [allowed],
      () => allowed
    );
    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: WORKTREE_PATH,
    });
    return { response, fake, prDir, git };
  }

  test("a working override runs all three steps through the override", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-7");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;
    const git = configureFakeGit(allowed);
    const fake = new FakeProcessManager([ok("feature/gone\n"), ok(""), ok("")]);
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [allowed],
      () => allowed
    );

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: WORKTREE_PATH,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      removed: [prDir],
      kept: [],
      errors: [],
    });
    assert.deepEqual(
      fake.calls.map((call) => call.command),
      [git.path, git.path, git.path]
    );
  });

  for (const [site, execIndex] of [
    ["S3 rev-parse", 0],
    ["S4 ls-remote", 1],
    ["S5 worktree remove", 2],
  ] as const) {
    test(`${site}: an unusable override answers 500 cleanup failed after ${execIndex} git call(s)`, async () => {
      const { response, fake, prDir, git } =
        await cleanupWithRevokeBefore(execIndex);

      assert.equal(response.statusCode, 500);
      assert.match(
        String(response.body.error),
        new RegExp(
          `^Worktree cleanup failed: ${strictRefusalPattern(git.path).source}`
        )
      );
      assert.equal(fake.calls.length, execIndex);
      assert.equal(existsSync(prDir), true);
    });
  }
});

describe("S6, S7: POST /api/gateway/git", () => {
  test("S6 status: a working override reads through the override", async () => {
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    const fake = new FakeProcessManager([ok("main\n"), ok("")]);
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: GIT_PATH,
      body: JSON.stringify({ repoPath, action: "status" }),
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      fake.calls.map((call) => call.command),
      [git.path, git.path]
    );
  });

  test("S6 status: an unusable override answers 500 with the refusal", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    git.revoke();
    const fake = new FakeProcessManager([]);
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: GIT_PATH,
      body: JSON.stringify({ repoPath, action: "status" }),
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), strictRefusalPattern(git.path));
    assert.equal(fake.calls.length, 0);
  });

  test("S7 pull: an override made unusable after the branch read answers 500 with the refusal", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    const fake = new HookedProcessManager([ok("feature/x\n")], (index) => {
      if (index === 0) {
        git.revoke();
      }
    });
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: GIT_PATH,
      body: JSON.stringify({ repoPath, action: "pull" }),
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), strictRefusalPattern(git.path));
    assert.equal(fake.calls.length, 1);
  });

  test("S7 branch: two requests whose branch reads overlap give one 200 and one git failure on both revisions", async () => {
    // PLN-2165 AC-006: the decision on `branch --list` and the `checkout -b`
    // spawn no longer share one turn. An in-process competitor can already
    // land during the awaited read on origin/main, so the route already gives
    // this pair; the conversion must not add a different answer.
    const repo = makeTempDir();
    const [hostGit] = resolveExecutablesOnPathSync(
      "git",
      process.env.PATH ?? ""
    );
    assert.ok(hostGit, "the test needs a host git on PATH");
    const runHostGit = async (args: string[]): Promise<void> => {
      const processManager = new ProcessManager({
        getAllowedDirectories: () => [repo],
      });
      const result = await processManager.exec(hostGit, args, repo);
      assert.equal(result.exitCode, 0, result.stderr);
    };
    await runHostGit(["init", "-q", "-b", "main"]);
    await runHostGit([
      "-c",
      "user.email=iss11596@example.invalid",
      "-c",
      "user.name=iss11596",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const wrapperDir = makeTempDir();
    const wrapper = revocableBinary(
      wrapperDir,
      "git",
      [
        "#!/bin/sh",
        'if [ "$1" = branch ]; then',
        `  out=$(${JSON.stringify(hostGit)} "$@"); rc=$?`,
        // Both reads see the branch missing: the first read holds its answer
        // until the second read has run (bounded, about 10 s).
        `  if mkdir ${JSON.stringify(path.join(wrapperDir, "first-read"))} 2>/dev/null; then`,
        "    i=0",
        `    while [ ! -f ${JSON.stringify(path.join(wrapperDir, "second-read"))} ]; do i=$((i + 1)); if [ "$i" -gt 100 ]; then break; fi; sleep 0.1; done`,
        "  else",
        `    : > ${JSON.stringify(path.join(wrapperDir, "second-read"))}`,
        "  fi",
        "  printf '%s' \"$out\"",
        "  exit $rc",
        "fi",
        `exec ${JSON.stringify(hostGit)} "$@"`,
        "",
      ].join("\n")
    );
    configureBinaryPathsResolver(() => ({ git: wrapper.path }));
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(
      dispatcher,
      new ProcessManager({ getAllowedDirectories: () => [repo] }),
      () => [repo]
    );
    const send = () =>
      dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: GIT_PATH,
        body: JSON.stringify({
          repoPath: repo,
          action: "branch",
          branchName: "feat/race",
        }),
      });

    const responses = await Promise.all([send(), send()]);

    const statuses = responses.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [200, 500]);
    const failed = responses.find((r) => r.statusCode === 500);
    assert.ok(failed);
    assert.equal(failed.body.code, LoopErrorCode.ProcessFailed);
    assert.equal(
      (failed.body.details as Record<string, unknown>).category,
      GitGatewayErrorCategory.GitCommandFailed
    );
  });
});

describe("S8: GET /api/gateway/git/local-changes", () => {
  const listQuery = (repoPath: string) => ({
    repoPath,
    repoFullName: "acme/widget",
    headBranch: "feature",
  });

  test("a working override lists through the override", async () => {
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    const fake = new FakeProcessManager([
      ok("feature\n"),
      ok("git@github.com:acme/widget.git\n"),
      ok(""),
      ok(""),
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitLocalChangesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: GitLocalChangesRoute.List,
      query: listQuery(repoPath),
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.files, []);
    assert.ok(fake.calls.length >= 3);
    for (const call of fake.calls) {
      assert.equal(call.command, git.path);
    }
  });

  test("an unusable override rejects the route at the first git read", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    git.revoke();
    const fake = new FakeProcessManager([]);
    const dispatcher = new OperationDispatcher();
    registerGitLocalChangesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    await assert.rejects(
      dispatchOperation({
        dispatcher,
        method: "GET",
        pathname: GitLocalChangesRoute.List,
        query: listQuery(repoPath),
      }),
      strictRefusalPattern(git.path)
    );
    assert.equal(fake.calls.length, 0);
  });

  test("over HTTP the router answers 500 internal error", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = revocableBinary(repoPath, "git", "#!/bin/sh\nexit 0\n");
    git.revoke();
    const base = await startGateway(repoPath, git);
    const query = new URLSearchParams(listQuery(repoPath));

    const response = await httpJson(
      `${base}${GitLocalChangesRoute.List}?${query.toString()}`,
      { method: "GET" }
    );

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, INTERNAL_ERROR_BODY);
  });
});

describe("S9: GET /api/gateway/git/branches", () => {
  test("an unusable override answers 500 with the refusal", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    git.revoke();
    const fake = new FakeProcessManager([]);
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: BRANCHES_PATH,
      query: { repo: repoPath },
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), strictRefusalPattern(git.path));
    assert.equal(fake.calls.length, 0);
  });

  test("a working override reads through the override", async () => {
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(""),
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: BRANCHES_PATH,
      query: { repo: repoPath },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.defaultBranch, "main");
    for (const call of fake.calls) {
      assert.equal(call.command, git.path);
    }
  });
});

describe("S10: POST /api/gateway/git/diff", () => {
  test("an unusable override answers 500 Failed to get diff", async () => {
    assertStrictBinaryOverrides();
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    git.revoke();
    const fake = new FakeProcessManager([]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: DIFF_PATH,
      body: JSON.stringify({
        repoPath,
        filePath: "src/file.ts",
        baseBranch: "main",
      }),
    });

    assert.equal(response.statusCode, 500);
    assert.match(
      String(response.body.error),
      new RegExp(
        `^Failed to get diff: ${strictRefusalPattern(git.path).source}`
      )
    );
    assert.equal(fake.calls.length, 0);
  });

  test("a working override diffs through the override", async () => {
    const repoPath = makeTempDir();
    const git = configureFakeGit(repoPath);
    const fake = new FakeProcessManager([ok("old\n"), ok("new\n")]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);

    const response = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: DIFF_PATH,
      body: JSON.stringify({
        repoPath,
        filePath: "src/file.ts",
        baseBranch: "main",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.oldContent, "old\n");
    assert.deepEqual(
      fake.calls.map((call) => call.command),
      [git.path, git.path]
    );
  });
});
