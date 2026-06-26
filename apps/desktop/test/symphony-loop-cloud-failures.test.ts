/**
 * Integration tests for cloud failure scenarios in the symphony loop:
 *
 * T-4.2: Cloud failure scenarios
 *   - Artifact upload failure sets ARTIFACT_UPLOAD_FAILED in job store warning
 *     and in completed event warnings
 *   - Local-direct EXECUTE fails fast pre-spawn when callback posting fails
 *   - Relay/cloud-socket EXECUTE still completes and records EVENT_POST_FAILED
 *
 * Tests go through the HTTP gateway, not direct function calls.
 * Fake binaries (run-loop.sh, claude, git, gh) are placed in a temp fake-bin/ dir
 * prepended to PATH. CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE=1 disables the
 * stream_formatter pipeline so the fake claude can emit simple output.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { JobStore } from "../src/main/job-store.js";
import { LoopTokenStore } from "../src/main/loop-token-store.js";
import type { WorktreeProvider } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { createTestLoopTokenSafeStorage } from "./loop-token-test-utils.js";
import {
  createFakeRunLoopScript,
  FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
  makeFakeWorktreeProvider,
  restoreEnv,
  saveEnv,
  setupStubClaude,
  startMockApiServer,
  waitForCompletedEvent,
  waitForFile,
  waitForTerminalEvent,
  writeBootstrapPluginRegistry,
  writeFakeGhScript,
} from "./symphony-test-utils.js";

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/cloud-failures-test"
);

// ---------------------------------------------------------------------------
// Shared state and cleanup
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const savedEnv = saveEnv();

afterEach(async () => {
  restoreEnv(savedEnv);
  resetShellPathCache();

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }

  for (const ms of mockServersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      ms.close((err) => (err ? reject(err) : resolve()));
    });
  }

  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

/**
 * Poll a JobStore until the job for the given loopId reaches a terminal status,
 * or until the timeout elapses.
 */
async function waitForJobTerminal(
  jobStore: JobStore,
  loopId: string,
  timeoutMs = 20_000
): Promise<import("../src/main/job-store.js").LocalJob> {
  const deadline = Date.now() + timeoutMs;
  const terminalStatuses = new Set([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "STOPPED",
    "UNKNOWN",
  ]);
  while (Date.now() < deadline) {
    const job = jobStore.getByLoopId(loopId);
    if (job && terminalStatuses.has(job.status)) {
      return job;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for terminal job status for loopId=${loopId} after ${timeoutMs}ms`
  );
}

async function writeFakeFailingGh(dir: string): Promise<string> {
  return writeFakeGhScript(
    path.join(dir, "fake-bin"),
    '#!/bin/sh\necho "not found" >&2\nexit 1\n'
  );
}

function loopEvents(
  requests: Array<{ url: string; body: string }>,
  loopId: string
): Record<string, unknown>[] {
  return requests
    .filter((request) => request.url.includes(`/loops/${loopId}/events`))
    .flatMap((request) => {
      try {
        return [JSON.parse(request.body) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------
// Test 1: Artifact upload failure sets ARTIFACT_UPLOAD_FAILED in completed event
//         warnings and in the job store warning field
// ---------------------------------------------------------------------------

test("EXECUTE: artifact upload failure sets ARTIFACT_UPLOAD_FAILED in completed event warnings", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-fail-upload-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-upload-fail");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 without making any changes
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  // fake-bin: Claude exits 0 without writing execution-result.json, while
  // still emitting token usage so EXECUTE can complete through git fallback.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
    { mode: 0o755 }
  );

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  // Configure mock server to return 500 for upload-artifacts requests
  const failUrls = new Map<string, number>([["upload-artifacts", 500]]);
  const mock = await startMockApiServer(failUrls);
  mockServersToClose.push(mock.server);

  // Provide a real JobStore so we can verify the warning field
  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-upload-fail" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "cloud-fail-upload-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000500";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: {
          fullName: `upload-fail/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // The completed event is posted after the upload attempt. Wait for it.
  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);

  // Assert ARTIFACT_UPLOAD_FAILED is in the completed event warnings
  const warnings = completedEvent.warnings as string[] | undefined;
  assert.ok(
    Array.isArray(warnings) && warnings.includes("ARTIFACT_UPLOAD_FAILED"),
    `Expected ARTIFACT_UPLOAD_FAILED in completed event warnings, got: ${JSON.stringify(warnings)}`
  );

  // Also verify the job store warning field contains ARTIFACT_UPLOAD_FAILED
  const job = await waitForJobTerminal(jobStore, loopId);
  assert.ok(
    typeof job.warning === "string" &&
      job.warning.includes("ARTIFACT_UPLOAD_FAILED"),
    `Expected job store warning to contain ARTIFACT_UPLOAD_FAILED, got: ${JSON.stringify(job.warning)}`
  );
});

// ---------------------------------------------------------------------------
// Test 2: Local direct EXECUTE fails fast (no spawn) when callback path fails
// ---------------------------------------------------------------------------

test("EXECUTE local-direct: callback failure fails fast before spawn", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-fail-event-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-event-fail");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const spawnMarker = path.join(tmpDir, "native-plan-spawned");
  await createFakeRunLoopScript(
    tmpDir,
    `#!/bin/sh\ntouch ${spawnMarker}\nexit 0\n`
  );

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  // Provide a stub claude binary so the unified pre-flight check passes.
  await setupStubClaude(tmpDir);

  // Callback path failure is simulated by failing /events.
  const failUrls = new Map<string, number>([["events", 500]]);
  const mock = await startMockApiServer(failUrls);
  mockServersToClose.push(mock.server);

  const loopTokenStore = new LoopTokenStore({
    cwd: tmpDir,
    name: "test-local-event-fail-tokens",
    safeStorage: createTestLoopTokenSafeStorage(),
  });
  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-event-fail" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "cloud-fail-event-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
    loopTokenStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000600";
  const requestBody = {
    loopId,
    command: LoopCommand.Execute,
    closedLoopAuthToken: "tok",
    prompt: "test",
    artifacts: [],
    repo: { fullName: `event-fail/${path.basename(repoPath)}`, branch: "main" },
  };

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );

  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 503, `Expected 503, got ${response.status}`);
  assert.ok(
    typeof (payload as { error?: unknown }).error === "string" &&
      (payload as { error: string }).error.includes(
        "cloud callback path is unavailable"
      ),
    `Expected actionable callback-unavailable error, got: ${JSON.stringify(payload)}`
  );

  // No process should be spawned on local-direct callback failure.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  let markerExists = true;
  try {
    await fs.access(spawnMarker);
  } catch {
    markerExists = false;
  }
  assert.equal(markerExists, false, "run-loop.sh should not be spawned");
  assert.equal(
    mock.requests.some((r) => r.url.includes("upload-artifacts")),
    false,
    "upload-artifacts should not be called when launch fails fast pre-spawn"
  );
  assert.equal(
    jobStore.getByLoopId(loopId),
    undefined,
    "Job should not be created when spawn is blocked"
  );
  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "Persisted loop token must be cleaned up on fail-fast path"
  );

  // Verify running-loop slot cleanup: second request should fail with 503, not 409.
  const response2 = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );
  assert.equal(
    response2.status,
    503,
    `Expected second request to return 503, got ${response2.status}`
  );
});

// ---------------------------------------------------------------------------
// Test 3: Relay/cloud-socket behavior stays unchanged on callback post failure
// ---------------------------------------------------------------------------

test("EXECUTE relay: event post failure logged as warning in job store", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-event-relay-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-event-relay");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 without making any changes
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  // fake-bin: Claude exits 0 without writing execution-result.json, while
  // still emitting token usage so EXECUTE can complete through git fallback.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
    { mode: 0o755 }
  );

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  // Configure mock server to return 500 for all /events requests.
  // This causes both the "started" event and the "completed" event to fail.
  // Relay requests should still proceed and finalize with EVENT_POST_FAILED.
  const failUrls = new Map<string, number>([["events", 500]]);
  const mock = await startMockApiServer(failUrls);
  mockServersToClose.push(mock.server);

  // Provide a real JobStore so we can verify the warning field
  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-event-relay-fail",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "cloud-fail-event-relay-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000601";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-desktop-source": "cloud-socket",
      },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: {
          fullName: `event-fail/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for upload-artifacts to confirm the loop progressed past the run phase.
  // (upload-artifacts is not in failUrls so it succeeds and can be waited on)
  await mock.waitForRequest("upload-artifacts");

  // Wait for the job to reach a terminal state in the job store.
  // Even though the completed event POST fails, the loop still finalizes the job.
  const job = await waitForJobTerminal(jobStore, loopId);

  // The loop completes without crashing (status is COMPLETED, not FAILED)
  assert.equal(
    job.status,
    "COMPLETED",
    `Expected job status COMPLETED after event post failure, got: ${job.status}`
  );

  // EVENT_POST_FAILED should appear in the job store warning field
  assert.ok(
    typeof job.warning === "string" &&
      job.warning.includes("EVENT_POST_FAILED"),
    `Expected job store warning to contain EVENT_POST_FAILED, got: ${JSON.stringify(job.warning)}`
  );
});

// ---------------------------------------------------------------------------
// Test 4: Pre-spawn failure cleans up persisted loop token (Layer 2)
// ---------------------------------------------------------------------------

test("PLAN: pre-spawn log-file failure cleans up persisted loop token", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-prespawn-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-prespawn");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const loopId = "00000000-0000-0000-0000-000000000700";
  const repoName = path.basename(repoPath);

  // Custom worktree provider that blocks the log file by creating a
  // directory at its path, causing openSync to fail with EISDIR.
  const blockingWorktreeProvider: WorktreeProvider = {
    async ensureWorktree(_repoPath, worktreeDir) {
      await fs.mkdir(worktreeDir, { recursive: true });
      const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(path.join(workDir, "symphony-loop.log"), {
        recursive: true,
      });
    },
    findWorktreeForBranch() {
      return null;
    },
    async removeWorktree(worktreeDir) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    },
    getCurrentBranch() {
      return "symphony/prespawn-test";
    },
    branchExists: async () => true,
  };

  const loopTokenStore = new LoopTokenStore({
    cwd: tmpDir,
    name: "test-prespawn-tokens",
    safeStorage: createTestLoopTokenSafeStorage(),
  });

  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-prespawn" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "prespawn-fail-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: blockingWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
    loopTokenStore,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "prespawn-token",
        artifacts: [],
        repo: { fullName: `prespawn-fail/${repoName}`, branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 500, "Expected 500 for log-file open failure");

  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "Persisted loop token should be cleaned up after pre-spawn failure"
  );
});

// ---------------------------------------------------------------------------
// Test 5: Non-zero exit cleans up persisted loop token (Layer 1)
// ---------------------------------------------------------------------------

test("PLAN: non-zero exit cleans up persisted loop token", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-nonzero-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-nonzero");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  // Provide a stub claude binary so the unified pre-flight check passes.
  await setupStubClaude(tmpDir);

  // run-loop.sh exits with code 1 to trigger the non-zero exit path
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 1\n", {
    skipTokens: true,
  });

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const loopId = "00000000-0000-0000-0000-000000000800";

  const loopTokenStore = new LoopTokenStore({
    cwd: tmpDir,
    name: "test-nonzero-tokens",
    safeStorage: createTestLoopTokenSafeStorage(),
  });

  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-nonzero" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "nonzero-exit-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
    loopTokenStore,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "nonzero-token",
        artifacts: [],
        repo: {
          fullName: `nonzero-fail/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    "Spawn should succeed (non-zero exit happens later)"
  );

  // Wait for the error event indicating the process failed
  await waitForTerminalEvent(mock.requests, loopId);

  // The token is deleted after the error event is posted (post-event cleanup
  // continues with jobStore upsert and worktree cleanup before the synchronous
  // deleteLoopToken call). Poll briefly to absorb that gap on slow CI runners.
  const tokenDeadline = Date.now() + 5000;
  while (
    loopTokenStore.getLoopToken(loopId) !== null &&
    Date.now() < tokenDeadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "Persisted loop token should be cleaned up after non-zero exit"
  );
});

test("PLAN: bootstrap plugin registry does not block native prompt launch", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-bootstrap-timeout-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-bootstrap-timeout");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS = "100";
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await writeBootstrapPluginRegistry(tmpDir);

  const spawnMarker = path.join(tmpDir, "native-plan-spawned");
  // Do NOT install run-loop.sh: under the legacy-plugin bridge, a present
  // run-loop.sh flips Claude PLAN off the native-prompt launcher and back onto
  // the plugin path (which runs bootstrap). This test verifies the native path,
  // so the claude stub is the sole main-harness mock and touches the marker.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    ["#!/bin/sh", `touch "${spawnMarker}"`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-bootstrap-timeout",
  });
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "bootstrap-timeout-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000850";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "bootstrap-token",
        artifacts: [],
        repo: {
          fullName: `bootstrap-timeout/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected native prompt launch to continue, got ${response.status}: ${await response.text().catch(() => "")}`
  );

  await waitForFile(spawnMarker);
  await waitForCompletedEvent(mock.requests, loopId);
  const job = await waitForJobTerminal(jobStore, loopId);
  assert.equal(job.status, "COMPLETED");

  const events = loopEvents(mock.requests, loopId);
  const startedIndex = events.findIndex((event) => event.type === "started");
  assert.notEqual(startedIndex, -1, "expected Started event");
  for (const event of events) {
    const data = event.data as { chunk?: unknown } | undefined;
    if (event.type !== "output" || typeof data?.chunk !== "string") {
      continue;
    }
    assert.equal(data.chunk.startsWith("[bootstrap-"), false);
  }
});

test("PLAN: bootstrap output post failure injection does not block native prompt launch", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-bootstrap-output-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-bootstrap-output");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await writeBootstrapPluginRegistry(tmpDir);

  const spawnMarker = path.join(tmpDir, "native-plan-spawned-output-post-fail");
  // Do NOT install run-loop.sh: under the legacy-plugin bridge, a present
  // run-loop.sh flips Claude PLAN off the native-prompt launcher and back onto
  // the plugin path (which runs bootstrap). This test verifies the native path,
  // so the claude stub is the sole main-harness mock and touches the marker.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    ["#!/bin/sh", `touch "${spawnMarker}"`, "exit 0"].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer(undefined, (request) => {
    if (!request.url.includes("/events")) {
      return undefined;
    }
    try {
      const event = JSON.parse(request.body) as {
        type?: unknown;
        data?: { chunk?: unknown };
      };
      return event.type === "output" &&
        typeof event.data?.chunk === "string" &&
        event.data.chunk.startsWith("[bootstrap-")
        ? 500
        : undefined;
    } catch {
      return undefined;
    }
  });
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-bootstrap-output-post-fail",
  });
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "bootstrap-output-post-fail-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000851";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Plan,
        closedLoopAuthToken: "bootstrap-token",
        artifacts: [],
        repo: {
          fullName: `bootstrap-output/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected native prompt launch to continue, got ${response.status}: ${await response.text().catch(() => "")}`
  );

  await waitForFile(spawnMarker);
  await waitForCompletedEvent(mock.requests, loopId);
  const job = await waitForJobTerminal(jobStore, loopId);
  assert.equal(job.status, "COMPLETED");

  const events = loopEvents(mock.requests, loopId);
  assert.equal(
    events.some((event) => {
      const data = event.data as { chunk?: unknown } | undefined;
      return (
        event.type === "output" &&
        typeof data?.chunk === "string" &&
        data.chunk.startsWith("[bootstrap-")
      );
    }),
    false,
    "native prompt launch should not emit bootstrap output chunks"
  );
});

// ---------------------------------------------------------------------------
// Test 6: Repo not found emits REPO_NOT_FOUND error event and returns 404
// ---------------------------------------------------------------------------

test("EXECUTE: repo not found emits REPO_NOT_FOUND error event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-repo-not-found-")
  );
  tempPathsToClean.push(tmpDir);

  // No repo directory is created inside tmpDir for org/nonexistent-repo

  // Set up a fake gh binary that exits non-zero so the auto-clone attempt
  // fails immediately rather than invoking the real gh (which would make a
  // network call and time out).
  const fakeGhPath = await writeFakeFailingGh(tmpDir);
  process.env.PATH = `${path.dirname(fakeGhPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-repo-not-found",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repo-not-found-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getSymphonyDir: () => tmpDir,
    getBinaryPaths: () => ({ gh: fakeGhPath }),
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000001001";

  const responsePromise = fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: { fullName: "org/nonexistent-repo", branch: "main" },
      }),
    }
  );
  const eventReq = await mock.waitForRequest(`/loops/${loopId}/events`, 60_000);
  const response = await responsePromise;

  const event = JSON.parse(eventReq.body) as Record<string, unknown>;
  assert.equal(event.type, "error");
  assert.equal(event.code, "REPO_NOT_FOUND");
  assert.ok(
    typeof event.message === "string" &&
      event.message.includes("org/nonexistent-repo"),
    `Expected message to include 'org/nonexistent-repo', got: ${JSON.stringify(event.message)}`
  );
  assert.ok(
    typeof event.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(event.timestamp),
    `Expected ISO timestamp, got: ${JSON.stringify(event.timestamp)}`
  );

  assert.equal(response.status, 404);

  // Verify the runningLoops slot was released: a second identical request should
  // also return 404 (not 409 Conflict).
  const response2 = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: { fullName: "org/nonexistent-repo", branch: "main" },
      }),
    }
  );
  assert.equal(
    response2.status,
    404,
    `Expected second request to return 404 (slot released), got ${response2.status}`
  );
});

// ---------------------------------------------------------------------------
// Test 7: localRepoPath outside sandbox emits REPO_NOT_ALLOWED error event
// ---------------------------------------------------------------------------

test("EXECUTE: localRepoPath outside sandbox emits REPO_NOT_ALLOWED error event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-localrepo-denied-")
  );
  tempPathsToClean.push(tmpDir);

  const loopId = "00000000-0000-0000-0000-000000001002";

  // outsidePath is NOT inside tmpDir -- it lives directly in os.tmpdir()
  const outsidePath = path.join(os.tmpdir(), `outside-sandbox-${loopId}`);
  await fs.mkdir(outsidePath, { recursive: true });
  tempPathsToClean.push(outsidePath);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-repo-not-allowed",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "repo-not-allowed-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const responsePromise = fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        localRepoPath: outsidePath,
        repo: { fullName: "org/test-repo", branch: "main" },
      }),
    }
  );
  const eventReq = await mock.waitForRequest(`/loops/${loopId}/events`);
  const response = await responsePromise;

  const event = JSON.parse(eventReq.body) as Record<string, unknown>;
  assert.equal(event.type, "error");
  assert.equal(event.code, "REPO_NOT_ALLOWED");
  assert.ok(
    typeof event.message === "string" && event.message.length > 0,
    `Expected non-empty message, got: ${JSON.stringify(event.message)}`
  );
  assert.ok(
    !event.message.startsWith("/"),
    "message must not contain filesystem path"
  );
  assert.ok(
    typeof event.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(event.timestamp),
    `Expected ISO timestamp, got: ${JSON.stringify(event.timestamp)}`
  );

  assert.equal(response.status, 403);
});

// ---------------------------------------------------------------------------
// Test 8: fullName-resolved path outside allowedDirs emits REPO_NOT_ALLOWED error event
// ---------------------------------------------------------------------------

test("EXECUTE: fullName-resolved path outside allowedDirs emits REPO_NOT_ALLOWED error event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-fullname-denied-")
  );
  tempPathsToClean.push(tmpDir);

  const loopId = "00000000-0000-0000-0000-000000001003";

  // repoDir lives inside tmpDir but outside allowedDir.
  // assertPathAllowed uses realpathSync.native, so a symlink from inside
  // allowedDir pointing to repoDir will resolve to repoDir (outside allowedDir).
  const allowedDir = path.join(tmpDir, "allowed");
  await fs.mkdir(allowedDir, { recursive: true });

  const repoDir = path.join(tmpDir, "outside-repo");
  await fs.mkdir(repoDir, { recursive: true });

  const repoBasename = path.basename(repoDir);

  // Create a symlink inside allowedDir pointing to the actual repoDir.
  // findLocalRepo will find path.join(allowedDir, repoBasename) via existsSync,
  // but assertPathAllowed resolves the symlink to repoDir which is outside allowedDir.
  const symlinkPath = path.join(allowedDir, repoBasename);
  await fs.symlink(repoDir, symlinkPath);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-fullname-denied",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [allowedDir],
    machineName: "fullname-denied-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const responsePromise = fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: { fullName: `org/${repoBasename}`, branch: "main" },
      }),
    }
  );
  const eventReq = await mock.waitForRequest(`/loops/${loopId}/events`);
  const response = await responsePromise;

  const event = JSON.parse(eventReq.body) as Record<string, unknown>;
  assert.equal(event.type, "error");
  assert.equal(event.code, "REPO_NOT_ALLOWED");
  assert.ok(
    !String(event.message ?? "").includes(repoDir),
    `message must not contain absolute repoDir path, got: ${JSON.stringify(event.message)}`
  );
  assert.ok(
    typeof event.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(event.timestamp),
    `Expected ISO timestamp, got: ${JSON.stringify(event.timestamp)}`
  );

  assert.equal(response.status, 403);
});

// ---------------------------------------------------------------------------
// Test 9: postLoopEventBounded times out after 1000ms when API server hangs
//         and aborts the underlying fetch (no leaked connections)
// ---------------------------------------------------------------------------

test("EXECUTE: postLoopEventBounded times out after 1000ms when API server hangs", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloud-fail-hanging-")
  );
  tempPathsToClean.push(tmpDir);
  const outsidePath = path.join(os.tmpdir(), "outside-sandbox-1005");
  await fs.mkdir(outsidePath, { recursive: true });
  tempPathsToClean.push(outsidePath);

  // Create an inline hanging HTTP server that accepts TCP connections and
  // reads request bodies but never calls res.end() -- hangs indefinitely.
  let hangingRequestCount = 0;
  const hangingSockets = new Set<import("net").Socket>();
  const closedSocketCount = { value: 0 };
  const hangingServer = http.createServer((req) => {
    hangingRequestCount++;
    req.resume(); // drain incoming data -- never responds, hangs indefinitely
  });
  hangingServer.on("connection", (socket) => {
    hangingSockets.add(socket);
    socket.once("close", () => {
      hangingSockets.delete(socket);
      closedSocketCount.value++;
    });
  });
  await new Promise<void>((resolve, reject) => {
    hangingServer.listen(0, "127.0.0.1", resolve);
    hangingServer.once("error", reject);
  });
  const hangingPort = (hangingServer.address() as import("net").AddressInfo)
    .port;
  t.after(async () => {
    for (const socket of hangingSockets) {
      socket.destroy();
    }
    hangingSockets.clear();
    await new Promise<void>((resolve, reject) => {
      hangingServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-hanging" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "hanging-server-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${hangingPort}`,
    getSymphonyDir: () => tmpDir,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  // Use a repo path outside the sandbox to trigger REPO_NOT_ALLOWED, which calls
  // postLoopEventBounded without involving auto-clone or any other slow setup.
  const loopId = "00000000-0000-0000-0000-000000001005";
  const responsePromise = fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        localRepoPath: outsidePath,
        repo: { fullName: "org/test-repo", branch: "main" },
      }),
    }
  );

  // 2000ms deadline = T-1.4 timeoutMs (1000ms) + 1000ms buffer -- update if T-1.4 timeout changes
  const response = await Promise.race([
    responsePromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Response took longer than 2000ms -- bounded wait may have failed"
            )
          ),
        2000
      )
    ),
  ]);

  assert.equal(response.status, 403); // response settled correctly despite hanging server

  // Assert hanging server received at least one request
  assert.ok(
    hangingRequestCount >= 1,
    `Expected hanging server to receive at least one request, got: ${hangingRequestCount}`
  );

  // Verify the AbortController actually cancelled the fetch: the client-side
  // abort tears down the TCP socket, which the hanging server observes as a
  // socket close event. Wait briefly for the close event to propagate.
  const socketCloseDeadline = Date.now() + 2000;
  while (closedSocketCount.value === 0 && Date.now() < socketCloseDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    closedSocketCount.value >= 1,
    `Expected aborted fetch to close the socket, but no sockets were closed (still ${hangingSockets.size} open). ` +
      "This means postLoopEventBounded is not aborting the underlying fetch."
  );
});
