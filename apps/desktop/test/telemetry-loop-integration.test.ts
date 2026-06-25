/**
 * Integration tests for telemetry emission from the symphony loop handler.
 *
 * Covers all 5 emission function scopes:
 *   1. job.failed telemetry — correct category/trace/diagnostics
 *   2. job.completed telemetry — correct category/trace
 *   3. preflight.binary_not_found telemetry — correct category/trace (claude not in PATH)
 *   4. preflight.spawn_failed telemetry — correct category (log file cannot be opened)
 *   5. x-desktop-command-id / x-desktop-operation-id header trace propagation
 *
 * Also verifies end-to-end logTail truncation via TelemetryService:
 *   - diagnostics.logTail is capped at TELEMETRY_MAX_FIELD_BYTES in the captured event.
 *
 * Teardown: stopGateway() / fs.rm (recursive+force) / kill spawned child processes.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { Observability } from "../src/main/observability.js";
import { TELEMETRY_MAX_FIELD_BYTES } from "../src/main/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry-service.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// Use unique high ports to avoid EADDRINUSE with other test files that use PORT_PROBE_ORDER (19432-19435)
const TELEM_TEST_PORTS = [29_432, 29_433, 29_434, 29_435] as const;

// ---------------------------------------------------------------------------
// Shared teardown state
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalRawPipeline =
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE;
const originalWorktreeParentDir = process.env.SYMPHONY_WORKTREE_PARENT_DIR;

afterEach(async () => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  resetShellPathCache();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalRawPipeline === undefined) {
    delete process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE;
  } else {
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE =
      originalRawPipeline;
  }

  if (originalWorktreeParentDir === undefined) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  } else {
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = originalWorktreeParentDir;
  }

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

  Observability.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shared test helpers — see test/helpers/mock-api-server.ts
import {
  makeFakeWorktreeProvider,
  startMockApiServer,
} from "./symphony-test-utils.js";

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/telemetry-test"
);

/**
 * Initialize Observability with a capturing telemetry backend.
 * Returns the shared captured events array and a waiter helper.
 */
function initCapturingObservability(): {
  captured: EnrichedTelemetryEvent[];
  waitForCategory: (
    category: string,
    timeoutMs?: number
  ) => Promise<EnrichedTelemetryEvent>;
} {
  const captured: EnrichedTelemetryEvent[] = [];
  const waiters: Array<{
    category: string;
    resolve: (e: EnrichedTelemetryEvent) => void;
  }> = [];

  Observability.init({
    telemetrySend: (event) => {
      captured.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (event.category === waiters[i].category) {
          waiters[i].resolve(event);
          waiters.splice(i, 1);
        }
      }
    },
  });

  function waitForCategory(
    category: string,
    timeoutMs = 20_000
  ): Promise<EnrichedTelemetryEvent> {
    const existing = captured.find((e) => e.category === category);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<EnrichedTelemetryEvent>((resolve, reject) => {
      const onTimeout = (): void => {
        reject(
          new Error(
            `Timed out waiting for telemetry category "${category}" after ${timeoutMs}ms. Captured: ${JSON.stringify(captured.map((e) => e.category))}`
          )
        );
      };
      const timer = setTimeout(onTimeout, timeoutMs);
      const onResolve = (e: EnrichedTelemetryEvent): void => {
        clearTimeout(timer);
        resolve(e);
      };
      waiters.push({ category, resolve: onResolve });
    });
  }

  return { captured, waitForCategory };
}

/**
 * Create a fake claude binary that exits with the given code.
 * DECOMPOSE / EVALUATE_PRD resolve claude during preflight, then spawn it.
 */
async function createFakeClaudeBin(
  fakeBin: string,
  exitCode: number
): Promise<void> {
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    `#!/bin/sh\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
}

function getClaudeBinaryPath(fakeBin: string): () => { claude: string } {
  return () => ({ claude: path.join(fakeBin, "claude") });
}

// ---------------------------------------------------------------------------
// Test 1: job.failed — telemetry emitted when spawned process exits non-zero
// ---------------------------------------------------------------------------

test("telemetry: job.failed emitted with correct category/trace/diagnostics on process exit non-zero", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "telem-failed-"));
  tempPathsToClean.push(tmpDir);

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

  // fake claude exits 1 → triggers job.failed telemetry
  const fakeBin = path.join(tmpDir, "fake-bin");
  await createFakeClaudeBin(fakeBin, 1);
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const { waitForCategory } = initCapturingObservability();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: TELEM_TEST_PORTS[0],
    fallbackPorts: TELEM_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telem-failed-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getBinaryPaths: getClaudeBinaryPath(fakeBin),
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "10000000-0000-0000-0000-000000000a01";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [{ type: "PRD", content: "PRD content for telemetry test" }],
        prompt: "Decompose this feature into tasks",
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  const event = await waitForCategory("job.failed");

  assert.equal(event.category, "job.failed", "category must be job.failed");
  assert.equal(event.severity, "error", "severity must be error");
  assert.ok(
    typeof event.message === "string" && event.message.length > 0,
    "message must be non-empty"
  );
  assert.ok(event.trace, "trace must be present");
  assert.equal(event.trace?.loopId, loopId, "trace.loopId must match");
  assert.equal(event.trace?.jobId, loopId, "trace.jobId must match loopId");
  // AC-002: diagnostics must include exitCode, tokenUsage, diagnosticsVersion
  const diag = event.diagnostics;
  assert.ok(diag, "diagnostics must be present on job.failed");
  assert.equal(
    typeof diag.exitCode,
    "number",
    "diagnostics.exitCode must be a number"
  );
  assert.ok(
    diag.exitCode !== 0,
    "diagnostics.exitCode must be non-zero for failures"
  );
  assert.ok(diag.tokenUsage, "diagnostics.tokenUsage must be present");
  assert.equal(
    typeof diag.tokenUsage.inputTokens,
    "number",
    "tokenUsage.inputTokens must be a number"
  );
  assert.equal(
    typeof diag.tokenUsage.outputTokens,
    "number",
    "tokenUsage.outputTokens must be a number"
  );
  assert.equal(
    typeof diag.diagnosticsVersion,
    "number",
    "diagnostics.diagnosticsVersion must be a number"
  );
  assert.ok(
    (diag.diagnosticsVersion ?? 0) >= 1,
    "diagnosticsVersion must be >= 1"
  );
  // job.failed includes lifecycle.command when a command is provided on the request
  assert.equal(
    diag.lifecycle?.command,
    LoopCommand.Decompose,
    "job.failed must include lifecycle.command matching the request"
  );
});

// ---------------------------------------------------------------------------
// Test 2: job.completed — telemetry emitted when spawned process exits 0
// ---------------------------------------------------------------------------

test("telemetry: job.completed emitted with correct category/trace on process exit 0", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "telem-completed-"));
  tempPathsToClean.push(tmpDir);

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

  // fake claude exits 0 → triggers job.completed telemetry
  const fakeBin = path.join(tmpDir, "fake-bin");
  await createFakeClaudeBin(fakeBin, 0);
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const { waitForCategory } = initCapturingObservability();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: TELEM_TEST_PORTS[0],
    fallbackPorts: TELEM_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telem-completed-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getBinaryPaths: getClaudeBinaryPath(fakeBin),
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "20000000-0000-0000-0000-000000000a02";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [{ type: "PRD", content: "PRD content for telemetry test" }],
        prompt: "Decompose this feature into tasks",
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  const event = await waitForCategory("job.completed");

  assert.equal(
    event.category,
    "job.completed",
    "category must be job.completed"
  );
  assert.equal(event.severity, "info", "severity must be info");
  assert.ok(
    typeof event.message === "string" && event.message.length > 0,
    "message must be non-empty"
  );
  assert.ok(event.trace, "trace must be present");
  assert.equal(event.trace?.loopId, loopId, "trace.loopId must match");
  assert.equal(event.trace?.jobId, loopId, "trace.jobId must match loopId");
  // job.completed includes lifecycle.command when a command is provided
  assert.equal(
    event.diagnostics?.lifecycle?.command,
    LoopCommand.Decompose,
    "job.completed must include lifecycle.command matching the request"
  );
});

// ---------------------------------------------------------------------------
// Test 3: preflight.binary_not_found — claude not found in PATH
// ---------------------------------------------------------------------------

test("telemetry: preflight.binary_not_found emitted when claude is absent from PATH", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "telem-binnotfound-"));
  tempPathsToClean.push(tmpDir);

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

  // No claude binary — PATH has no executable named "claude"
  const emptyBin = path.join(tmpDir, "empty-bin");
  await fs.mkdir(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const { waitForCategory } = initCapturingObservability();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: TELEM_TEST_PORTS[0],
    fallbackPorts: TELEM_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telem-binnotfound-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "30000000-0000-0000-0000-000000000a03";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [{ type: "PRD", content: "PRD content for telemetry test" }],
        prompt: "Decompose this feature into tasks",
      }),
    }
  );

  // Handler returns 500 when binary not found
  assert.equal(
    response.status,
    500,
    `Expected 500 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  const event = await waitForCategory("preflight.binary_not_found");

  assert.equal(
    event.category,
    "preflight.binary_not_found",
    "category must be preflight.binary_not_found"
  );
  assert.equal(event.severity, "error", "severity must be error");
  assert.ok(
    typeof event.message === "string" && event.message.includes("claude"),
    `message must mention "claude", got: ${event.message}`
  );
  assert.ok(event.trace, "trace must be present");
  assert.equal(event.trace?.loopId, loopId, "trace.loopId must match");
});

// ---------------------------------------------------------------------------
// Test 4: preflight.spawn_failed — log file cannot be opened (EISDIR)
// ---------------------------------------------------------------------------
//
// Strategy: Use the PLAN command with a predictable worktree path.
// Pre-create symphony-loop.log as a DIRECTORY at the expected claudeWorkDir
// location. When handleLoopRequest calls openSync(logFile, "a"), it fails
// with EISDIR, triggering the preflight.spawn_failed telemetry path.
//
// The worktree directory is created by git worktree add during ensureWorktree,
// but the .claude/work sub-directory (claudeWorkDir) is created afterwards by
// fs.mkdir. We pre-populate the log file as a directory inside it so that
// the mkdir(..., { recursive: true }) succeeds (it already exists as a dir)
// while openSync on a subdirectory entry that is itself a directory fails.

test("telemetry: preflight.spawn_failed emitted when log file open fails (EISDIR)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "telem-spawnfail-"));
  tempPathsToClean.push(tmpDir);

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

  // Provide a fake claude (not needed for PLAN but avoids PATH issues)
  const fakeBin = path.join(tmpDir, "fake-bin");
  await createFakeClaudeBin(fakeBin, 0);

  // Create a fake run-loop.sh in the plugin cache so findPluginScript returns non-null
  const scriptDir = path.join(
    tmpDir,
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code",
    "1.0.0",
    "scripts"
  );
  await fs.mkdir(scriptDir, { recursive: true });
  const runLoopScript = path.join(scriptDir, "run-loop.sh");
  await fs.writeFile(runLoopScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const { waitForCategory } = initCapturingObservability();

  // loopId determines the worktree path — we use a known value to predict the path
  const loopId = "40000000-0000-0000-0000-000000000a04";

  const repoPath = path.join(tmpDir, "spawn-fail-repo");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

  // Compute the worktreeDir that ensureWorktree would create:
  //   resolveLoopWorktreeDir(repoPath, slugifyLoopId(loopId))
  //   = path.join(worktreeParent, `spawn-fail-repo-loop-${slugifiedLoopId}`)
  // slugifyLoopId keeps the UUID as-is (all chars are [a-z0-9-])
  const slugifiedId = loopId; // UUID has only lowercase hex and dashes
  const predictedWorktreeDir = path.join(
    worktreeParent,
    `spawn-fail-repo-loop-${slugifiedId}`
  );
  const predictedClaudeWorkDir = path.join(
    predictedWorktreeDir,
    ".closedloop-ai",
    "work"
  );
  const predictedLogFile = path.join(
    predictedClaudeWorkDir,
    "symphony-loop.log"
  );

  // Pre-create worktreeDir as a plain directory (not a real git worktree).
  // ensureWorktree calls existsSync(worktreeDir) first and returns early if it exists,
  // so git worktree add is never called and we control the directory contents.
  // Create claudeWorkDir and symphony-loop.log as a DIRECTORY inside it.
  // When fs.mkdir(claudeWorkDir, { recursive: true }) runs, it succeeds (already exists).
  // When openSync(logFile, "a") runs on the log path that is a directory, it fails with EISDIR.
  await fs.mkdir(predictedClaudeWorkDir, { recursive: true });
  await fs.mkdir(predictedLogFile, { recursive: true }); // log "file" is actually a dir

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: TELEM_TEST_PORTS[0],
    fallbackPorts: TELEM_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telem-spawnfail-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getBinaryPaths: getClaudeBinaryPath(fakeBin),
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
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: {
          fullName: `spawn-fail/${path.basename(repoPath)}`,
          branch: "main",
        },
      }),
    }
  );

  // Handler returns 500 when log file cannot be opened
  assert.equal(
    response.status,
    500,
    `Expected 500 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  const event = await waitForCategory("preflight.spawn_failed");

  assert.equal(
    event.category,
    "preflight.spawn_failed",
    "category must be preflight.spawn_failed"
  );
  assert.equal(event.severity, "error", "severity must be error");
  assert.ok(
    typeof event.message === "string" && event.message.length > 0,
    "message must be non-empty"
  );
});

// ---------------------------------------------------------------------------
// Test 5: x-desktop-command-id / x-desktop-operation-id header trace propagation
// ---------------------------------------------------------------------------

test("telemetry: commandId and operationId from request headers appear in trace context", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "telem-headers-"));
  tempPathsToClean.push(tmpDir);

  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";

  // fake claude exits 1 → triggers job.failed with trace we can inspect
  const fakeBin = path.join(tmpDir, "fake-bin");
  await createFakeClaudeBin(fakeBin, 1);
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const { waitForCategory } = initCapturingObservability();

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: TELEM_TEST_PORTS[0],
    fallbackPorts: TELEM_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "telem-headers-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
    getBinaryPaths: getClaudeBinaryPath(fakeBin),
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "50000000-0000-0000-0000-000000000a05";
  const testCommandId = "cmd-test-abc123";
  const testOperationId = "op-test-xyz789";

  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-desktop-command-id": testCommandId,
        "x-desktop-operation-id": testOperationId,
      },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.Decompose,
        closedLoopAuthToken: "tok",
        artifacts: [{ type: "PRD", content: "PRD content for telemetry test" }],
        prompt: "Decompose this feature into tasks",
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for job.failed which is emitted after process exits non-zero
  const event = await waitForCategory("job.failed");

  assert.ok(event.trace, "trace must be present");
  assert.equal(
    event.trace?.commandId,
    testCommandId,
    `trace.commandId must match header value, got: ${event.trace?.commandId}`
  );
  assert.equal(
    event.trace?.operationId,
    testOperationId,
    `trace.operationId must match header value, got: ${event.trace?.operationId}`
  );
  assert.equal(event.trace?.loopId, loopId, "trace.loopId must match");
});

// ---------------------------------------------------------------------------
// Test 6: logTail truncation — diagnostics.logTail capped at TELEMETRY_MAX_FIELD_BYTES
// ---------------------------------------------------------------------------

test("telemetry: Observability truncates logTail to TELEMETRY_MAX_FIELD_BYTES via TelemetryService", () => {
  const { captured } = initCapturingObservability();

  // Build a string longer than TELEMETRY_MAX_FIELD_BYTES (4096 bytes)
  // Use ASCII lines so byte count == char count
  const lineCount = 200;
  const lineContent = "A".repeat(100);
  const largeTail = Array.from(
    { length: lineCount },
    (_, i) => `line-${i}: ${lineContent}`
  ).join("\n");

  // Verify our test data is actually over the limit
  const encoder = new TextEncoder();
  assert.ok(
    encoder.encode(largeTail).length > TELEMETRY_MAX_FIELD_BYTES,
    "Test data must exceed TELEMETRY_MAX_FIELD_BYTES for this test to be meaningful"
  );

  Observability.jobFailed(
    "cmd-trunc",
    "OP_TRUNC",
    "60000000-0000-0000-0000-000000000b01",
    1,
    { logTail: largeTail }
  );

  assert.equal(captured.length, 1, "Expected exactly one captured event");
  const event = captured[0];

  const logTail = event.diagnostics?.logTail;
  assert.ok(logTail !== undefined, "diagnostics.logTail must be present");
  const truncatedBytes = encoder.encode(logTail).length;
  assert.ok(
    truncatedBytes <= TELEMETRY_MAX_FIELD_BYTES,
    `logTail must be <= ${TELEMETRY_MAX_FIELD_BYTES} bytes after truncation, got ${truncatedBytes}`
  );
  // Verify that the original large string was actually truncated
  assert.ok(
    logTail.length < largeTail.length,
    "truncated logTail must be shorter than the original"
  );
});
