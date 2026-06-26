/**
 * Integration tests for the GENERATE_PRD loop command.
 *
 * Uses a fake claude binary, a mock API server to record event/upload calls,
 * and a fake WorktreeProvider (no real git).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// Use a file-local port range so this suite does not collide with other
// integration test files that still use the default gateway probe order.
const GENERATE_PRD_TEST_PORTS = [39_432, 39_433, 39_434, 39_435] as const;

// ---------------------------------------------------------------------------
// Shared state and cleanup
// ---------------------------------------------------------------------------

const serversToClose: DesktopGatewayServer[] = [];
const mockServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const originalSymphonyWorktreeParentDir =
  process.env.SYMPHONY_WORKTREE_PARENT_DIR;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

afterEach(async () => {
  if (originalSymphonyWorktreeParentDir === undefined) {
    delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  } else {
    process.env.SYMPHONY_WORKTREE_PARENT_DIR =
      originalSymphonyWorktreeParentDir;
  }

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
// Helpers
// ---------------------------------------------------------------------------

// Shared test helpers
import {
  makeFakeWorktreeProvider,
  startMockApiServer,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

const LOOP_UUID = "00000000-0000-0000-0000-000000000099";

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/generate-prd-test"
);

// ---------------------------------------------------------------------------
// Test 1: Repo-required rejection
// ---------------------------------------------------------------------------

test("GENERATE_PRD: rejects with 400 when no repo configured", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-norepo-"));
  tempPathsToClean.push(tmpDir);

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-norepo-machine",
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
        loopId: LOOP_UUID,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Generate a PRD",
        // No repo
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(
    (body as { error: string }).error.includes("GENERATE_PRD"),
    `Error should mention GENERATE_PRD: ${(body as { error: string }).error}`
  );
});

// ---------------------------------------------------------------------------
// Test 2: Command acceptance
// ---------------------------------------------------------------------------

test("GENERATE_PRD: accepts valid command and responds 200", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-accept-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-accept");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  // Output a JSON line so the buildClaudePipeline grep/tee/formatter pipeline succeeds
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    '#!/bin/sh\necho \'{"type":"result"}\'\nexit 0\n',
    { mode: 0o755 }
  );

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.HOME = tmpDir; // Prevents findStreamFormatter from finding real formatter
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-accept-machine",
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
        loopId: "00000000-0000-0000-0000-000000000010",
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Generate a PRD for this project",
        repo: { fullName: "org/repo-accept", branch: "main" },
      }),
    }
  );

  assert.equal(
    response.status,
    200,
    `Expected 200 but got ${response.status}: ${await response.text().catch(() => "")}`
  );

  // Wait for handleProcessCompletion to post a terminal event before
  // afterEach tears down the mock server and temp dirs.
  await waitForTerminalEvent(
    mock.requests,
    "00000000-0000-0000-0000-000000000010"
  );
});

// ---------------------------------------------------------------------------
// Test 3: Missing-prompt rejection
// ---------------------------------------------------------------------------

test("GENERATE_PRD: rejects with 400 when prompt is missing", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-noprompt-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-noprompt");
  await fs.mkdir(repoPath, { recursive: true });

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-noprompt-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  // Test with no prompt field
  const response1 = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000000020",
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        repo: { fullName: "org/repo-noprompt", branch: "main" },
      }),
    }
  );

  assert.equal(response1.status, 400);
  const body1 = await response1.json();
  assert.ok(
    (body1 as { error: string }).error.includes(
      "GENERATE_PRD requires a non-empty prompt"
    ),
    `Expected specific error message, got: ${(body1 as { error: string }).error}`
  );

  // Test with empty string prompt
  const response2 = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: "00000000-0000-0000-0000-000000000021",
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "",
        repo: { fullName: "org/repo-noprompt", branch: "main" },
      }),
    }
  );

  assert.equal(response2.status, 400);
  const body2 = await response2.json();
  assert.ok(
    (body2 as { error: string }).error.includes(
      "GENERATE_PRD requires a non-empty prompt"
    ),
    `Expected specific error message for empty prompt, got: ${(body2 as { error: string }).error}`
  );
});

// ---------------------------------------------------------------------------
// Test 4: Spawn cwd, context-pack layout, and no --add-dir
// ---------------------------------------------------------------------------

test("GENERATE_PRD: spawns with worktree cwd, writes context pack, no --add-dir", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-layout-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-layout");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  // Capture file outside the worktree (which gets cleaned up)
  const captureFile = path.join(tmpDir, "capture.txt");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // Fake claude spy script: captures cwd, context files, and args, then outputs JSON for the pipeline
  const spyScript = [
    "#!/bin/sh",
    `echo "CWD=$(pwd)" > ${JSON.stringify(captureFile)}`,
    `echo "PROMPT_MD=$(cat .closedloop-ai/context/prompt.md 2>/dev/null || echo MISSING)" >> ${JSON.stringify(captureFile)}`,
    `echo "REPO_INFO_EXISTS=$(test -f .closedloop-ai/context/repo-info.json && echo yes || echo no)" >> ${JSON.stringify(captureFile)}`,
    `echo "ARTIFACTS=$(find .closedloop-ai/context/artifacts -maxdepth 1 -type f 2>/dev/null | sort | tr '\\n' ',')" >> ${JSON.stringify(captureFile)}`,
    `echo "ARGS=$*" >> ${JSON.stringify(captureFile)}`,
    // Check that operational files are NOT at worktree root
    `echo "ROOT_LOG=$(test -f symphony-loop.log && echo present || echo absent)" >> ${JSON.stringify(captureFile)}`,
    `echo "ROOT_PROMPT_TXT=$(test -f generate-prd-prompt.txt && echo present || echo absent)" >> ${JSON.stringify(captureFile)}`,
    `echo "ROOT_PID=$(test -f process.pid && echo present || echo absent)" >> ${JSON.stringify(captureFile)}`,
    // Output JSON so the buildClaudePipeline grep/tee/formatter pipeline succeeds
    'echo \'{"type":"result"}\'',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), spyScript, { mode: 0o755 });

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.HOME = tmpDir; // Prevents findStreamFormatter from finding real formatter
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-layout-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000030";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [
          {
            id: "art-1",
            type: "TEMPLATE",
            title: "PRD Template",
            content: "Template content here",
          },
          {
            id: "art-2",
            type: "prd",
            title: "Existing PRD",
            content: "Existing PRD content",
          },
        ],
        prompt: "Generate a comprehensive PRD",
        repo: { fullName: "org/repo-layout", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 200);

  // Wait for the terminal event so handleProcessCompletion (including
  // worktree cleanup) finishes before afterEach tears down resources.
  await waitForTerminalEvent(mock.requests, loopId);

  // Read the captured data
  const captured = await fs.readFile(captureFile, "utf-8");
  const lines = captured.split("\n");
  const getValue = (prefix: string) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : undefined;
  };

  // cwd should be the worktree, not the bare repo checkout
  const cwd = getValue("CWD=");
  assert.ok(cwd, "CWD should be captured");
  assert.ok(
    cwd!.includes("worktrees"),
    `CWD should be in worktrees dir, got: ${cwd}`
  );
  assert.ok(
    cwd!.includes("generate-prd"),
    `CWD should be a generate-prd worktree, got: ${cwd}`
  );
  assert.ok(
    !cwd!.endsWith(repoPath),
    `CWD should not be the bare repo path, got: ${cwd}`
  );

  // prompt.md should match
  const promptMd = getValue("PROMPT_MD=");
  assert.equal(promptMd, "Generate a comprehensive PRD");

  // repo-info.json should exist
  const repoInfoExists = getValue("REPO_INFO_EXISTS=");
  assert.equal(repoInfoExists, "yes");

  // Artifacts should be present with correct naming
  const artifactsRaw = getValue("ARTIFACTS=");
  assert.ok(artifactsRaw, "Artifacts listing should be captured");
  assert.ok(
    artifactsRaw!.includes("template-art-1.md"),
    `Should contain template artifact: ${artifactsRaw}`
  );
  assert.ok(
    artifactsRaw!.includes("prd-art-2.md"),
    `Should contain prd artifact: ${artifactsRaw}`
  );

  // Args should NOT contain --add-dir
  const args = getValue("ARGS=");
  assert.ok(args !== undefined, "ARGS should be captured");
  assert.ok(
    !args!.includes("--add-dir"),
    `Args should not contain --add-dir: ${args}`
  );

  // Operational files should NOT be at worktree root
  assert.equal(
    getValue("ROOT_LOG="),
    "absent",
    "symphony-loop.log should not be at worktree root"
  );
  assert.equal(
    getValue("ROOT_PROMPT_TXT="),
    "absent",
    "generate-prd-prompt.txt should not be at worktree root"
  );
  assert.equal(
    getValue("ROOT_PID="),
    "absent",
    "process.pid should not be at worktree root"
  );
});

// ---------------------------------------------------------------------------
// Test 5: Uploaded payload shape
// ---------------------------------------------------------------------------

test("GENERATE_PRD: uploads { prd: { content } } when prd.md is written", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-upload-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-upload");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });

  // Fake claude that writes prd.md to cwd, outputs JSON for the pipeline, and exits 0
  const fakeScript = [
    "#!/bin/sh",
    'printf "# Generated PRD\\n\\nContent here." > prd.md',
    'echo \'{"type":"result"}\'',
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), fakeScript, { mode: 0o755 });

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.HOME = tmpDir; // Prevents findStreamFormatter from finding real formatter
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-upload-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000040";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Generate a PRD",
        repo: { fullName: "org/repo-upload", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 200);

  // Wait for upload call
  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: { prd?: { content: string } };
    metadata: Record<string, unknown>;
  };

  assert.ok(uploadBody.artifacts.prd, "Upload should contain prd artifact");
  assert.equal(
    uploadBody.artifacts.prd!.content,
    "# Generated PRD\n\nContent here."
  );
  assert.ok(
    uploadBody.metadata !== undefined,
    "Upload should contain metadata"
  );

  // Wait for terminal event so worktree cleanup finishes before afterEach.
  await waitForTerminalEvent(mock.requests, loopId);
});

// ---------------------------------------------------------------------------
// Test 6: No-output path (Claude exits 0 without writing prd.md)
// ---------------------------------------------------------------------------

test("GENERATE_PRD: uploads empty artifacts when prd.md is not written", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-noout-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-noout");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  // Output JSON for pipeline but do NOT write prd.md
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    '#!/bin/sh\necho \'{"type":"result"}\'\nexit 0\n',
    { mode: 0o755 }
  );

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.HOME = tmpDir; // Prevents findStreamFormatter from finding real formatter
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-noout-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000050";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Generate a PRD",
        repo: { fullName: "org/repo-noout", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 200);

  // Wait for upload call
  const uploadReq = await mock.waitForRequest("upload-artifacts");
  const uploadBody = JSON.parse(uploadReq.body) as {
    artifacts: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };

  // prd should be undefined (no prd.md written)
  assert.equal(
    uploadBody.artifacts.prd,
    undefined,
    "prd should be undefined when not written"
  );

  // Wait for terminal event so worktree cleanup finishes before afterEach.
  await waitForTerminalEvent(mock.requests, loopId);
});

// ---------------------------------------------------------------------------
// Test 7: Cleanup leaves no stale git worktree entry on failure
// ---------------------------------------------------------------------------

test("GENERATE_PRD: cleans up worktree on failure (exit code 1)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "genprd-cleanup-"));
  tempPathsToClean.push(tmpDir);

  const repoPath = path.join(tmpDir, "repo-cleanup");
  await fs.mkdir(repoPath, { recursive: true });

  const worktreeParent = path.join(tmpDir, "worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  // Fake claude that exits with error
  await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });

  process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;
  process.env.HOME = tmpDir; // Prevents findStreamFormatter from finding real formatter
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();

  const mock = await startMockApiServer();
  mockServersToClose.push(mock.server);

  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: GENERATE_PRD_TEST_PORTS[0],
    fallbackPorts: GENERATE_PRD_TEST_PORTS.slice(1),
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "genprd-cleanup-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: fakeWorktreeProvider,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
  });
  serversToClose.push(server);
  await server.start();

  const loopId = "00000000-0000-0000-0000-000000000060";
  const response = await fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId,
        command: LoopCommand.GeneratePrd,
        closedLoopAuthToken: "tok",
        artifacts: [],
        prompt: "Generate a PRD",
        repo: { fullName: "org/repo-cleanup", branch: "main" },
      }),
    }
  );

  assert.equal(response.status, 200);

  // Poll until cleanup completes (worktree directory removed) instead of relying
  // on a fragile waitForRequest("events") + fixed sleep -- the first "events" match
  // is the "started" event, not the "error" event, so cleanup hasn't run yet.
  const pollDeadline = Date.now() + 15_000;
  while (Date.now() < pollDeadline) {
    const entries = await fs.readdir(worktreeParent).catch(() => []);
    if (!entries.some((e) => e.includes("generate-prd"))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Verify the directory itself is removed
  const worktreeEntries = await fs.readdir(worktreeParent).catch(() => []);
  const generatePrdEntries = worktreeEntries.filter((e) =>
    e.includes("generate-prd")
  );
  assert.equal(
    generatePrdEntries.length,
    0,
    `Worktree directory should be cleaned up, found: ${generatePrdEntries.join(", ")}`
  );
});
