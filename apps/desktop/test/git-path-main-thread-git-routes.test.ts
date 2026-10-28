/**
 * ISS-11596 red-first: the gateway git routes no longer block the event loop
 * while resolving git on a cold login-shell PATH cache (PLN-2165 AC-005, sites
 * S1 to S10). No git override is configured, so every resolution probes the
 * fake login shell. On the synchronous resolver the event loop is blocked for
 * the probe's whole life, so the observer cannot release it and the probe ends
 * unacknowledged; these cases fail on `origin/main` and pass once the sites
 * await `getResolvedGitPathAsync()`.
 *
 * For a resolution that follows another in the same request, the
 * `FakeProcessManager` hook resets the PATH cache first, so that site probes
 * cold too and the case asserts a probe attributable to it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
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
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";
import {
  assertProbesNeverBlocked,
  CacheScope,
  type ColdShellProbe,
  coldShellProbe,
  snapshotEnv,
  withColdShell,
} from "./helpers/git-path-resolution-fixtures.js";

const WORKTREE_PATH = "/api/gateway/git/worktree";
const WORKTREE_PARENT_ENV = "SYMPHONY_WORKTREE_PARENT_DIR";

const { makeTempDir } = createGitOpTempDirs("iss11596-mt-routes-");
const restoreEnv = snapshotEnv([WORKTREE_PARENT_ENV]);

let root = "";
let probe: ColdShellProbe;

beforeEach(async () => {
  configureBinaryPathsResolver(null);
  root = makeTempDir();
  probe = await coldShellProbe({ root, scope: CacheScope.Context });
  await fs.writeFile(path.join(probe.binDir, "git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
});

afterEach(() => {
  probe.stop();
  restoreEnv();
});

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** A `FakeProcessManager` that resets the PATH cache before the exec at `resetBefore`. */
class ResettingProcessManager extends FakeProcessManager {
  private readonly resetBefore: number | null;

  constructor(results: ExecResult[], resetBefore: number | null) {
    super(results);
    this.resetBefore = resetBefore;
  }

  override exec(
    command: string,
    args: string[] = [],
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    const index = this.calls.length;
    const result = super.exec(command, args, cwd, options);
    // Exec `index` already resolved its binary; resetting now makes the NEXT
    // resolution in the same request probe the login shell cold.
    if (this.resetBefore !== null && index + 1 === this.resetBefore) {
      probe.resetNow(`exec-${this.resetBefore}`);
    }
    return result;
  }
}

describe("S1, S2: DELETE /api/gateway/git/worktree", () => {
  test("S1: the remove's git resolution leaves the event loop free", async () => {
    const worktree = path.join(root, "tree");
    await fs.mkdir(worktree);
    const fake = new FakeProcessManager([ok("")]);
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [root],
      () => root
    );

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "DELETE",
        pathname: WORKTREE_PATH,
        body: JSON.stringify({ worktreePath: worktree }),
      })
    );

    await assertProbesNeverBlocked(probe);
  });

  test("S2: the forced-delete fallback's git resolution leaves the event loop free", async () => {
    const worktree = path.join(root, "tree");
    await fs.mkdir(worktree);
    const fake = new ResettingProcessManager(
      [
        { stdout: "", stderr: "fatal: not a working tree", exitCode: 1 },
        ok(`worktree ${worktree}\n`),
      ],
      1
    );
    const dispatcher = new OperationDispatcher();
    registerGitWorktreeRoutes(
      dispatcher,
      fake.asProcessManager(),
      () => [root],
      () => root
    );

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "DELETE",
        pathname: WORKTREE_PATH,
        body: JSON.stringify({ worktreePath: worktree, force: true }),
      })
    );

    await assertProbesNeverBlocked(probe, "exec-1");
  });
});

describe("S3, S4, S5: POST /api/gateway/git/worktree cleanup", () => {
  for (const [site, resetBefore] of [
    ["S3 rev-parse", null],
    ["S4 ls-remote", 1],
    ["S5 worktree remove", 2],
  ] as const) {
    test(`${site}: the git resolution leaves the event loop free`, async () => {
      const parent = path.join(root, "worktrees");
      const prDir = path.join(parent, "widget-pr-7");
      await fs.mkdir(prDir, { recursive: true });
      process.env[WORKTREE_PARENT_ENV] = parent;
      const fake = new ResettingProcessManager(
        [ok("feature/gone\n"), ok(""), ok("")],
        resetBefore
      );
      const dispatcher = new OperationDispatcher();
      registerGitWorktreeRoutes(
        dispatcher,
        fake.asProcessManager(),
        () => [root],
        () => root
      );

      await withColdShell(probe, () =>
        dispatchOperation({
          dispatcher,
          method: "POST",
          pathname: WORKTREE_PATH,
        })
      );

      await assertProbesNeverBlocked(
        probe,
        resetBefore === null ? undefined : `exec-${resetBefore}`
      );
    });
  }
});

describe("S6, S7: POST /api/gateway/git", () => {
  test("S6 status: the read's git resolution leaves the event loop free", async () => {
    const fake = new FakeProcessManager([ok("main\n"), ok("")]);
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [root]);

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/git",
        body: JSON.stringify({ repoPath: root, action: "status" }),
      })
    );

    await assertProbesNeverBlocked(probe);
  });

  test("S7 pull: the run's git resolution leaves the event loop free", async () => {
    const fake = new ResettingProcessManager([ok("feature/x\n"), ok("")], 1);
    const dispatcher = new OperationDispatcher();
    registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [root]);

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/git",
        body: JSON.stringify({ repoPath: root, action: "pull" }),
      })
    );

    await assertProbesNeverBlocked(probe, "exec-1");
  });
});

describe("S8, S9, S10: local changes, branches and diff", () => {
  test("S8 local-changes list: the read's git resolution leaves the event loop free", async () => {
    const fake = new FakeProcessManager([
      ok("feature\n"),
      ok("git@github.com:acme/widget.git\n"),
      ok(""),
      ok(""),
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitLocalChangesRoutes(dispatcher, fake.asProcessManager(), () => [
      root,
    ]);

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "GET",
        pathname: GitLocalChangesRoute.List,
        query: {
          repoPath: root,
          repoFullName: "acme/widget",
          headBranch: "feature",
        },
      })
    );

    await assertProbesNeverBlocked(probe);
  });

  test("S9 branches: the read's git resolution leaves the event loop free", async () => {
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(""),
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
      root,
    ]);

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "GET",
        pathname: "/api/gateway/git/branches",
        query: { repo: root },
      })
    );

    await assertProbesNeverBlocked(probe);
  });

  test("S10 diff: the read's git resolution leaves the event loop free", async () => {
    const fake = new FakeProcessManager([ok("old\n"), ok("new\n")]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [root]);

    await withColdShell(probe, () =>
      dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/git/diff",
        body: JSON.stringify({
          repoPath: root,
          filePath: "src/file.ts",
          baseBranch: "main",
        }),
      })
    );

    await assertProbesNeverBlocked(probe);
  });
});
