/**
 * Integration tests for the EXECUTE loop command, specifically:
 *
 * T-5.1: No-changes paths
 *   - executeGitOperations returns null when git status --porcelain is empty
 *   - attemptLlmCommit returns { status: "failed", reason: { kind: "other" }, logTail: "..." } when claude exits 0 without writing execution-result.json
 *
 * T-5.2: Existing-PR paths
 *   - executeGitOperations returns existing PR URL when gh pr view succeeds (no gh pr create)
 *   - handleProcessCompletion returns PR URL from pre-written execution-result.json
 *     without calling executeGitOperations
 *
 * Tests go through the HTTP gateway, not direct function calls.
 * Fake binaries (run-loop.sh, claude, git, gh) are placed in a temp fake-bin/ dir
 * prepended to PATH. CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE=1 disables the
 * stream_formatter pipeline so the fake claude can emit simple output.
 * Uses a fake WorktreeProvider (no real git) so no real git repos are needed.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { JobStore } from "../src/main/job-store.js";
import { Observability } from "../src/main/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry-service.js";
import { resetResolvedClaudePath } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  createFakeRunLoopScript,
  FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
  FAKE_TOKEN_JSONL,
  initGitRepo,
  makeFakeWorktreeProvider,
  restoreEnv,
  saveEnv,
  startMockApiServer,
  waitForCompletedEvent,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const fakeWorktreeProvider = makeFakeWorktreeProvider("symphony/execute-test");

function nativePromptThenLlmFinalizationScript(
  finalizationScript: string
): string {
  const finalizationBody = finalizationScript.replace(/^#!\/bin\/sh\n?/, "");
  return [
    "#!/bin/sh",
    'marker=".fake-claude-native-prompt-complete"',
    'if [ ! -f "$marker" ]; then',
    '  touch "$marker"',
    `  printf '%s\\n' '${FAKE_TOKEN_JSONL}'`,
    "  exit 0",
    "fi",
    'if [ -z "$CLOSEDLOOP_WORKDIR" ]; then',
    '  CLOSEDLOOP_WORKDIR="$PWD/.closedloop-ai/work"',
    "  export CLOSEDLOOP_WORKDIR",
    "fi",
    'if [ -z "$CLOSEDLOOP_PLAN_FILE" ] && [ -f "$CLOSEDLOOP_WORKDIR/imported-plan.md" ]; then',
    '  CLOSEDLOOP_PLAN_FILE="$CLOSEDLOOP_WORKDIR/imported-plan.md"',
    "  export CLOSEDLOOP_PLAN_FILE",
    "fi",
    finalizationBody,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Shared state and cleanup
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const savedEnv = saveEnv();

function resolveExecuteWorktreeDir(
  worktreeParent: string,
  repoPath: string,
  loopId: string
): string {
  return path.join(worktreeParent, `${path.basename(repoPath)}-loop-${loopId}`);
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForTelemetryCategory(
  events: EnrichedTelemetryEvent[],
  category: string,
  loopId: string,
  timeoutMs = 10_000
): Promise<EnrichedTelemetryEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(
      (candidate) =>
        candidate.category === category && candidate.trace?.loopId === loopId
    );
    if (event) {
      return event;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for telemetry category ${category} loopId=${loopId}`
  );
}

async function withFakeShellPath<T>(
  fakeBin: string,
  fn: () => Promise<T>
): Promise<T> {
  return await withShellPathEnvForTest(
    {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
    },
    async () => {
      setShellPathForTest();
      return await fn();
    }
  );
}

afterEach(async () => {
  await Observability.shutdown();
  Observability.reset();
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

// ---------------------------------------------------------------------------
// Test 1: No-changes → executeGitOperations returns { status: "no-changes" } (no PR URL in upload)
// ---------------------------------------------------------------------------

test("EXECUTE: no PR URL in upload when worktree has no changes (git status empty)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-nochange-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-nochange");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  // Redirect HOME so getPluginCacheRoot() returns a path we control
  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 without making any changes
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  // fake-bin: claude that exits 0 without writing execution-result.json
  //   (simulates attemptLlmCommit finding no result file →
  //    returns { status: "failed", reason: { kind: "other" }, logTail: "..." })
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
    { mode: 0o755 }
  );

  // fake git: status returns empty (no changes); all other commands succeed
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  // Disable stream_formatter pipeline — fake claude output is not a real stream
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-nochange-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000100";
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
          fullName: `nochange/${path.basename(repoPath)}`,
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

  // Wait for the upload call that signals process completion
  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: {
      executionResult?: {
        schemaVersion?: number;
        results?: Array<{ status: string; reason?: string; fullName?: string }>;
      };
    };
    metadata: Record<string, unknown>;
  };

  // No changes now persist an explicit V2 execution-result.json so recovery
  // can replay the same completion metadata after restart.
  assert.equal(uploadBody.artifacts.executionResult?.schemaVersion, 2);
  assert.equal(
    uploadBody.artifacts.executionResult?.results?.[0]?.status,
    "skipped",
    "Expected primary entry status=skipped when there are no changes"
  );
  assert.equal(
    uploadBody.artifacts.executionResult?.results?.[0]?.reason,
    "no_changes",
    "Expected primary entry reason=no_changes"
  );
  assert.equal(
    uploadBody.metadata.executeFinalizationStatus,
    "no-changes",
    `Expected executeFinalizationStatus=no-changes, got: ${String(uploadBody.metadata.executeFinalizationStatus)}`
  );
  assert.equal(
    uploadBody.metadata.executeFinalizationPath,
    "git-fallback",
    `Expected executeFinalizationPath=git-fallback, got: ${String(uploadBody.metadata.executeFinalizationPath)}`
  );

  // Also check the completed event does NOT contain GIT_PUSH_FAILED in warnings.
  // The completed event is posted after upload-artifacts, so poll until it appears.
  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);
  assert.ok(
    !(completedEvent.warnings as string[] | undefined)?.includes(
      "GIT_PUSH_FAILED"
    ),
    `Expected no GIT_PUSH_FAILED warning in completed event for no-changes path, got warnings: ${JSON.stringify(completedEvent.warnings)}`
  );
  assert.equal(
    completedEvent.result?.executeFinalizationStatus,
    "no-changes",
    `Expected completed event executeFinalizationStatus=no-changes, got: ${String(completedEvent.result?.executeFinalizationStatus)}`
  );
  assert.equal(
    completedEvent.result?.executeFinalizationPath,
    "git-fallback",
    `Expected completed event executeFinalizationPath=git-fallback, got: ${String(completedEvent.result?.executeFinalizationPath)}`
  );
});

test("EXECUTE: sandbox change during LLM finalization skips git fallback and branch probing", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-sandbox-change-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-sandbox-change");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  const claudeStartedMarker = path.join(tmpDir, "claude-started");
  const claudeReleaseMarker = path.join(tmpDir, "claude-release");
  const gitCapture = path.join(tmpDir, "git-capture.txt");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      `touch ${JSON.stringify(claudeStartedMarker)}`,
      `while [ ! -f ${JSON.stringify(claudeReleaseMarker)} ]; do sleep 0.05; done`,
      `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(fakeBin, "git"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" >> ${JSON.stringify(gitCapture)}`,
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then',
      '  echo "symphony/execute-test"',
      "  exit 0",
      "fi",
      'if [ "$1" = status ]; then',
      '  echo " M touched.txt"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  await fs.writeFile(path.join(fakeBin, "gh"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });

  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  let allowedDirs = [tmpDir];
  const otherAllowedDir = path.join(tmpDir, "other-allowed");
  await fs.mkdir(otherAllowedDir, { recursive: true });
  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-sandbox-change",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => allowedDirs,
    machineName: "execute-sandbox-change-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000101";
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
          fullName: `sandbox/${path.basename(repoPath)}`,
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

  await waitForFile(claudeStartedMarker);
  allowedDirs = [otherAllowedDir];
  await fs.writeFile(claudeReleaseMarker, "release\n", "utf-8");

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  assert.equal(uploadBody.metadata?.executeFinalizationStatus, "skipped");
  assert.equal(uploadBody.metadata?.executeFinalizationPath, "none");
  assert.equal(
    uploadBody.metadata?.executeFinalizationReason,
    "worktree directory not allowed by current sandbox"
  );
  assert.equal(uploadBody.metadata?.branchName, undefined);
  assert.equal(uploadBody.artifacts?.executionResult, undefined);

  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);
  assert.equal(completedEvent.result?.executeFinalizationStatus, "skipped");
  assert.equal(completedEvent.result?.executeFinalizationPath, "none");
  assert.equal(
    completedEvent.result?.executeFinalizationReason,
    "worktree directory not allowed by current sandbox"
  );
  assert.equal(completedEvent.result?.branchName, undefined);
  assert.equal(await fs.readFile(gitCapture, "utf-8").catch(() => ""), "");
});

// ---------------------------------------------------------------------------
// Test 2: Pre-written execution-result.json (LLM path) → PR URL without
//         calling executeGitOperations
// ---------------------------------------------------------------------------

test("EXECUTE: handleProcessCompletion reads pre-written execution-result.json and returns PR URL", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-llmresult-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-llmresult");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 without making any changes
  // (attemptLlmCommit is called after this exits)
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude for attemptLlmCommit: writes a valid execution-result.json to $CLOSEDLOOP_WORKDIR
  // Then exits 0. attemptLlmCommit reads the file and returns the result.
  // Because execution-result.json is present and valid, executeGitOperations is never called.
  //
  // The worktree dir is the cwd when attemptLlmCommit spawns claude.
  // execution-result.json is expected at path.join(worktreeDir, "execution-result.json").
  const repoFullName = `llmresult/${path.basename(repoPath)}`;
  const expectedPrUrl = `https://github.com/${repoFullName}/pull/77`;
  const executionResultContent = JSON.stringify({
    prUrl: expectedPrUrl,
    prNumber: 77,
    branchName: "symphony/loop-test-branch",
    commitSha: "aabbccdd1122334455667788990011223344556677",
  });
  const claudeScript = [
    "#!/bin/sh",
    // Write execution-result.json relative to cwd (which is worktreeDir for attemptLlmCommit)
    `printf '%s' ${JSON.stringify(executionResultContent).replace(/'/g, String.raw`'\''`)} > execution-result.json`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), claudeScript, {
    mode: 0o755,
  });

  // fake git that stubs all commands (so executeGitOperations wouldn't fail if accidentally called)
  // We verify via upload payload that git ops were NOT needed.
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-llmresult-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000200";
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
          fullName: repoFullName,
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

  // Wait for upload — signals process completion including attemptLlmCommit
  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: {
      executionResult?: {
        schemaVersion?: number;
        results?: Array<{
          status: string;
          prUrl?: string;
          prNumber?: number;
          hasChanges?: boolean;
        }>;
      };
    };
    metadata: Record<string, unknown>;
  };

  const primary = uploadBody.artifacts.executionResult?.results?.[0];
  assert.equal(uploadBody.artifacts.executionResult?.schemaVersion, 2);
  assert.equal(primary?.status, "success");
  assert.equal(
    primary?.prUrl,
    expectedPrUrl,
    `Expected prUrl=${expectedPrUrl} from pre-written execution-result.json, got: ${String(primary?.prUrl)}`
  );
  assert.equal(primary?.prNumber, 77);
  assert.equal(primary?.hasChanges, true);
});

// ---------------------------------------------------------------------------
// Test 3: Existing PR via gh pr view → no gh pr create called
// ---------------------------------------------------------------------------

test("EXECUTE: uses existing PR URL from gh pr view without calling gh pr create", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-existingpr-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-existingpr");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: writes a file so the worktree has changes for git status
  await createFakeRunLoopScript(
    tmpDir,
    [
      "#!/bin/sh",
      // Write a file to create an uncommitted change
      "echo 'implement feature' > feature-output.txt",
      "exit 0",
    ].join("\n")
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude for attemptLlmCommit: exits 0 without writing execution-result.json
  // → attemptLlmCommit returns { status: "failed", reason: { kind: "other" }, logTail: "..." }
  // → falls through to executeGitOperations
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
    { mode: 0o755 }
  );

  // Capture file to record whether gh pr create was called
  const captureFile = path.join(tmpDir, "gh-calls.txt");

  const repoFullName = `existingpr/${path.basename(repoPath)}`;
  const expectedPrUrl = `https://github.com/${repoFullName}/pull/42`;

  // fake gh: pr view returns existing PR JSON; pr create records a call and exits 1
  const fakeGhScript = [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ]; then',
    `  printf '{"url":"${expectedPrUrl}","number":42}\\n'`,
    "  exit 0",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = create ]; then',
    `  echo "gh pr create was called (should not happen)" >> ${JSON.stringify(captureFile)}`,
    "  exit 1",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

  // fake git: stubs all commands without falling back to real git
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = status ]; then printf "M feature-output.txt\\n"; exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await withFakeShellPath(fakeBin, async () => {
    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);

    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getAllowedDirectories: () => [tmpDir],
      machineName: "execute-existingpr-machine",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      worktreeProvider: fakeWorktreeProvider,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
      getBinaryPaths: () => ({
        claude: path.join(fakeBin, "claude"),
        git: path.join(fakeBin, "git"),
        gh: path.join(fakeBin, "gh"),
      }),
    });
    serversToClose.push(server);
    await server.start();

    const loopId = "00000000-0000-0000-0000-000000000300";
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
            fullName: repoFullName,
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

    // Wait for upload — signals that git ops + PR lookup completed
    const uploadReq = await mock.waitForRequest("upload-artifacts");
    const uploadBody = JSON.parse(uploadReq.body) as {
      artifacts: {
        executionResult?: {
          schemaVersion?: number;
          results?: Array<{
            status: string;
            prUrl?: string;
            prNumber?: number;
          }>;
        };
      };
      metadata: Record<string, unknown>;
    };

    const primary = uploadBody.artifacts.executionResult?.results?.[0];
    assert.equal(uploadBody.artifacts.executionResult?.schemaVersion, 2);
    assert.equal(primary?.status, "success");
    assert.equal(
      primary?.prUrl,
      expectedPrUrl,
      `Expected existing PR URL in primary entry prUrl, got: ${String(primary?.prUrl)}`
    );
    assert.equal(primary?.prNumber, 42);

    // gh pr create must NOT have been called
    const ghCalls = await fs.readFile(captureFile, "utf-8").catch(() => "");
    assert.equal(
      ghCalls.trim(),
      "",
      `gh pr create should not have been called, but capture file contains: ${ghCalls}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4: git status exits 1 → executeGitOperations returns 'error' →
//         completed event warnings contains 'GIT_PUSH_FAILED'
// ---------------------------------------------------------------------------

test("EXECUTE: git status failure sets GIT_PUSH_FAILED in completed event warnings", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-gitstatus-fail-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-gitstatus-fail");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 (loop runs successfully, no LLM commits)
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude: exits 0 without writing execution-result.json
  // → attemptLlmCommit returns { status: "failed", reason: { kind: "other" }, logTail: "..." }
  // → falls through to executeGitOperations
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
    { mode: 0o755 }
  );

  // fake git: exits 1 for 'git status --porcelain' to simulate a git status failure.
  // This causes executeGitOperations to return { status: 'error' }, which adds
  // GIT_PUSH_FAILED to the warnings array posted in the completed event.
  // All other commands succeed without falling back to real git.
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 1; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-gitstatus-fail-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000400";
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
          fullName: `gitstatus-fail/${path.basename(repoPath)}`,
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

  // Wait for the completed event and assert GIT_PUSH_FAILED is in warnings.
  // The loop posts upload-artifacts first, then the completed event.
  await mock.waitForRequest("upload-artifacts", 60_000);
  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);
  const warnings = completedEvent.warnings as string[] | undefined;
  assert.ok(
    Array.isArray(warnings) && warnings.includes("GIT_PUSH_FAILED"),
    `Expected GIT_PUSH_FAILED in completed event warnings when git status exits 1, got warnings: ${JSON.stringify(warnings)}`
  );
});

test("EXECUTE: rehydrates aligned raw implementation plan state into a fresh worktree", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-rehydrate-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-rehydrate");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const rehydrateScript = [
    "#!/bin/sh",
    'cp "$CLOSEDLOOP_WORKDIR/plan.json" "$CLOSEDLOOP_WORKDIR/captured-plan.json"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, rehydrateScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(rehydrateScript),
    { mode: 0o755 }
  );
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, {
    mode: 0o755,
  });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-rehydrate",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-rehydrate-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000450";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: "Updated markdown",
            raw: {
              content: "Updated markdown",
              pendingTasks: ["task-1"],
              completedTasks: ["task-0"],
              openQuestions: ["question-1"],
            },
          },
        ],
        repo: {
          fullName: `rehydrate/${path.basename(repoPath)}`,
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

  const terminalJob = await waitForJobTerminal(jobStore, loopId);
  assert.equal(terminalJob.status, "COMPLETED");
  assert.ok(
    terminalJob.claudeWorkDir,
    "Expected claudeWorkDir on completed job"
  );

  const capturedPlan = JSON.parse(
    await fs.readFile(
      path.join(terminalJob.claudeWorkDir!, "captured-plan.json"),
      "utf-8"
    )
  ) as Record<string, unknown>;
  assert.equal(capturedPlan.content, "Updated markdown");
  assert.deepEqual(capturedPlan.pendingTasks, ["task-1"]);
  assert.deepEqual(capturedPlan.completedTasks, ["task-0"]);
  assert.deepEqual(capturedPlan.openQuestions, ["question-1"]);
});

test("EXECUTE: emits decision-table verifier telemetry from current-run JSONL", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-dt-telemetry-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-dt-telemetry");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const decisionTableScript = [
    "#!/bin/sh",
    'printf \'{"timestamp":"%s","workdir":"%s","decision_table_path":".closedloop-ai/decision-tables/pln-302.md","final_status":"aligned","iterations":3,"drift_kind_counts":{"code_drift":2,"test_drift":1,"plan_ambiguity":0},"fixes_attempted":3,"parse_failures":0,"verifier_invocations":3,"phase_duration_ms":58921}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CLOSEDLOOP_WORKDIR" >> "$CLOSEDLOOP_WORKDIR/decision-table-verifications.jsonl"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, decisionTableScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(decisionTableScript),
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(fakeBin, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = status ]; then exit 0; fi',
      'if [ "$1" = "rev-parse" ]; then echo "abc123"; exit 0; fi',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  Observability.init({
    telemetrySend: (event) => telemetryEvents.push(event),
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-dt-telemetry-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000452";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: "# Plan\n\n- Verify behavior",
          },
        ],
        repo: {
          fullName: `dt-telemetry/${path.basename(repoPath)}`,
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

  await mock.waitForRequest("upload-artifacts");

  const event = await waitForTelemetryCategory(
    telemetryEvents,
    "job.decision_table_verification",
    loopId
  );
  const diagnostic = event.diagnostics?.decisionTableVerification;
  assert.ok(diagnostic, "Expected decision-table diagnostics");
  assert.equal(diagnostic.telemetryStatus, "reported");
  if (diagnostic.telemetryStatus === "reported") {
    assert.equal(diagnostic.finalStatus, "aligned");
    assert.equal(
      diagnostic.decisionTablePath,
      ".closedloop-ai/decision-tables/pln-302.md"
    );
    assert.equal(diagnostic.iterations, 3);
    assert.equal(diagnostic.driftKindCounts.codeDrift, 2);
    assert.equal(diagnostic.driftKindCounts.testDrift, 1);
    assert.equal(diagnostic.fixesAttempted, 3);
    assert.equal(diagnostic.parseFailures, 0);
    assert.equal(diagnostic.verifierInvocations, 3);
    assert.equal(diagnostic.phaseDurationMs, 58_921);
  }
});

test("EXECUTE: fresh worktree without raw plan stages plan.md and passes CLOSEDLOOP_PLAN_FILE", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-source-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-source");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const loopId = "00000000-0000-0000-0000-000000000451";
  const worktreeDir = resolveExecuteWorktreeDir(
    worktreeParent,
    repoPath,
    loopId
  );
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");

  const planSourceScript = [
    "#!/bin/sh",
    'printf "%s" "$CLOSEDLOOP_PLAN_FILE" > "$CLOSEDLOOP_WORKDIR/captured-plan-file.txt"',
    'if [ -e "$CLOSEDLOOP_WORKDIR/plan.json" ]; then echo "present" > "$CLOSEDLOOP_WORKDIR/prewritten-plan-json.txt"; fi',
    'cp "$CLOSEDLOOP_PLAN_FILE" "$CLOSEDLOOP_WORKDIR/captured-plan-source.md"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, planSourceScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(planSourceScript),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-source-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  Observability.init({
    telemetrySend: (event) => telemetryEvents.push(event),
  });

  const sourceMarkdown = "# Fresh plan\n\n- staged from markdown";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: sourceMarkdown,
          },
        ],
        repo: {
          fullName: `plan-source/${path.basename(repoPath)}`,
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

  await mock.waitForRequest("upload-artifacts");

  const planSourceEvent = telemetryEvents.find(
    (event) =>
      event.category === "job.plan_source_resolved" &&
      event.trace?.loopId === loopId
  );
  assert.ok(planSourceEvent, "Expected plan source telemetry to be emitted");
  const planSource = planSourceEvent.diagnostics?.planSource;
  assert.ok(planSource, "Expected plan source diagnostics to be present");
  assert.equal(planSource.source, "imported-plan-compat");
  assert.equal(planSource.rawPlanPayload, false);
  assert.equal(planSource.rawPlanAligned, false);
  assert.equal(planSource.localPlanJsonPresent, false);
  assert.equal(planSource.localPlanJsonAligned, false);
  assert.equal(planSource.importedPlanFileStaged, true);
  assert.equal(planSource.closedLoopPlanFileSet, true);
  assert.equal(planSource.planArtifactContentLength, sourceMarkdown.length);
  assert.equal(planSource.rawPlanContentLength, null);
  assert.equal(planSource.rawPlanContentHash, null);
  assert.match(planSource.planArtifactContentHash ?? "", /^[a-f0-9]{12}$/);

  const capturedPlanFile = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-file.txt"),
    "utf-8"
  );
  assert.equal(
    await fs.realpath(capturedPlanFile.trim()),
    await fs.realpath(path.join(claudeWorkDir, "imported-plan.md")),
    `Expected CLOSEDLOOP_PLAN_FILE to point at imported-plan.md, got: ${capturedPlanFile}`
  );

  const capturedPlanSource = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-source.md"),
    "utf-8"
  );
  assert.equal(
    capturedPlanSource,
    sourceMarkdown,
    "Expected run-loop to read the staged markdown source file"
  );

  const prewrittenPlanJson = await fs
    .readFile(path.join(claudeWorkDir, "prewritten-plan-json.txt"), "utf-8")
    .catch(() => "");
  assert.equal(
    prewrittenPlanJson,
    "",
    "Expected plan.json to stay absent before run-loop starts"
  );
});

test("EXECUTE: imported-plan failure still uploads the staged plan artifact", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-failure-upload-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-failure-upload");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 1\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-failure-upload-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000454";
  const sourceMarkdown = "# Hosted plan for failure upload\n\n- preserve me";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: sourceMarkdown,
          },
        ],
        repo: {
          fullName: `plan-failure-upload/${path.basename(repoPath)}`,
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

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts?: {
      plan?: {
        content?: string;
        raw?: Record<string, unknown>;
      };
    };
  };
  assert.deepEqual(uploadBody.artifacts?.plan, {
    content: sourceMarkdown,
  });

  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(terminalEvent.type, "error");
});

test("EXECUTE: remote raw plan payload wins over existing local plan.json", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-priority-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-priority");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const loopId = "00000000-0000-0000-0000-000000000452";
  const worktreeDir = resolveExecuteWorktreeDir(
    worktreeParent,
    repoPath,
    loopId
  );
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const localPlan = {
    title: "Local plan",
    content: "# Local plan\n\n- staged locally",
    source: "local",
    tasks: [
      {
        id: "local-task",
        title: "Local task",
        description: "local description",
      },
    ],
  };
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify(localPlan, null, 2)
  );

  const planPriorityScript = [
    "#!/bin/sh",
    'printf "%s" "$CLOSEDLOOP_PLAN_FILE" > "$CLOSEDLOOP_WORKDIR/captured-plan-file.txt"',
    'if [ -e "$CLOSEDLOOP_WORKDIR/imported-plan.md" ]; then echo "present" > "$CLOSEDLOOP_WORKDIR/imported-plan-marker.txt"; fi',
    'cp "$CLOSEDLOOP_WORKDIR/plan.json" "$CLOSEDLOOP_WORKDIR/captured-plan.json"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, planPriorityScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(planPriorityScript),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-priority-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const rawPlan = {
    title: "Raw plan",
    content: "# Raw plan\n\n- staged from raw payload",
    source: "raw",
    tasks: [
      {
        id: "raw-task",
        title: "Raw task",
        description: "raw description",
      },
    ],
  };

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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: rawPlan.content,
            raw: rawPlan,
          },
        ],
        repo: {
          fullName: `plan-priority/${path.basename(repoPath)}`,
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

  await mock.waitForRequest("upload-artifacts");

  const capturedPlanFile = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-file.txt"),
    "utf-8"
  );
  assert.equal(
    capturedPlanFile.trim(),
    "",
    `Expected CLOSEDLOOP_PLAN_FILE to be empty when a local plan.json is reused, got: ${capturedPlanFile}`
  );

  const importedPlanMarker = await fs
    .readFile(path.join(claudeWorkDir, "imported-plan-marker.txt"), "utf-8")
    .catch(() => "");
  assert.equal(
    importedPlanMarker,
    "",
    "Expected no imported-plan.md source file when aligned remote raw is reused"
  );

  const capturedPlan = JSON.parse(
    await fs.readFile(path.join(claudeWorkDir, "captured-plan.json"), "utf-8")
  ) as Record<string, unknown>;
  assert.equal(
    capturedPlan.source,
    "raw",
    "Expected aligned remote raw plan state to overwrite stale local plan.json"
  );
  assert.equal(
    capturedPlan.content,
    rawPlan.content,
    "Expected plan.json content to come from the hosted/remote artifact"
  );
});

test("EXECUTE: missing raw payload keeps matching local plan.json", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-local-match-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-local-match");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const loopId = "00000000-0000-0000-0000-000000000455";
  const worktreeDir = resolveExecuteWorktreeDir(
    worktreeParent,
    repoPath,
    loopId
  );
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const hostedMarkdown = "# Hosted plan\n\n- unchanged markdown";
  const localPlan = {
    title: "Local plan",
    content: hostedMarkdown,
    source: "local",
    tasks: [
      {
        id: "local-task",
        title: "Local task",
        description: "local description",
      },
    ],
  };
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify(localPlan, null, 2)
  );

  const localMatchScript = [
    "#!/bin/sh",
    'printf "%s" "$CLOSEDLOOP_PLAN_FILE" > "$CLOSEDLOOP_WORKDIR/captured-plan-file.txt"',
    'if [ -e "$CLOSEDLOOP_WORKDIR/imported-plan.md" ]; then echo "present" > "$CLOSEDLOOP_WORKDIR/imported-plan-marker.txt"; fi',
    'cp "$CLOSEDLOOP_WORKDIR/plan.json" "$CLOSEDLOOP_WORKDIR/captured-plan.json"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, localMatchScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(localMatchScript),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-local-match-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
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
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: hostedMarkdown,
          },
        ],
        repo: {
          fullName: `plan-local-match/${path.basename(repoPath)}`,
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

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts?: {
      plan?: {
        content?: string;
        raw?: Record<string, unknown>;
      };
    };
  };

  const capturedPlanFile = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-file.txt"),
    "utf-8"
  );
  assert.equal(
    capturedPlanFile.trim(),
    "",
    `Expected CLOSEDLOOP_PLAN_FILE to be empty when matching local plan.json is reused, got: ${capturedPlanFile}`
  );

  const importedPlanMarker = await fs
    .readFile(path.join(claudeWorkDir, "imported-plan-marker.txt"), "utf-8")
    .catch(() => "");
  assert.equal(
    importedPlanMarker,
    "",
    "Expected no imported-plan.md source file when matching local plan.json is reused"
  );

  const capturedPlan = JSON.parse(
    await fs.readFile(path.join(claudeWorkDir, "captured-plan.json"), "utf-8")
  ) as Record<string, unknown>;
  assert.equal(capturedPlan.source, "local");
  assert.equal(capturedPlan.content, hostedMarkdown);
  assert.equal(uploadBody.artifacts?.plan?.content, hostedMarkdown);
  assert.equal(uploadBody.artifacts?.plan?.raw?.source, "local");
});

test("EXECUTE: missing raw payload removes mismatched local plan.json", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-local-mismatch-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-local-mismatch");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const loopId = "00000000-0000-0000-0000-000000000456";
  const worktreeDir = resolveExecuteWorktreeDir(
    worktreeParent,
    repoPath,
    loopId
  );
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify(
      {
        title: "Local stale plan",
        content: "# Local stale plan\n\n- local snapshot",
        source: "local",
      },
      null,
      2
    )
  );

  const localMismatchScript = [
    "#!/bin/sh",
    'printf "%s" "$CLOSEDLOOP_PLAN_FILE" > "$CLOSEDLOOP_WORKDIR/captured-plan-file.txt"',
    'if [ -e "$CLOSEDLOOP_WORKDIR/plan.json" ]; then echo "present" > "$CLOSEDLOOP_WORKDIR/prewritten-plan-json.txt"; fi',
    'cp "$CLOSEDLOOP_PLAN_FILE" "$CLOSEDLOOP_WORKDIR/captured-plan-source.md"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, localMismatchScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(localMismatchScript),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-local-mismatch-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const hostedMarkdown = "# Hosted plan\n\n- latest markdown";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: hostedMarkdown,
          },
        ],
        repo: {
          fullName: `plan-local-mismatch/${path.basename(repoPath)}`,
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

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts?: {
      plan?: {
        content?: string;
        raw?: Record<string, unknown>;
      };
    };
  };

  const capturedPlanFile = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-file.txt"),
    "utf-8"
  );
  assert.equal(
    await fs.realpath(capturedPlanFile.trim()),
    await fs.realpath(path.join(claudeWorkDir, "imported-plan.md")),
    `Expected mismatched local plan.json to fall back to imported-plan.md, got: ${capturedPlanFile}`
  );

  const capturedPlanSource = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-source.md"),
    "utf-8"
  );
  assert.equal(
    capturedPlanSource,
    hostedMarkdown,
    "Expected mismatched local fallback to use the hosted markdown content"
  );

  const prewrittenPlanJson = await fs
    .readFile(path.join(claudeWorkDir, "prewritten-plan-json.txt"), "utf-8")
    .catch(() => "");
  assert.equal(
    prewrittenPlanJson,
    "",
    "Expected mismatched local plan.json to be removed before imported-plan execution starts"
  );
  assert.deepEqual(uploadBody.artifacts?.plan, {
    content: hostedMarkdown,
  });
});

test("EXECUTE: stale raw plan state falls back to imported-plan compatibility", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-plan-stale-raw-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-plan-stale-raw");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const loopId = "00000000-0000-0000-0000-000000000453";
  const worktreeDir = resolveExecuteWorktreeDir(
    worktreeParent,
    repoPath,
    loopId
  );
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify(
      {
        title: "Local stale plan",
        content: "# Local stale plan\n\n- local snapshot",
        source: "local",
      },
      null,
      2
    )
  );

  const staleRawScript = [
    "#!/bin/sh",
    'printf "%s" "$CLOSEDLOOP_PLAN_FILE" > "$CLOSEDLOOP_WORKDIR/captured-plan-file.txt"',
    'if [ -e "$CLOSEDLOOP_WORKDIR/plan.json" ]; then echo "present" > "$CLOSEDLOOP_WORKDIR/prewritten-plan-json.txt"; fi',
    'cp "$CLOSEDLOOP_PLAN_FILE" "$CLOSEDLOOP_WORKDIR/captured-plan-source.md"',
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, staleRawScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(staleRawScript),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-plan-stale-raw-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const hostedMarkdown = "# Hosted plan\n\n- latest markdown";
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
        artifacts: [
          {
            type: "IMPLEMENTATION_PLAN",
            content: hostedMarkdown,
            raw: {
              content: "# Older raw snapshot\n\n- stale structure",
              source: "raw",
            },
          },
        ],
        repo: {
          fullName: `plan-stale-raw/${path.basename(repoPath)}`,
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

  await mock.waitForRequest("upload-artifacts");

  const capturedPlanFile = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-file.txt"),
    "utf-8"
  );
  assert.equal(
    await fs.realpath(capturedPlanFile.trim()),
    await fs.realpath(path.join(claudeWorkDir, "imported-plan.md")),
    `Expected stale raw state to fall back to imported-plan.md, got: ${capturedPlanFile}`
  );

  const capturedPlanSource = await fs.readFile(
    path.join(claudeWorkDir, "captured-plan-source.md"),
    "utf-8"
  );
  assert.equal(
    capturedPlanSource,
    hostedMarkdown,
    "Expected stale raw fallback to use the hosted markdown content"
  );

  const prewrittenPlanJson = await fs
    .readFile(path.join(claudeWorkDir, "prewritten-plan-json.txt"), "utf-8")
    .catch(() => "");
  assert.equal(
    prewrittenPlanJson,
    "",
    "Expected stale local plan.json to be removed before imported-plan execution starts"
  );
});

test("EXECUTE: non-cancelled failure uploads current plan state before posting the error event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-fail-upload-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-fail-upload");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const failureUploadScript = [
    "#!/bin/sh",
    `printf '%s' '${JSON.stringify({
      content: "Plan content",
      pendingTasks: ["task-1"],
    }).replace(/'/g, String.raw`'\''`)}' > "$CLOSEDLOOP_WORKDIR/plan.json"`,
    `printf '%s' '${JSON.stringify({ score: 0.5 }).replace(/'/g, String.raw`'\''`)}' > "$CLOSEDLOOP_WORKDIR/code-judges.json"`,
    "exit 1",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, failureUploadScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), failureUploadScript, {
    mode: 0o755,
  });
  await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-fail-upload",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-fail-upload-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000451";
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
          fullName: `fail-upload/${path.basename(repoPath)}`,
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

  const terminalJob = await waitForJobTerminal(jobStore, loopId);
  assert.equal(terminalJob.status, "FAILED");
  assert.ok(
    terminalJob.artifactsUploadedAt,
    "Expected artifactsUploadedAt to persist after failure upload"
  );

  const uploadRequest = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadRequest.body) as {
    artifacts: {
      plan?: Record<string, unknown>;
      codeJudges?: Record<string, unknown>;
    };
  };
  assert.deepEqual(uploadBody.artifacts.plan, {
    content: "Plan content",
    raw: {
      content: "Plan content",
      pendingTasks: ["task-1"],
    },
  });
  assert.deepEqual(uploadBody.artifacts.codeJudges, { score: 0.5 });

  const uploadIndex = mock.requests.findIndex((request) =>
    request.url.includes("upload-artifacts")
  );
  const errorEventIndex = mock.requests.findIndex((request) => {
    if (!request.url.includes(`/loops/${loopId}/events`)) {
      return false;
    }
    try {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      return body.type === "error";
    } catch {
      return false;
    }
  });
  assert.ok(uploadIndex !== -1, "Expected upload-artifacts request");
  assert.ok(errorEventIndex !== -1, "Expected error event request");
  assert.ok(
    uploadIndex < errorEventIndex,
    `Expected artifact upload before error event, got uploadIndex=${uploadIndex} errorEventIndex=${errorEventIndex}`
  );
});

// ---------------------------------------------------------------------------
// Cancellation gate helpers
// ---------------------------------------------------------------------------

/**
 * Poll a JobStore until the job for the given loopId reaches a terminal status,
 * or until the timeout elapses.
 */
async function waitForJobTerminal(
  jobStore: JobStore,
  loopId: string,
  timeoutMs = 20_000
): Promise<import("../src/main/job-store.js").LocalJob> {
  const terminalStatuses = new Set([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "STOPPED",
    "UNKNOWN",
  ]);
  const deadline = Date.now() + timeoutMs;
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

/**
 * Poll a JobStore until the job for the given loopId has status RUNNING.
 */
async function waitForJobRunning(
  jobStore: JobStore,
  loopId: string,
  timeoutMs = 10_000
): Promise<import("../src/main/job-store.js").LocalJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobStore.getByLoopId(loopId);
    if (job && job.status === "RUNNING") {
      return job;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for RUNNING job for loopId=${loopId} after ${timeoutMs}ms`
  );
}

// ---------------------------------------------------------------------------
// Test 5: Cancellation gate — cancel before attemptLlmCommit (gate 1)
//         CANCEL_PENDING is set while run-loop.sh is still running.
//         When the process exits, isCancelled() returns true before
//         attemptLlmCommit is called → no upload, no completed event.
// ---------------------------------------------------------------------------

test("EXECUTE: cancel before attemptLlmCommit ends job as CANCELLED with no upload or completed event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-cancel-gate1-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-cancel-gate1");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: sleep so the test can set CANCEL_PENDING before exit
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nsleep 2\nexit 0\n");

  // fake-bin: claude exits 0 (won't be called — gate 1 catches before attemptLlmCommit)
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-cancel-gate1",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-cancel-gate1-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000700";
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
          fullName: `cancel-gate1/${path.basename(repoPath)}`,
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

  // Wait for the job to appear as RUNNING, then set CANCEL_PENDING.
  // run-loop.sh is sleeping for 2s, so this fires well before it exits.
  const runningJob = await waitForJobRunning(jobStore, loopId);
  jobStore.upsert({
    ...runningJob,
    status: "CANCEL_PENDING",
    updatedAt: new Date().toISOString(),
  });

  // Wait for the job to reach terminal state (CANCELLED via gate 1)
  const terminalJob = await waitForJobTerminal(jobStore, loopId);
  assert.equal(
    terminalJob.status,
    "CANCELLED",
    `Expected job status CANCELLED, got: ${terminalJob.status}`
  );

  // Verify no upload-artifacts request was made
  const uploadRequests = mock.requests.filter((r) =>
    r.url.includes("upload-artifacts")
  );
  assert.equal(
    uploadRequests.length,
    0,
    `Expected no upload-artifacts requests when cancelled before attemptLlmCommit, got ${uploadRequests.length}`
  );

  // Verify no completed event was posted
  const eventsUrl = `/loops/${loopId}/events`;
  const completedEvents = mock.requests.filter((r) => {
    if (!r.url.includes(eventsUrl)) {
      return false;
    }
    try {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      return body.type === "completed";
    } catch {
      return false;
    }
  });
  assert.equal(
    completedEvents.length,
    0,
    `Expected no completed event when cancelled before attemptLlmCommit, got ${completedEvents.length}`
  );
});

// ---------------------------------------------------------------------------
// Test 6: Cancellation gate — cancel during attemptLlmCommit (gate 2)
//         run-loop.sh exits immediately (gate 1 passes — not cancelled yet).
//         The fake claude binary sleeps so CANCEL_PENDING can be set while
//         attemptLlmCommit is awaiting. After claude exits, gate 2 fires.
// ---------------------------------------------------------------------------

test("EXECUTE: cancel during attemptLlmCommit ends job as CANCELLED with no completed event", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-cancel-gate2-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-cancel-gate2");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits immediately so gate 1 passes (not yet cancelled)
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  // fake-bin: claude creates a marker file on entry then sleeps, so the test
  // can poll the marker to detect when attemptLlmCommit has been entered.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const claudeStartedMarker = path.join(tmpDir, "claude-started");
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    `#!/bin/sh\ntouch ${claudeStartedMarker}\nsleep 3\nexit 0\n`,
    { mode: 0o755 }
  );

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-cancel-gate2",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-cancel-gate2-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000800";
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
          fullName: `cancel-gate2/${path.basename(repoPath)}`,
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

  // Wait for the job to appear as RUNNING
  await waitForJobRunning(jobStore, loopId);

  // Wait for the fake claude binary to start (marker file created on entry).
  // This proves gate 1 passed and attemptLlmCommit has been entered.
  const markerDeadline = Date.now() + 15_000;
  while (Date.now() < markerDeadline) {
    try {
      await fs.access(claudeStartedMarker);
      break;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  await fs.access(claudeStartedMarker); // throws if still missing

  // Set CANCEL_PENDING now. Gate 1 has already passed.
  // Claude is sleeping for 3s, so gate 2 hasn't run yet.
  const currentJob = jobStore.getByLoopId(loopId)!;
  jobStore.upsert({
    ...currentJob,
    status: "CANCEL_PENDING",
    updatedAt: new Date().toISOString(),
  });

  // Wait for terminal state — gate 2 fires after claude exits
  const terminalJob = await waitForJobTerminal(jobStore, loopId);
  assert.equal(
    terminalJob.status,
    "CANCELLED",
    `Expected job status CANCELLED, got: ${terminalJob.status}`
  );

  // Verify no completed event was posted
  const eventsUrl = `/loops/${loopId}/events`;
  const completedEvents = mock.requests.filter((r) => {
    if (!r.url.includes(eventsUrl)) {
      return false;
    }
    try {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      return body.type === "completed";
    } catch {
      return false;
    }
  });
  assert.equal(
    completedEvents.length,
    0,
    `Expected no completed event when cancelled during attemptLlmCommit, got ${completedEvents.length}`
  );
});

// ---------------------------------------------------------------------------
// Test 8 (T-1.3): Artifact links use /implementation-plans/ path in both the
//         SAFETY commit PR body and the LLM commit prompt footer.
//
// The fake gh binary captures --body-file content.
// The fake claude binary captures its -p argument to a file (then exits without
// writing execution-result.json so the code falls through to executeGitOperations).
// Both captures are asserted to contain /implementation-plans/ and not to
// contain /artifact/by-slug/.
// ---------------------------------------------------------------------------

test("EXECUTE: artifact links use /implementation-plans/ in PR body and LLM prompt footer", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-artifactlink-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-artifactlink");
  await initGitRepo(repoPath);

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const claudePromptCapture = path.join(tmpDir, "claude-prompt-capture.txt");
  const ghBodyCapture = path.join(tmpDir, "gh-body-capture.txt");

  // The first fake Claude invocation represents the native prompt command. The
  // second invocation represents LLM finalization and creates the git change.
  const artifactLinkScript = [
    "#!/bin/sh",
    "prev=''",
    'for arg in "$@"; do',
    '  if [ "$prev" = "-p" ]; then',
    `    printf '%s' "$arg" > ${JSON.stringify(claudePromptCapture)}`,
    "  fi",
    '  prev="$arg"',
    "done",
    "echo 'feature output' > feature-output.txt",
    "exit 0",
  ].join("\n");

  // No run-loop.sh: a present run-loop.sh would trip the legacy-plugin bridge
  // and flip EXECUTE off the native launcher, so the LLM-finalization -p prompt
  // (which carries the artifact footer) would never be produced.
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(artifactLinkScript),
    { mode: 0o755 }
  );

  // fake git: pass through all real git operations; stub push to avoid remote requirement
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = push ]; then exit 0; fi',
    `exec /usr/bin/git "$@"`,
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  // fake gh: capture --body-file content to ghBodyCapture.
  // pr view (existing-PR check) exits non-zero so code proceeds to gh pr create.
  // pr view --json body returns empty body so the metadata-footer update is a no-op.
  const fakeGhScript = [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" != "--json" ]; then',
    "  exit 1",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" = "--json" ]; then',
    '  printf \'{"body":""}\\n\'',
    "  exit 0",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = create ]; then',
    "  prev=''",
    '  for arg in "$@"; do',
    '    if [ "$prev" = "--body-file" ] && [ -f "$arg" ]; then',
    `      cp "$arg" ${JSON.stringify(ghBodyCapture)}`,
    "    fi",
    '    prev="$arg"',
    "  done",
    "  printf 'https://github.com/org/repo-artifactlink/pull/99\\n'",
    "  exit 0",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = edit ]; then',
    "  exit 0",
    "fi",
    `exec /usr/bin/gh "$@" 2>/dev/null || true`,
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

  // Reset cached claude path and shell PATH so this test's fake-bin is used
  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-artifactlink-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getBinaryPaths: () => ({
      claude: path.join(fakeBin, "claude"),
      git: path.join(fakeBin, "git"),
      gh: path.join(fakeBin, "gh"),
    }),
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000001000";
  const artifactSlug = "PLAN-42";
  const repoFullName = `artifactlink/${path.basename(repoPath)}`;
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
        artifactSlug,
        repo: { fullName: repoFullName, branch: "main" },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for upload to confirm the flow completed
  await mock.waitForRequest("upload-artifacts");

  // Assert the LLM prompt footer contains /implementation-plans/ and not /artifact/by-slug/
  const capturedPrompt = await fs
    .readFile(claudePromptCapture, "utf-8")
    .catch(() => "");
  assert.ok(
    capturedPrompt.includes("/implementation-plans/"),
    `Expected LLM prompt footer to contain /implementation-plans/, got prompt (tail): ${capturedPrompt.slice(-500)}`
  );
  assert.ok(
    !capturedPrompt.includes("/artifact/by-slug/"),
    `Expected LLM prompt to NOT contain /artifact/by-slug/, but it does. Prompt (tail): ${capturedPrompt.slice(-500)}`
  );

  // Assert the SAFETY commit PR body also contains /implementation-plans/ and not /artifact/by-slug/
  const capturedBody = await fs
    .readFile(ghBodyCapture, "utf-8")
    .catch(() => "");
  assert.ok(
    capturedBody.includes("/implementation-plans/"),
    `Expected SAFETY PR body to contain /implementation-plans/, got body: ${capturedBody}`
  );
  assert.ok(
    !capturedBody.includes("/artifact/by-slug/"),
    `Expected SAFETY PR body to NOT contain /artifact/by-slug/, but it does. Body: ${capturedBody}`
  );
});

// ---------------------------------------------------------------------------
// Test 9 (T-2.3): SAFETY commit PR title format is
//         "<artifactSlug>: Automated changes from loop <shortId>"
//         and does NOT contain the old 'Symphony: EXECUTE' substring.
// ---------------------------------------------------------------------------

test("EXECUTE: SAFETY commit PR title uses '<slug>: Automated changes from loop <shortId>' format", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-prtitle-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-prtitle");
  await initGitRepo(repoPath);

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  const prTitleScript = [
    "#!/bin/sh",
    "echo 'implementation output' > impl.txt",
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, prTitleScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(prTitleScript),
    { mode: 0o755 }
  );

  // Capture file for the gh pr create --title argument
  const ghTitleCapture = path.join(tmpDir, "gh-title-capture.txt");

  // fake git: stub push; delegate everything else to real git
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = push ]; then exit 0; fi',
    `exec /usr/bin/git "$@"`,
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  // fake gh: capture --title argument; return a fake PR URL from pr create;
  // return non-zero for pr view (no existing PR) so pr create is called;
  // return empty body for pr view --json body to skip the footer-update step.
  const fakeGhScript = [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" != "--json" ]; then',
    "  exit 1",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" = "--json" ]; then',
    '  printf \'{"body":""}\\n\'',
    "  exit 0",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = create ]; then',
    "  prev=''",
    '  for arg in "$@"; do',
    '    if [ "$prev" = "--title" ]; then',
    `      printf '%s' "$arg" > ${JSON.stringify(ghTitleCapture)}`,
    "    fi",
    '    prev="$arg"',
    "  done",
    "  printf 'https://github.com/org/repo-prtitle/pull/55\\n'",
    "  exit 0",
    "fi",
    'if [ "$1" = pr ] && [ "$2" = edit ]; then',
    "  exit 0",
    "fi",
    `exec /usr/bin/gh "$@" 2>/dev/null || true`,
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-prtitle-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000001100";
  const artifactSlug = "PLAN-55";
  const shortId = loopId.slice(0, 8); // "00000000"
  const repoFullName = `prtitle/${path.basename(repoPath)}`;

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
        artifactSlug,
        repo: { fullName: repoFullName, branch: "main" },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for the upload to confirm git operations completed
  await mock.waitForRequest("upload-artifacts");

  const capturedTitle = await fs
    .readFile(ghTitleCapture, "utf-8")
    .catch(() => "");

  // Assert the title matches the expected format:
  // "<artifactSlug>: Automated changes from loop <shortId>"
  const expectedTitle = `${artifactSlug}: Automated changes from loop ${shortId}`;
  assert.equal(
    capturedTitle,
    expectedTitle,
    `Expected PR title "${expectedTitle}", got "${capturedTitle}"`
  );

  // Assert the old 'Symphony: EXECUTE' format is NOT used
  assert.ok(
    !capturedTitle.includes("Symphony: EXECUTE"),
    `PR title must not contain 'Symphony: EXECUTE', got: "${capturedTitle}"`
  );
});

// ---------------------------------------------------------------------------
// Test 10 (T-3.3): LLM commit spawn correctness
//   - spawn uses the resolved absolute binary path (not bare 'claude' string)
//   - assertPathAllowed is called before spawn (evidenced by the spawn succeeding
//     when worktreeDir is within allowed directories)
//   - PID is written atomically (process.pid exists and .pid.tmp is cleaned up)
// ---------------------------------------------------------------------------

test("EXECUTE: LLM commit spawns claude via resolved absolute path and writes PID atomically", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-llmspawn-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-llmspawn");
  await initGitRepo(repoPath);

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // Capture paths
  const claudeArgvCapture = path.join(tmpDir, "claude-argv-capture.txt");
  const claudeBinaryCapture = path.join(tmpDir, "claude-binary-capture.txt");

  const llmSpawnScript = [
    "#!/bin/sh",
    `printf '%s' "$0" > ${JSON.stringify(claudeBinaryCapture)}`,
    `printf '%s\\n' "$@" > ${JSON.stringify(claudeArgvCapture)}`,
    "exit 0",
  ].join("\n");
  await createFakeRunLoopScript(tmpDir, llmSpawnScript);

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(llmSpawnScript),
    { mode: 0o755 }
  );

  // fake git: stub push; pass everything else to real git
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = push ]; then exit 0; fi',
    `exec /usr/bin/git "$@"`,
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  // fake gh: return non-zero for pr view so SAFETY path tries to create
  // but return non-zero for create too — we don't need a real PR since the test
  // only asserts on the LLM spawn behaviour (claude exits without result file,
  // executeGitOperations runs, git status returns empty because run-loop.sh
  // made no changes, so no-changes path is taken — no gh calls needed).
  await fs.writeFile(path.join(fakeBin, "gh"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });

  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({ cwd: tmpDir, name: "test-jobs-llmspawn" });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-llmspawn-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000001200";
  const repoFullName = `llmspawn/${path.basename(repoPath)}`;
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
        repo: { fullName: repoFullName, branch: "main" },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for the upload to confirm the full post-processing pipeline ran
  await mock.waitForRequest("upload-artifacts");

  // --- Assert 1: claude was spawned with the resolved absolute binary path ---
  // The fake claude writes $0 (its own path as seen by the OS) to claudeBinaryCapture.
  // When spawned via the absolute path the value will be the full path under fakeBin.
  // If the code fell back to bare 'claude' it would just be 'claude'.
  const capturedBinary = await fs
    .readFile(claudeBinaryCapture, "utf-8")
    .catch(() => "");
  assert.ok(
    capturedBinary.startsWith("/"),
    `Expected claude binary path to be absolute (starts with '/'), got: "${capturedBinary}"`
  );
  assert.ok(
    capturedBinary.includes(fakeBin),
    `Expected claude binary path to be under fakeBin (${fakeBin}), got: "${capturedBinary}"`
  );

  // --- Assert 2: spawn received -p as first argument (correct arg format) ---
  const capturedArgv = await fs
    .readFile(claudeArgvCapture, "utf-8")
    .catch(() => "");
  assert.ok(
    capturedArgv.startsWith("-p\n"),
    `Expected first captured arg to be '-p', got argv (head): "${capturedArgv.slice(0, 100)}"`
  );

  // --- Assert 3: PID written atomically (process.pid exists, .pid.tmp cleaned up) ---
  // The PID file is written inside claudeWorkDir = worktreeDir/.claude/work
  // We don't know the exact worktreeDir, but we can get it from the job store.
  const job = jobStore.getByLoopId(loopId);
  assert.ok(job, "Expected job to exist in store after completion");

  const claudeWorkDir = job!.claudeWorkDir;
  assert.ok(claudeWorkDir, "Expected claudeWorkDir to be set on job");

  const pidFilePath = path.join(claudeWorkDir!, "process.pid");
  const pidTmpPath = path.join(claudeWorkDir!, "process.pid.tmp");

  // process.pid should exist and contain a numeric PID
  const pidContent = await fs.readFile(pidFilePath, "utf-8").catch(() => "");
  assert.ok(
    /^\d+$/.test(pidContent.trim()),
    `Expected process.pid to contain a numeric PID, got: "${pidContent}"`
  );

  // process.pid.tmp should NOT exist — the atomic rename should have moved it
  let tmpExists = false;
  try {
    await fs.access(pidTmpPath);
    tmpExists = true;
  } catch {
    // Expected: file does not exist
  }
  assert.ok(
    !tmpExists,
    "Expected process.pid.tmp to be cleaned up after atomic rename, but it still exists"
  );
});

// ---------------------------------------------------------------------------
// Test 7: Non-zero exit with CANCEL_PENDING — PROCESS_FAILED event skipped
//         run-loop.sh sleeps then exits with code 1. CANCEL_PENDING is set
//         while it sleeps. The non-zero exit path detects wasCancelled and
//         skips the PROCESS_FAILED error event. Job ends as CANCELLED.
// ---------------------------------------------------------------------------

test("EXECUTE: non-zero exit with CANCEL_PENDING skips PROCESS_FAILED and ends as CANCELLED", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-cancel-nonzero-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-cancel-nonzero");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: sleep then exit with non-zero code
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nsleep 2\nexit 1\n");

  // fake-bin: claude exits 0 (won't be called — non-zero exit path skips attemptLlmCommit)
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const jobStore = new JobStore({
    cwd: tmpDir,
    name: "test-jobs-cancel-nonzero",
  });

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-cancel-nonzero-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    jobStore,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000900";
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
          fullName: `cancel-nonzero/${path.basename(repoPath)}`,
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

  // Wait for the job to appear as RUNNING, then set CANCEL_PENDING.
  // run-loop.sh is sleeping for 2s, so this fires well before it exits.
  const runningJob = await waitForJobRunning(jobStore, loopId);
  jobStore.upsert({
    ...runningJob,
    status: "CANCEL_PENDING",
    updatedAt: new Date().toISOString(),
  });

  // Wait for the job to reach terminal state
  const terminalJob = await waitForJobTerminal(jobStore, loopId);
  assert.equal(
    terminalJob.status,
    "CANCELLED",
    `Expected job status CANCELLED (not FAILED), got: ${terminalJob.status}`
  );

  // Verify no PROCESS_FAILED error event was posted
  const eventsUrl = `/loops/${loopId}/events`;
  const errorEvents = mock.requests.filter((r) => {
    if (!r.url.includes(eventsUrl)) {
      return false;
    }
    try {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      return body.type === "error" && body.code === "PROCESS_FAILED";
    } catch {
      return false;
    }
  });
  assert.equal(
    errorEvents.length,
    0,
    `Expected no PROCESS_FAILED event when cancelled, got ${errorEvents.length}`
  );
});

// ---------------------------------------------------------------------------
// Shared helper for the three "attemptLlmCommit fails → git fallback" tests
// below. The only things that vary across them are the prefix used for tmp
// directories and repo paths, the fake `claude` binary body (which decides
// HOW the LLM commit fails), the loopId, the PR number, and the rev-parse
// SHA. Everything else (fake run-loop.sh, fake gh, fake git, request body,
// assertions on git-fallback finalization) is identical.
// ---------------------------------------------------------------------------

async function runLlmFallbackTest(opts: {
  tmpSuffix: string;
  repoSlug: string;
  repoOwner: string;
  claudeScript: string;
  loopId: string;
  prNumber: number;
  revParseSha: string;
  machineName: string;
  assertionDetail: string;
}): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), opts.tmpSuffix));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, opts.repoSlug);
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: writes a file so the worktree has changes for git status
  await createFakeRunLoopScript(
    tmpDir,
    ["#!/bin/sh", "echo 'work done' > output.txt", "exit 0"].join("\n")
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude for attemptLlmCommit. The script body decides whether it
  // exits 0 (no execution-result.json), exits non-zero, or gets killed by
  // SIGTERM. In every case attemptLlmCommit resolves to a "failed" status
  // and the caller falls through to executeGitOperations (git-fallback).
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    nativePromptThenLlmFinalizationScript(opts.claudeScript),
    { mode: 0o755 }
  );

  const repoFullName = `${opts.repoOwner}/${path.basename(repoPath)}`;
  const expectedPrUrl = `https://github.com/${repoFullName}/pull/${opts.prNumber}`;

  // fake gh: pr view exits non-zero so code calls gh pr create
  const fakeGhScript = [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" != "--json" ]; then exit 1; fi',
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$3" = "--json" ]; then printf \'{"body":""}\\n\'; exit 0; fi',
    'if [ "$1" = pr ] && [ "$2" = create ]; then',
    `  printf '${expectedPrUrl}\\n'`,
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

  // fake git: status returns changes; all other commands succeed
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then printf "M output.txt\\n"; exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/execute-test"; exit 0; fi',
    `  echo "${opts.revParseSha}"; exit 0`,
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: opts.machineName,
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: opts.loopId,
        command: LoopCommand.Execute,
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: {
          fullName: repoFullName,
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

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    metadata: Record<string, unknown>;
  };

  assert.equal(
    uploadBody.metadata.executeFinalizationPath,
    "git-fallback",
    `Expected executeFinalizationPath=git-fallback after attemptLlmCommit ${opts.assertionDetail}, got: ${String(uploadBody.metadata.executeFinalizationPath)}`
  );

  const completedEvent = await waitForCompletedEvent(
    mock.requests,
    opts.loopId
  );
  assert.equal(
    completedEvent.result?.executeFinalizationPath,
    "git-fallback",
    `Expected completed event executeFinalizationPath=git-fallback, got: ${String(completedEvent.result?.executeFinalizationPath)}`
  );
}

// ---------------------------------------------------------------------------
// Test: attemptLlmCommit returns { status: "failed", reason: { kind: "other" }, logTail: ... }
//       when claude exits 0 without writing execution-result.json
//       → code falls through to executeGitOperations (git-fallback path)
// ---------------------------------------------------------------------------

test("EXECUTE: attemptLlmCommit returns status:failed reason:other when claude exits 0 without execution-result.json, falls through to git fallback", async () => {
  await runLlmFallbackTest({
    tmpSuffix: "execute-llm-failed-nojson-",
    repoSlug: "repo-llm-failed-nojson",
    repoOwner: "llm-failed-nojson",
    claudeScript: "#!/bin/sh\nexit 0\n",
    loopId: "00000000-0000-0000-0000-000000001300",
    prNumber: 55,
    revParseSha: "abc1234",
    machineName: "execute-llm-failed-nojson-machine",
    assertionDetail: "status:failed reason:other (no json)",
  });
});

// ---------------------------------------------------------------------------
// Test: attemptLlmCommit returns { status: "failed", reason: { kind: "other" }, logTail: ... }
//       when claude exits with non-zero exit code
//       → code falls through to executeGitOperations (git-fallback path)
// ---------------------------------------------------------------------------

test("EXECUTE: attemptLlmCommit returns status:failed reason:other when claude exits non-zero, falls through to git fallback", async () => {
  await runLlmFallbackTest({
    tmpSuffix: "execute-llm-failed-nonzero-",
    repoSlug: "repo-llm-failed-nonzero",
    repoOwner: "llm-failed-nonzero",
    claudeScript: "#!/bin/sh\nexit 1\n",
    loopId: "00000000-0000-0000-0000-000000001400",
    prNumber: 66,
    revParseSha: "def5678",
    machineName: "execute-llm-failed-nonzero-machine",
    assertionDetail: "status:failed reason:other (non-zero exit)",
  });
});

// ---------------------------------------------------------------------------
// Test (T-3.2): Rate-limited LLM-commit spawn emits FAILED event with
//               LoopErrorCode.AuthChallenge
//   - fake claude writes JSONL with isApiErrorMessage: true and
//     apiErrorStatus: 429 to stdout, then exits with code 1
//   - attemptLlmCommit detects auth challenge via detectAuthChallengeFromJsonl
//   - loop emits a FAILED event with LoopErrorCode.AuthChallenge
// ---------------------------------------------------------------------------

test("EXECUTE: rate-limited LLM commit spawn emits FAILED event with LoopErrorCode.AuthChallenge", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "execute-llm-ratelimit-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-llm-ratelimit");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // fake run-loop.sh: exits 0 so the execute phase proceeds to attemptLlmCommit
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude for attemptLlmCommit:
  //   - outputs a JSONL line with isApiErrorMessage: true and apiErrorStatus: 429
  //     to stdout. detectAuthChallengeFromJsonl matches this entry via
  //     AUTH_STATUS_PATTERN (the broader pattern used on isApiErrorMessage
  //     branches) and/or via the apiErrorStatus === 429 short-circuit.
  //   - exits with code 1 (non-zero) to trigger the auth-challenge detection path
  const rateLimitJsonl = JSON.stringify({
    type: "error",
    error: "rate_limit_error",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  });
  const claudeScript = [
    "#!/bin/sh",
    `printf '%s\\n' ${JSON.stringify(rateLimitJsonl)}`,
    "exit 1",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), claudeScript, {
    mode: 0o755,
  });

  // fake git: only `git status` is reachable from the auth-challenge path
  // (production short-circuits via completeExecuteFinalization before
  // executeGitOperations runs). All other commands are unreachable here.
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  resetResolvedClaudePath();
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "execute-llm-ratelimit-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000001500";
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
          fullName: `llm-ratelimit/${path.basename(repoPath)}`,
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

  // Wait for a terminal event (error or completed). The auth challenge path
  // should produce an error event with LoopErrorCode.AuthChallenge.
  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);

  assert.equal(
    terminalEvent.type,
    "error",
    `Expected terminal event type=error (FAILED), got: ${String(terminalEvent.type)}`
  );
  assert.equal(
    terminalEvent.code,
    LoopErrorCode.AuthChallenge,
    `Expected error code=${LoopErrorCode.AuthChallenge}, got: ${String(terminalEvent.code)}`
  );
});

// ---------------------------------------------------------------------------
// Test (T-3.3): LLM-commit spawn killed by SIGTERM (timeout simulation)
//               returns { status: "failed", reason: { kind: "timeout" } }
//               → code falls through to git-fallback path and completes normally
//
//   - fake claude kills itself with SIGTERM so Node.js sees code:null
//     (same observable outcome as the 30-minute kill timer firing)
//   - attemptLlmCommit resolves with { status: "failed", reason: { kind: "timeout" } }
//   - the non-auth failure falls through to executeGitOperations (git-fallback)
//   - loop completes with executeFinalizationPath="git-fallback"
// ---------------------------------------------------------------------------

test("EXECUTE: attemptLlmCommit returns status:failed reason:timeout when LLM process killed by SIGTERM, falls through to git fallback", async () => {
  await runLlmFallbackTest({
    tmpSuffix: "execute-llm-timeout-",
    repoSlug: "repo-llm-timeout",
    repoOwner: "llm-timeout",
    claudeScript: "#!/bin/sh\nkill -TERM $$\n",
    loopId: "00000000-0000-0000-0000-000000001600",
    prNumber: 77,
    revParseSha: "ghi9012",
    machineName: "execute-llm-timeout-machine",
    assertionDetail: "status:failed reason:timeout (SIGTERM)",
  });
});
