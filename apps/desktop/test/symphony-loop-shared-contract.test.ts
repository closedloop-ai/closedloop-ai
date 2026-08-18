/**
 * Tests for behaviors introduced by the @closedloop-ai/loops-api shared contract:
 *
 * 1. Unsupported commands (CHAT, EXPLORE) are rejected
 * 2. validateCommandInputs enforces per-command input requirements
 * 3. a missing required artifact terminalizes the loop as an error (ISS-5872)
 * 4. malformed EXECUTE results fall back to an authoritative no-changes result
 * 5. uploaded execution result is a V2 envelope with baseBranch on the primary entry
 * 6. sessionId is included in PROCESS_FAILED error events
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopArtifactFile } from "@closedloop-ai/loops-api/artifacts";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  createFakeRunLoopScript,
  FAKE_TOKEN_JSONL,
  makeFakeWorktreeProvider,
  restoreEnv,
  saveEnv,
  startMockApiServer,
  waitForCompletedEvent,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/shared-contract-test"
);

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const savedEnv = saveEnv();
/** Model the PLAN missing-artifact fixture reports usage against. */
const PLAN_FIXTURE_MODEL = "claude-opus-4-20250514";

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

/** Create a gateway server with a mock API backend. */
async function createTestGateway(tmpDir: string, mockPort: number) {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "shared-contract-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mockPort}`,
  });
  serversToClose.push(server);
  await server.start();
  return server;
}

// ---------------------------------------------------------------------------
// Test 1: Unsupported commands rejected with 400
// ---------------------------------------------------------------------------

test("unsupported command CHAT returns 400 Invalid command", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "contract-unsupported-")
  );
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000002001",
        command: "CHAT",
        closedLoopAuthToken: "tok",
        prompt: "hello",
        artifacts: [],
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "Invalid command: CHAT");
});

test("unsupported command EXPLORE returns 400 Invalid command", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "contract-unsupported-")
  );
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000002002",
        command: "EXPLORE",
        closedLoopAuthToken: "tok",
        prompt: "explore codebase",
        artifacts: [],
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "Invalid command: EXPLORE");
});

// ---------------------------------------------------------------------------
// Test 2: validateCommandInputs rejects per-command input violations
// ---------------------------------------------------------------------------

test("validateCommandInputs: EXECUTE with no prompt and no artifacts returns 400", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-validate-"));
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000002010",
        command: "EXECUTE",
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: { fullName: "org/repo", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(
    body.error.includes("EXECUTE"),
    `Expected error about EXECUTE input requirements, got: ${body.error}`
  );
});

test("validateCommandInputs: DECOMPOSE with no artifacts returns 400", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-validate-"));
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000002011",
        command: "DECOMPOSE",
        closedLoopAuthToken: "tok",
        prompt: "decompose this",
        artifacts: [],
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(
    body.error.includes("DECOMPOSE"),
    `Expected error about DECOMPOSE input requirements, got: ${body.error}`
  );
});

test("validateCommandInputs: REQUEST_CHANGES with no prompt returns 400", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-validate-"));
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000002012",
        command: "REQUEST_CHANGES",
        closedLoopAuthToken: "tok",
        artifacts: [{ type: "IMPLEMENTATION_PLAN", content: "plan" }],
        repo: { fullName: "org/repo", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(
    body.error.includes("REQUEST_CHANGES"),
    `Expected error about REQUEST_CHANGES input requirements, got: ${body.error}`
  );
});

// ---------------------------------------------------------------------------
// Test 3: a missing required artifact terminalizes as an error, not a completion
//
// DELIBERATE INVERSION (ISS-5872). This test previously asserted the opposite —
// "PLAN: completes even when plan.json is missing (validateResultBundle warning
// path)" — and passed, because the harness computed the missing-artifact list,
// logged it as a warning, and discarded it. That made the defect the documented
// contract: a PLAN that produced no plan at all reached the cloud as COMPLETED
// with `error: null`, and the implementation-plan artifact presented as
// done-and-empty (observed live on loop 019fee5a against PLN-1688).
//
// "Completed" must mean "produced". A PLAN that exits 0 without writing
// plan.json now posts an error event naming the file it owed.
// ---------------------------------------------------------------------------

test("PLAN: missing plan.json terminalizes as MISSING_REQUIRED_ARTIFACTS, not completed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-bundle-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-bundle");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  // run-loop.sh exits 0 but writes NO plan.json. `skipArtifacts` suppresses the
  // helper's default deliverable so this fixture reproduces the real defect.
  // `skipTokens` replaces the helper's model-less usage record with one naming
  // a model, so the terminal event can be checked for per-model attribution.
  await createFakeRunLoopScript(
    tmpDir,
    `#!/bin/sh\nmkdir -p "$CLOSEDLOOP_WORKDIR" 2>/dev/null\nprintf '%s\\n' '${JSON.stringify(
      {
        type: "assistant",
        message: {
          model: PLAN_FIXTURE_MODEL,
          usage: { input_tokens: 900, output_tokens: 400 },
        },
      }
    )}' >> "$CLOSEDLOOP_WORKDIR/claude-output.jsonl"\nexit 0\n`,
    { skipArtifacts: true, skipTokens: true }
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002020";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: "PLAN",
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `bundle-test/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(response.status, 200);

  // The loop terminalizes — it must not hang — but as an ERROR carrying the
  // specific code and naming the missing file, not as a clean completion.
  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "error",
    "a PLAN that wrote no plan.json must not report a clean completion"
  );
  assert.equal(terminalEvent.code, LoopErrorCode.MissingRequiredArtifacts);
  assert.ok(
    typeof terminalEvent.message === "string" &&
      terminalEvent.message.includes(LoopArtifactFile.Plan),
    `error message must name the missing artifact, got: ${String(terminalEvent.message)}`
  );

  // Partial artifacts are still uploaded so the operator keeps whatever the run
  // did write; the plan itself is absent because it was never produced.
  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: Record<string, unknown>;
  };
  assert.equal(
    uploadBody.artifacts.plan,
    undefined,
    "plan artifact should be absent when plan.json was not written"
  );

  // The legacy terminal event reports what the run actually spent, per model.
  // Totals alone make the cloud price the whole run against a synthetic default
  // model, so a real Opus run keeps the right counts and gets the wrong cost.
  assert.deepEqual(terminalEvent.tokenUsage, {
    inputTokens: 900,
    outputTokens: 400,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  assert.deepEqual(terminalEvent.tokensByModel, {
    [PLAN_FIXTURE_MODEL]: {
      input: 900,
      output: 400,
      cacheCreation: 0,
      cacheRead: 0,
    },
  });
});

// ---------------------------------------------------------------------------
// Test 3b: the guard is driven by the shared ResultBundle manifest, so it is
// not PLAN-specific. GENERATE_PRD owes prd.md and gets the same treatment —
// proving the sibling commands are covered by construction rather than by a
// second hand-written check that could drift.
// ---------------------------------------------------------------------------

test("GENERATE_PRD: missing prd.md terminalizes as MISSING_REQUIRED_ARTIFACTS", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-prd-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-prd");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n", {
    skipArtifacts: true,
  });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002021";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        prompt: "Write a PRD",
        artifacts: [],
        repo: {
          fullName: `bundle-test/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(response.status, 200);

  const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(
    terminalEvent.type,
    "error",
    "a GENERATE_PRD that wrote no prd.md must not report a clean completion"
  );
  assert.equal(terminalEvent.code, LoopErrorCode.MissingRequiredArtifacts);
  assert.ok(
    typeof terminalEvent.message === "string" &&
      terminalEvent.message.includes(LoopArtifactFile.Prd),
    `error message must name the missing artifact, got: ${String(terminalEvent.message)}`
  );
});

// ---------------------------------------------------------------------------
// Test 4: malformed execution-result.json is replaced by a synthesized
//         no-changes result before the completed event is posted
// ---------------------------------------------------------------------------

test("EXECUTE: malformed execution-result.json falls back to no-changes completed fields", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-parse-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-parse");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // run-loop.sh writes a malformed execution-result.json (missing required fields)
  await createFakeRunLoopScript(
    tmpDir,
    [
      "#!/bin/sh",
      'echo \'{"garbage": true}\' > "$CLOSEDLOOP_WORKDIR/execution-result.json"',
      "exit 0",
    ].join("\n")
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      "printf '{\"garbage\": true}' > execution-result.json",
      `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );

  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then echo "symphony/parse-test"; exit 0; fi',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002030";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: "EXECUTE",
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: {
          fullName: `parse-test/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(response.status, 200);

  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);
  const result = completedEvent.result as Record<string, unknown>;

  // PLN-338 synthesizes an authoritative no-changes execution result after
  // malformed LLM output, so PR fields normalize to null and has_changes=false.
  assert.equal(
    result.prUrl,
    null,
    "prUrl should normalize to null when execution-result.json falls back to no-changes"
  );
  assert.equal(
    result.prNumber,
    null,
    "prNumber should normalize to null when execution-result.json falls back to no-changes"
  );
  assert.equal(
    result.has_changes,
    false,
    "has_changes should be false when malformed execution-result.json falls back to no-changes"
  );
});

// ---------------------------------------------------------------------------
// Test 5: uploaded execution result is V2 envelope with baseBranch on the primary entry
// ---------------------------------------------------------------------------

test("EXECUTE: uploaded execution result is V2 envelope with baseBranch on success entry", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contract-baseref-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-baseref");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  // run-loop.sh: writes a file so the worktree has changes, exits 0
  await createFakeRunLoopScript(
    tmpDir,
    ["#!/bin/sh", "echo 'change' > new-file.txt", "exit 0"].join("\n")
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // fake claude for attemptLlmCommit: writes execution-result.json relative to cwd
  // The LLM scratch file is the camelCase format documented in the prompt;
  // the harness re-emits it as a V2 envelope to claudeWorkDir.
  const repoFullName = `baseref/${path.basename(repoPath)}`;
  const executionResultContent = JSON.stringify({
    prUrl: `https://github.com/${repoFullName}/pull/99`,
    prNumber: 99,
    branchName: "symphony/baseref-test",
    commitSha: "deadbeef",
  });
  const claudeScript = [
    "#!/bin/sh",
    `printf '%s' '${executionResultContent}' > execution-result.json`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), claudeScript, {
    mode: 0o755,
  });

  // fake git: status returns changes, push succeeds
  const fakeGitScript = [
    "#!/bin/sh",
    'if [ "$1" = status ]; then echo "M new-file.txt"; exit 0; fi',
    'if [ "$1" = push ]; then exit 0; fi',
    'if [ "$1" = add ]; then exit 0; fi',
    'if [ "$1" = commit ]; then exit 0; fi',
    'if [ "$1" = fetch ]; then exit 0; fi',
    'if [ "$1" = diff ]; then exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then',
    '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/baseref-test"; exit 0; fi',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, { mode: 0o755 });
  // fake gh: pr view succeeds with existing PR, pr create not called
  const fakeGhScript = [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ]; then',
    '  echo \'{"url": "https://github.com/org/repo/pull/99", "number": 99}\'',
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002040";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: "EXECUTE",
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        repo: { fullName: repoFullName, branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 200);

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: {
      executionResult?: {
        schemaVersion?: number;
        results?: Array<{ status: string; baseBranch?: string }>;
      };
    };
  };

  const execResult = uploadBody.artifacts.executionResult;
  assert.ok(execResult, "executionResult should be present in upload");
  assert.equal(execResult.schemaVersion, 2, "executionResult should be V2");
  assert.equal(execResult.results?.[0]?.status, "success");
  assert.equal(
    execResult.results?.[0]?.baseBranch,
    "main",
    "baseBranch should be set to the target branch on the primary success entry"
  );
});

test("EXECUTE: localRepoPath-only success infers V2 fullName from PR URL", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "contract-localpath-fullname-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-localpath");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;

  await createFakeRunLoopScript(
    tmpDir,
    ["#!/bin/sh", "echo 'change' > local-path-change.txt", "exit 0"].join("\n")
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  const inferredFullName = "local-only/repo-localpath";
  const executionResultContent = JSON.stringify({
    prUrl: `https://github.com/${inferredFullName}/pull/7`,
    prNumber: 7,
    branchName: "symphony/localpath-test",
    commitSha: "abc1234",
  });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s' '${executionResultContent}' > execution-result.json`,
      `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );

  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002041";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: "EXECUTE",
        closedLoopAuthToken: "tok",
        prompt: "test",
        artifacts: [],
        localRepoPath: repoPath,
      }),
    }
  );

  assert.equal(response.status, 200);

  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: {
      executionResult?: {
        schemaVersion?: number;
        results?: Array<{ status: string; fullName?: string; prUrl?: string }>;
      };
    };
  };
  const primary = uploadBody.artifacts.executionResult?.results?.[0];
  assert.equal(uploadBody.artifacts.executionResult?.schemaVersion, 2);
  assert.equal(primary?.status, "success");
  assert.equal(primary?.fullName, inferredFullName);
  assert.equal(primary?.prUrl, `https://github.com/${inferredFullName}/pull/7`);

  const completedEvent = await waitForCompletedEvent(mock.requests, loopId);
  assert.equal(
    completedEvent.result?.prUrl,
    `https://github.com/${inferredFullName}/pull/7`
  );
  assert.equal(completedEvent.result?.has_changes, true);
});

// ---------------------------------------------------------------------------
// Test 6: PROCESS_FAILED error event includes sessionId
// ---------------------------------------------------------------------------

test("PLAN: non-zero exit error event includes sessionId from session-id.txt", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "contract-sessionid-")
  );
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-sessionid");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  const expectedSessionId = "test-session-id-12345";

  // run-loop.sh: writes session-id.txt then exits non-zero
  await createFakeRunLoopScript(
    tmpDir,
    [
      "#!/bin/sh",
      `echo '${expectedSessionId}' > "$CLOSEDLOOP_WORKDIR/session-id.txt"`,
      "exit 1",
    ].join("\n"),
    { skipTokens: true }
  );

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      `WORK_DIR="\${CLOSEDLOOP_WORKDIR:-$PWD/.closedloop-ai/work}"`,
      'mkdir -p "$WORK_DIR"',
      `echo '${expectedSessionId}' > "$WORK_DIR/session-id.txt"`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 }
  );

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);
  const server = await createTestGateway(tmpDir, mock.port);

  const loopId = "00000000-0000-0000-0000-000000002050";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: "PLAN",
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `sessionid/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  assert.equal(response.status, 200);

  const errorEvent = await waitForTerminalEvent(mock.requests, loopId);
  assert.equal(errorEvent.type, "error");
  assert.equal(errorEvent.code, "PROCESS_FAILED");
  assert.equal(
    errorEvent.sessionId,
    expectedSessionId,
    `Expected sessionId=${expectedSessionId} in PROCESS_FAILED error event, got: ${JSON.stringify(errorEvent.sessionId)}`
  );
});
