/**
 * Worktree lifecycle tests for multi-repo PLAN requests.
 *
 * 1. ensureWorktree called per additional repo before spawn with correct branch
 *    (scratch-branch invariants only; naming convention covered by unit tests)
 * 2. removeWorktree called on process failure (run-loop.sh exits 1)
 * 3. ensureWorktree throws — assert non-2xx and error event posted
 *
 * Note: the same-basename collision case is covered by a unit test of
 * additionalRepoDisambiguator in symphony-loop-multi-repo-contract.test.ts.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { JobStore } from "../src/main/job-store.js";
import type { WorktreeProvider } from "../src/server/operations/symphony-loop.js";
import {
  defaultWorktreeProvider,
  handleProcessCompletion,
} from "../src/server/operations/symphony-loop.js";
import { setShellPathForTest } from "../src/server/shell-path.js";
import {
  createFakeRunLoopScript,
  FAKE_TOKEN_JSONL,
  initGitRepo,
  makeMultiRepoGateway,
  makeMultiRepoTestHarness,
  makeRecordingGitWorktreeProvider,
  PRD_PEER_COMMANDS,
  startMockApiServer,
  waitForCompletedEvent,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared state and cleanup
// ---------------------------------------------------------------------------

const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
  makeMultiRepoTestHarness();
afterEach(cleanup);

/** Create a gateway server with a mock API backend and a given worktree provider. */
function createTestGateway(
  tmpDir: string,
  mockPort: number,
  worktreeProvider: WorktreeProvider
) {
  return makeMultiRepoGateway({
    tmpDir,
    mockPort,
    machineName: "worktree-lifecycle-test",
    worktreeProvider,
    serversToClose,
  });
}

async function createRepoWithOrigin(
  root: string,
  name: string
): Promise<{ repoPath: string; originPath: string; fullName: string }> {
  const originPath = path.join(root, `${name}.git`);
  const repoPath = path.join(root, name);
  await execFileAsync("git", ["init", "--bare", "-b", "main", originPath]);
  await execFileAsync("git", ["clone", originPath, repoPath]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), `# ${name}\n`);
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  await execFileAsync("git", ["push", "-u", "origin", "main"], {
    cwd: repoPath,
  });
  const fullName = `org/${name}`;
  await execFileAsync(
    "git",
    ["remote", "set-url", "origin", `git@github.com:${fullName}.git`],
    { cwd: repoPath }
  );
  await execFileAsync(
    "git",
    ["remote", "set-url", "--push", "origin", originPath],
    {
      cwd: repoPath,
    }
  );
  return { repoPath, originPath, fullName };
}

async function remoteBranchSha(
  originPath: string,
  branchName: string
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["--git-dir", originPath, "rev-parse", branchName],
    { encoding: "utf8" }
  );
  return String(result.stdout).trim();
}

async function waitForBranchArtifacts(
  requests: Array<{ url: string; body: string }>,
  loopId: string,
  count: number
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const payloads = requests
      .filter((request) =>
        request.url.includes(`/loops/${loopId}/branch-artifact`)
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    if (payloads.length >= count) {
      return payloads;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} branch artifact callbacks`);
}

// ---------------------------------------------------------------------------
// Test 1: ensureWorktree called per additional repo before spawn
// ---------------------------------------------------------------------------

test("ensureWorktree called for each additional repo with correct branch before spawn", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wt-lifecycle-checkout-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const additionalRepoA = path.join(tmpDir, "additional-repo-a");
  const additionalRepoB = path.join(tmpDir, "additional-repo-b");
  await fs.mkdir(additionalRepoA, { recursive: true });
  await fs.mkdir(additionalRepoB, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    ["#!/bin/sh", `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const { provider, ensureWorktreeCalls } = makeRecordingGitWorktreeProvider(
    "symphony/worktree-lifecycle-test"
  );

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port, provider);

  const loopId = "00000000-0000-0000-0000-000000007001";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `wt-lifecycle-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          { localRepoPath: additionalRepoA, branch: "feature-a" },
          { localRepoPath: additionalRepoB, branch: "feature-b" },
        ],
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    "PLAN with additionalRepos should return HTTP 200"
  );

  // Wait for the loop to complete so ensureWorktree calls are captured
  await waitForCompletedEvent(mock.requests, loopId);

  // Filter out the primary repo call — additional repo calls create a scratch
  // branch derived from the user-specified branch so loop work never mutates
  // the user's actual branch. The exact naming convention is an implementation
  // detail; assert only the safety invariants.
  const additionalCalls = ensureWorktreeCalls.filter(
    (c) => c.repoPath !== primaryRepo
  );

  assert.equal(
    additionalCalls.length,
    2,
    `Expected ensureWorktree called 2 times for additional repos, got ${additionalCalls.length}`
  );

  for (const [repoPath, expectedBaseBranch] of [
    [additionalRepoA, "feature-a"],
    [additionalRepoB, "feature-b"],
  ] as const) {
    const call = additionalCalls.find((c) => c.repoPath === repoPath);
    assert.ok(call, `ensureWorktree should be called with ${repoPath}`);
    assert.equal(
      call.baseBranch,
      expectedBaseBranch,
      `Expected baseBranch '${expectedBaseBranch}' for ${repoPath}, got '${call.baseBranch}'`
    );
    assert.ok(
      call.branchName.startsWith("symphony/"),
      `Scratch branch name should be under symphony/ namespace, got '${call.branchName}'`
    );
    assert.notEqual(
      call.branchName,
      call.baseBranch,
      "Scratch branch name must differ from baseBranch to avoid mutating the user's branch"
    );
  }
});

test("PLAN materializes expected additional repo branch and records callback payload", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-add-branch-"));
  tempPathsToClean.push(tmpDir);

  const primary = await createRepoWithOrigin(tmpDir, "primary-materialized");
  const additional = await createRepoWithOrigin(
    tmpDir,
    "additional-materialized"
  );
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      'echo \'{"type":"result","subtype":"success","result":"","is_error":false}\'',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(
    tmpDir,
    mock.port,
    defaultWorktreeProvider
  );

  const loopId = "00000000-0000-0000-0000-000000117001";
  const primaryBranch = "symphony/primary-materialized-branch";
  const additionalBranch = "symphony/additional-materialized-branch";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Plan with a peer repo",
        artifactSlug: "PLN-604-multi",
        repo: {
          fullName: primary.fullName,
          branch: "main",
        },
        additionalRepos: [
          {
            localRepoPath: additional.repoPath,
            fullName: additional.fullName,
            branch: "main",
          },
        ],
        branchMaterialization: {
          schemaVersion: 1,
          branches: [
            {
              role: "primary",
              repositoryFullName: primary.fullName,
              baseBranch: "main",
              branchName: primaryBranch,
            },
            {
              role: "additional",
              repositoryFullName: additional.fullName,
              baseBranch: "main",
              branchName: additionalBranch,
            },
          ],
        },
      }),
    }
  );

  assert.equal(response.status, 200, await response.text());
  const payloads = await waitForBranchArtifacts(mock.requests, loopId, 2);
  const additionalPayload = payloads.find(
    (payload) => payload.repositoryFullName === additional.fullName
  );
  assert.ok(additionalPayload, "expected additional repo branch callback");
  assert.equal(additionalPayload.branchName, additionalBranch);
  assert.equal(additionalPayload.baseBranch, "main");
  assert.equal(additionalPayload.defaultBranch, "main");
  assert.equal(
    await remoteBranchSha(additional.originPath, additionalBranch),
    additionalPayload.headSha
  );
});

test("PLAN materialization rejects additional repo identity mismatch before sidecar push", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-add-mismatch-"));
  tempPathsToClean.push(tmpDir);

  const primary = await createRepoWithOrigin(tmpDir, "primary-add-mismatch");
  const additional = await createRepoWithOrigin(tmpDir, "actual-additional");
  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      'echo \'{"type":"result","subtype":"success","result":"","is_error":false}\'',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(
    tmpDir,
    mock.port,
    defaultWorktreeProvider
  );

  const loopId = "00000000-0000-0000-0000-000000117006";
  const primaryBranch = "symphony/primary-add-mismatch";
  const additionalBranch = "symphony/additional-add-mismatch";
  const declaredAdditionalFullName = "org/declared-additional";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Plan with a mismatched peer repo",
        artifactSlug: "PLN-604-add-mismatch",
        repo: {
          fullName: primary.fullName,
          branch: "main",
        },
        additionalRepos: [
          {
            localRepoPath: additional.repoPath,
            fullName: declaredAdditionalFullName,
            branch: "main",
          },
        ],
        branchMaterialization: {
          schemaVersion: 1,
          branches: [
            {
              role: "primary",
              repositoryFullName: primary.fullName,
              baseBranch: "main",
              branchName: primaryBranch,
            },
            {
              role: "additional",
              repositoryFullName: declaredAdditionalFullName,
              baseBranch: "main",
              branchName: additionalBranch,
            },
          ],
        },
      }),
    }
  );

  assert.equal(response.status, 500);
  const payloads = mock.requests
    .filter((request) =>
      request.url.includes(`/loops/${loopId}/branch-artifact`)
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  assert.equal(
    payloads.length,
    0,
    "additional repo preflight failure must not record any branch artifacts"
  );
  const events = mock.requests
    .filter((request) => request.url.includes(`/loops/${loopId}/events`))
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  assert.ok(
    events.some((event) => event.code === LoopErrorCode.BranchCreateFailed),
    "expected BranchCreateFailed event for additional repo identity mismatch"
  );
  await assert.rejects(remoteBranchSha(primary.originPath, primaryBranch));
  await assert.rejects(
    remoteBranchSha(additional.originPath, additionalBranch)
  );
});

// ---------------------------------------------------------------------------
// Test 2: removeWorktree called on process failure (run-loop.sh exits 1)
// ---------------------------------------------------------------------------

test("removeWorktree called for additional worktree dirs when process fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-lifecycle-fail-"));
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const additionalRepo = path.join(tmpDir, "additional-repo");
  await fs.mkdir(additionalRepo, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  // run-loop.sh exits 1 to simulate process failure
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 1\n", {
    skipTokens: true,
  });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const { provider, ensureWorktreeCalls, removeCalls } =
    makeRecordingGitWorktreeProvider("symphony/worktree-lifecycle-test");

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port, provider);

  const loopId = "00000000-0000-0000-0000-000000007003";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `wt-lifecycle-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          { localRepoPath: additionalRepo, branch: "feature-branch" },
        ],
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    "PLAN should return HTTP 200 (process failure is async)"
  );

  // Wait for the terminal event (error from process failure)
  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "error",
    `Expected terminal event type 'error', got '${terminalEvent.type}'`
  );

  // Additional repo worktree dirs (filter out the primary repo call)
  const additionalWorktreeDirs = ensureWorktreeCalls
    .filter((c) => c.repoPath !== primaryRepo)
    .map((c) => c.worktreeDir);

  assert.equal(
    additionalWorktreeDirs.length,
    1,
    `Expected 1 additional worktree to be created, got ${additionalWorktreeDirs.length}`
  );

  // Cleanup of additional worktrees is async and happens after the error event is posted.
  // Poll until removeWorktree is called for the additional worktree dir, or timeout.
  const expectedDir = additionalWorktreeDirs[0];
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    !removeCalls.some((c) => c.worktreeDir === expectedDir)
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  // removeWorktree should still be called for the additional worktree after failure
  const removed = removeCalls.some((c) => c.worktreeDir === expectedDir);
  assert.ok(
    removed,
    `Expected removeWorktree to be called for additional worktree dir ${expectedDir} after process failure`
  );
});

// ---------------------------------------------------------------------------
// Test 3: ensureWorktree throws for additional repo — assert HTTP 400/500 and error event posted
// ---------------------------------------------------------------------------

test("ensureWorktree throws for additional repo — cleans leaked worktree, posts error event, and returns non-200", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wt-lifecycle-throw-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  await fs.mkdir(primaryRepo, { recursive: true });

  const additionalRepo = path.join(tmpDir, "additional-repo");
  await fs.mkdir(additionalRepo, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  // Provider whose ensureWorktree succeeds for the primary repo but creates
  // then fails the additional repo worktree (simulates checkout failure after
  // git worktree creation, before the dir is tracked for bulk cleanup).
  let primaryCreated = false;
  const {
    provider: baseProvider,
    ensureWorktreeCalls,
    removeCalls,
  } = makeRecordingGitWorktreeProvider("symphony/worktree-lifecycle-test");
  const throwingProvider: WorktreeProvider = {
    ...baseProvider,
    async ensureWorktree(
      repoPath,
      worktreeDir,
      branchName,
      baseBranch,
      loopId
    ) {
      if (!primaryCreated) {
        // First call is the primary repo — let it succeed
        primaryCreated = true;
        await fs.mkdir(worktreeDir, { recursive: true });
        return;
      }
      await baseProvider.ensureWorktree(
        repoPath,
        worktreeDir,
        branchName,
        baseBranch,
        loopId
      );
      throw new Error("Simulated ensureWorktree failure");
    },
  };

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port, throwingProvider);

  const loopId = "00000000-0000-0000-0000-000000007004";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `wt-lifecycle-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          { localRepoPath: additionalRepo, branch: "feature-branch" },
        ],
      }),
    }
  );

  // The server should return a non-200 status (400 or 500) when ensureWorktree throws
  assert.ok(
    response.status >= 400,
    `Expected non-200 status when ensureWorktree throws, got ${response.status}`
  );

  // An error event should be posted to the API
  const errorEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    errorEvent.type,
    "error",
    `Expected error event type, got '${errorEvent.type}'`
  );

  const additionalWorktreeDir = ensureWorktreeCalls.find(
    (call) => call.repoPath === additionalRepo
  )?.worktreeDir;
  assert.ok(
    additionalWorktreeDir,
    "Expected an additional repo worktree dir to be created before failure"
  );

  assert.ok(
    removeCalls.some((call) => call.worktreeDir === additionalWorktreeDir),
    `Expected removeWorktree to be called for leaked additional worktree dir ${additionalWorktreeDir}`
  );
});

// ---------------------------------------------------------------------------
// Test 4: EXECUTE retry reuses retained additional-repo worktree
// ---------------------------------------------------------------------------

test("EXECUTE retry reuses retained additional-repo worktree instead of force-removing it", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wt-lifecycle-retain-")
  );
  tempPathsToClean.push(tmpDir);

  const primaryRepo = path.join(tmpDir, "primary-repo");
  const additionalRepo = path.join(tmpDir, "additional-repo");
  const worktreeParent = path.join(tmpDir, "worktrees");
  await Promise.all(
    [primaryRepo, additionalRepo, worktreeParent].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );

  // Simulate a retained additional-repo worktree from a prior failed/cancelled
  // EXECUTE attempt — cleanupAdditionalWorktrees keeps it because it carries
  // uncommitted or unique-to-HEAD changes. The retry must NOT --force-remove it.
  const retainedAddWorktree = path.join(
    worktreeParent,
    "retained-add-worktree"
  );
  await fs.mkdir(retainedAddWorktree, { recursive: true });
  await fs.writeFile(
    path.join(retainedAddWorktree, "uncommitted-work.txt"),
    "user changes that must survive the retry\n"
  );

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    ["#!/bin/sh", `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const {
    provider: baseProvider,
    ensureWorktreeCalls,
    removeCalls,
  } = makeRecordingGitWorktreeProvider("symphony/wt-lifecycle-retain");

  // Override findWorktreeForBranch so the additional repo lookup returns the
  // retained worktree path (the primary repo lookup keeps returning null so
  // the primary worktree is created fresh and is not part of this assertion).
  const provider: WorktreeProvider = {
    ...baseProvider,
    findWorktreeForBranch(repoPath, branchName) {
      if (repoPath === additionalRepo && branchName.startsWith("symphony/")) {
        return retainedAddWorktree;
      }
      return null;
    },
  };

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port, provider);

  const loopId = "00000000-0000-0000-0000-000000007006";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "Execute the implementation plan",
        artifacts: [],
        artifactSlug: "PLAN-99",
        repo: {
          fullName: `wt-lifecycle-test/${path.basename(primaryRepo)}`,
          branch: "main",
        },
        additionalRepos: [
          {
            localRepoPath: additionalRepo,
            fullName: "acme/add-one",
            branch: "feature-branch",
          },
        ],
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    "EXECUTE with a retained additional worktree should succeed"
  );

  await waitForCompletedEvent(mock.requests, loopId);

  // The retained worktree must NEVER be force-removed.
  const retainedRemovals = removeCalls.filter(
    (call) => call.worktreeDir === retainedAddWorktree
  );
  assert.equal(
    retainedRemovals.length,
    0,
    `Retained additional worktree must not be removed; got ${retainedRemovals.length} removeWorktree call(s) for ${retainedAddWorktree}`
  );

  // Reuse path also skips ensureWorktree for the additional repo: the prior
  // attempt's git worktree is already on disk with the right branch.
  const additionalEnsureCalls = ensureWorktreeCalls.filter(
    (call) => call.repoPath === additionalRepo
  );
  assert.equal(
    additionalEnsureCalls.length,
    0,
    `Reused additional worktree must not be re-created via ensureWorktree; got ${additionalEnsureCalls.length} call(s)`
  );

  // Sanity: the retained worktree directory still exists with its uncommitted file.
  const survived = await fs
    .readFile(path.join(retainedAddWorktree, "uncommitted-work.txt"), "utf-8")
    .catch(() => null);
  assert.equal(
    survived,
    "user changes that must survive the retry\n",
    "Uncommitted work in the retained worktree must survive an EXECUTE retry"
  );
});

test("handleProcessCompletion cleans additional worktrees when PLAN is cancelled during post-processing", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wt-lifecycle-cancel-")
  );
  tempPathsToClean.push(tmpDir);

  const claudeWorkDir = path.join(tmpDir, "claude-workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-test",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`
  );

  const now = new Date().toISOString();
  const loopId = "00000000-0000-0000-0000-000000007005";
  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-wt-lifecycle-cancel",
  });
  jobStore.upsert({
    id: "job-wt-lifecycle-cancel",
    kind: "SYMPHONY_LOOP",
    loopId,
    command: LoopCommand.Plan,
    status: "CANCEL_PENDING",
    startedAt: now,
    updatedAt: now,
  });

  const additionalWorktrees = [
    {
      dir: path.join(tmpDir, "worktrees", "repo-a"),
      repoPath: path.join(tmpDir, "repos", "repo-a"),
    },
    {
      dir: path.join(tmpDir, "worktrees", "repo-b"),
      repoPath: path.join(tmpDir, "repos", "repo-b"),
    },
  ];
  await Promise.all(
    additionalWorktrees.map(async ({ dir, repoPath }) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(repoPath, { recursive: true });
      // Initialize as a real git repo so the unified cleanup logic can verify
      // the worktree carries no code changes and is safe to remove.
      await initGitRepo(dir, { allowEmpty: true });
    })
  );

  const removeCalls: Array<{
    worktreeDir: string;
    repoPath: string;
    loopId?: string;
  }> = [];
  const worktreeProvider: WorktreeProvider = {
    async ensureWorktree() {},
    findWorktreeForBranch() {
      return null;
    },
    async removeWorktree(worktreeDir, repoPath, removeLoopId) {
      removeCalls.push({ worktreeDir, repoPath, loopId: removeLoopId });
      await fs.rm(worktreeDir, { recursive: true, force: true });
    },
    getCurrentBranch() {
      return "symphony/worktree-lifecycle-test";
    },
    branchExists: async () => true,
  };

  await handleProcessCompletion(
    0,
    {
      loopId,
      command: LoopCommand.Plan,
      closedLoopAuthToken: "tok",
    } as Parameters<typeof handleProcessCompletion>[1],
    "http://127.0.0.1:9",
    null,
    claudeWorkDir,
    false,
    null,
    () => [tmpDir],
    undefined,
    jobStore,
    undefined,
    undefined,
    undefined,
    worktreeProvider,
    undefined,
    additionalWorktrees
  );

  assert.deepEqual(
    removeCalls.map((call) => ({
      worktreeDir: call.worktreeDir,
      repoPath: call.repoPath,
      loopId: call.loopId,
    })),
    additionalWorktrees.map(({ dir, repoPath }) => ({
      worktreeDir: dir,
      repoPath,
      loopId,
    })),
    "Expected cancellation gate to clean every additional repo worktree"
  );

  const finalJob = jobStore.getByLoopId(loopId);
  assert.equal(finalJob?.status, "CANCELLED");
});

// ---------------------------------------------------------------------------
// AC-007: cleanupAdditionalWorktrees emits NO LoopEvents — neither when it
// removes a clean peer worktree on success, nor when the underlying remove
// fails. Worktree lifecycle is gateway-internal noise; the user-visible
// event channel must stay quiet.
//
// Tested for the new peer-enabled commands (GENERATE_PRD,
// REQUEST_PRD_CHANGES). PLAN/EXECUTE inherit identical wiring through
// cleanupAdditionalWorktrees so the AC-007 contract holds for them too.
// ---------------------------------------------------------------------------

for (const command of PRD_PEER_COMMANDS) {
  test(`${command}: cleanupAdditionalWorktrees emits no LoopEvents on successful peer-worktree teardown`, async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `wt-prd-cleanup-no-events-${command.toLowerCase()}-`
      )
    );
    tempPathsToClean.push(tmpDir);

    const primaryRepo = path.join(tmpDir, "primary-repo");
    await fs.mkdir(primaryRepo, { recursive: true });
    const peerRepo = path.join(tmpDir, "peer");
    await fs.mkdir(peerRepo, { recursive: true });

    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    process.env.HOME = tmpDir;
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

    // Direct-claude pipeline (no run-loop.sh) — exit 0 → completed terminal.
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      path.join(fakeBin, "claude"),
      '#!/bin/sh\necho \'{"type":"result"}\'\nexit 0\n',
      { mode: 0o755 }
    );
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    const { provider, removeCalls } = makeRecordingGitWorktreeProvider(
      "symphony/worktree-prd-cleanup-test"
    );

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);
    const server = await createTestGateway(tmpDir, mock.port, provider);

    const loopId =
      command === LoopCommand.GeneratePrd
        ? "00000000-0000-0000-0000-000000008101"
        : "00000000-0000-0000-0000-000000008102";

    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command,
          closedLoopAuthToken: "tok",
          artifacts:
            command === LoopCommand.RequestPrdChanges
              ? [
                  {
                    id: "art-1",
                    type: "prd",
                    title: "Existing PRD",
                    content: "PRD body",
                  },
                ]
              : [],
          prompt: "Generate / amend the PRD",
          repo: {
            fullName: `prd-wt/${path.basename(primaryRepo)}`,
            branch: "main",
          },
          additionalRepos: [
            { fullName: "org/peer", localRepoPath: peerRepo, branch: "main" },
          ],
        }),
      }
    );

    assert.equal(response.status, 200);

    // Wait for terminal event so handleProcessCompletion (and its peer
    // cleanup) finishes before we inspect the event log.
    const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(
      terminalEvent.type,
      "completed",
      `${command}: expected terminal=completed, got ${terminalEvent.type}: ${JSON.stringify(terminalEvent)}`
    );

    // The peer worktree must have been torn down. Cleanup of additional
    // worktrees is async and runs after the terminal event is posted; poll
    // until the remove call lands or the deadline elapses (matches Test 2's
    // "removeWorktree on process failure" pattern above).
    const cleanupDeadline = Date.now() + 5000;
    while (
      Date.now() < cleanupDeadline &&
      !removeCalls.some((c) => c.repoPath === peerRepo)
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      removeCalls.some((c) => c.repoPath === peerRepo),
      `${command}: peer worktree must be removed after success`
    );

    // None of the posted LoopEvents should mention the peer worktree
    // teardown — those are gateway-log only per AC-007.
    const events = mock.requests.filter((r) =>
      r.url.includes(`/loops/${loopId}/events`)
    );
    for (const e of events) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(e.body) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = String(parsed.message ?? "");
      assert.ok(
        !/cleanup|removed|removing|teardown|reaped/i.test(message),
        `${command}: cleanup must not emit user-visible events; got message=${message}`
      );
    }
  });
}
