/**
 * Tests for the cloneRepoViaGh helper (T-4.1 through T-4.5).
 *
 * T-4.1 — Happy-path: unit tests (returns ok+path, repos.json updated, no --branch arg)
 *          plus integration test (DesktopGatewayServer accepts EXECUTE loop, loop spawns)
 * T-4.2 — Failure-path: fake gh exits non-zero → ok:false, repos.json unchanged,
 *          REQUIRED command → 404; NOT_REQUIRED command → continues without 404
 * T-4.3 — Shell-safety: gh path with spaces, fullName with metacharacters
 * T-4.4 — Orphan cleanup: post-clone assertPathAllowed failure → destPath removed from disk
 * T-4.5 — Stderr sanitization: credential URL and hex token redacted in result.reason
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  cloneRepoViaGh,
  configureBinaryPathsResolver,
  resetResolvedClaudePath,
} from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  createFakeRunLoopScript,
  FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
  makeFakeWorktreeProvider,
  restoreEnv,
  saveEnv,
  startMockApiServer,
  waitForCompletedEvent,
  waitForTerminalEvent,
} from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Write a fake gh binary (shell script) to the given path and chmod 755. */
function writeFakeGh(scriptPath: string, scriptContent: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
}

/** Read the repos.json file from the config dir. Returns parsed array of repos. */
function readReposJson(configDir: string): Array<{ path: string }> {
  const reposPath = path.join(configDir, "repos.json");
  if (!existsSync(reposPath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(reposPath, "utf-8")) as {
    repos?: Array<{ path: string }>;
  };
  return parsed.repos ?? [];
}

const fakeWorktreeProvider = makeFakeWorktreeProvider(
  "symphony/auto-clone-test"
);

// ---------------------------------------------------------------------------
// T-4.1: Happy-path tests
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: happy path", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(null);
    for (const p of tempPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("T-4.1a: returns ok:true and path, repos.json updated", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.1a-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    const fullName = "org/myrepo";
    const expectedDestPath = path.join(sandboxDir, "myrepo");

    // Fake gh: creates the destination directory and exits 0.
    const fakeGhPath = path.join(tmpRoot, "fake-gh", "gh");
    writeFakeGh(
      fakeGhPath,
      [
        "#!/bin/sh",
        // argv[3] is the destPath
        `mkdir -p "$4"`,
        "exit 0",
      ].join("\n")
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      fullName,
      [sandboxDir],
      "loop-id-001",
      configDir
    );

    assert.equal(
      result.ok,
      true,
      `Expected ok:true, got reason: ${(result as { reason?: string }).reason ?? ""}`
    );
    assert.ok(
      result.ok && result.path === expectedDestPath,
      `Expected path ${expectedDestPath}, got ${result.ok ? result.path : "n/a"}`
    );

    // repos.json should contain an entry with path === expectedDestPath
    const repos = readReposJson(configDir);
    const hasEntry = repos.some((r) => {
      // normalizePath may store as ~ prefix; resolve both sides for comparison
      const resolved = r.path.startsWith("~")
        ? path.join(os.homedir(), r.path.slice(1))
        : r.path;
      return resolved === expectedDestPath || r.path === expectedDestPath;
    });
    assert.ok(
      hasEntry,
      `Expected repos.json to contain entry for ${expectedDestPath}, got: ${JSON.stringify(repos)}`
    );
  });

  test("T-4.1b: no --branch argument passed to gh clone", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.1b-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    const fullName = "org/nobranch";
    const captureFile = path.join(tmpRoot, "argv-capture.txt");
    const expectedDestPath = path.join(sandboxDir, "nobranch");

    // Fake gh: captures all argv to file, creates destPath, exits 0.
    const fakeGhPath = path.join(tmpRoot, "fake-gh-nobranch", "gh");
    writeFakeGh(
      fakeGhPath,
      [
        "#!/bin/sh",
        // Write each argument on its own line
        `printf '%s\\n' "$@" > ${JSON.stringify(captureFile)}`,
        `mkdir -p "$4"`,
        "exit 0",
      ].join("\n")
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      fullName,
      [sandboxDir],
      "loop-id-002",
      configDir
    );

    assert.equal(
      result.ok,
      true,
      `Expected ok:true, got reason: ${(result as { reason?: string }).reason ?? ""}`
    );

    // Read captured argv
    const captured = readFileSync(captureFile, "utf-8").trim().split("\n");
    // Expected: ['repo', 'clone', 'org/nobranch', '<destPath>']
    assert.deepEqual(captured, ["repo", "clone", fullName, expectedDestPath]);

    // No --branch argument should appear
    assert.ok(
      !captured.includes("--branch"),
      `Expected no --branch in argv, got: ${JSON.stringify(captured)}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-4.1c: Integration test
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: integration (DesktopGatewayServer)", () => {
  const serversToClose: DesktopGatewayServer[] = [];
  const mockServersToClose: http.Server[] = [];
  const tempPaths: string[] = [];
  let savedEnv: Record<string, string | undefined> | undefined;

  afterEach(async () => {
    if (savedEnv !== undefined) {
      restoreEnv(savedEnv);
      savedEnv = undefined;
    }
    configureBinaryPathsResolver(null);
    resetResolvedClaudePath();
    resetShellPathCache();

    for (const server of serversToClose.splice(0)) {
      await server.stop();
    }

    for (const ms of mockServersToClose.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        ms.close((err) => (err ? reject(err) : resolve()));
      });
    }

    for (const p of tempPaths.splice(0)) {
      await fs.rm(p, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  test("T-4.1c: EXECUTE loop auto-clones missing repo, spawns loop, persists repos.json", async () => {
    savedEnv = saveEnv();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pln284-4.1c-"));
    tempPaths.push(tmpDir);

    // getAllowedDirectories returns [tmpDir] so:
    //   - worktreeDir (under tmpDir/worktrees) passes assertPathAllowed
    //   - cloneRepoViaGh uses tmpDir as allowedDir → destPath = tmpDir/integration-repo
    //   - findLocalRepo won't find integration-repo (doesn't exist yet)
    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });

    // Config dir where repos.json will be written (inside tmpDir so allowed)
    const symphonyDir = path.join(tmpDir, "symphony");
    const configDir = path.join(symphonyDir, "config");
    await fs.mkdir(configDir, { recursive: true });

    process.env.HOME = tmpDir;

    const fullName = "integration-org/integration-repo";
    // destPath: cloneRepoViaGh uses allowedDirs[0] = tmpDir, and repoName = "integration-repo"
    // Since tmpDir/integration-repo doesn't exist and tmpDir is not a git repo,
    // destPath = path.join(tmpDir, "integration-repo")
    const expectedDestPath = path.join(tmpDir, "integration-repo");
    const argvCapture = path.join(tmpDir, "gh-argv-capture.txt");

    // Fake gh: captures argv, creates destPath directory, exits 0
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    const fakeGhScript = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvCapture)}`,
      `mkdir -p "$4"`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "gh"), fakeGhScript, { mode: 0o755 });

    // Fake git: stub all commands so no real git is needed
    const fakeGitScript = [
      "#!/bin/sh",
      'if [ "$1" = status ]; then exit 0; fi',
      'if [ "$1" = push ]; then exit 0; fi',
      'if [ "$1" = add ]; then exit 0; fi',
      'if [ "$1" = commit ]; then exit 0; fi',
      'if [ "$1" = fetch ]; then exit 0; fi',
      'if [ "$1" = "rev-parse" ]; then',
      '  if [ "$2" = "--abbrev-ref" ]; then echo "symphony/auto-clone-test"; exit 0; fi',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n");
    await fs.writeFile(path.join(fakeBin, "git"), fakeGitScript, {
      mode: 0o755,
    });

    // Fake Claude exits 0 without writing execution-result.json, while still
    // emitting token usage so EXECUTE can complete through git fallback.
    await fs.writeFile(
      path.join(fakeBin, "claude"),
      FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT,
      { mode: 0o755 }
    );

    await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

    // Configure gh override
    configureBinaryPathsResolver(() => ({ gh: path.join(fakeBin, "gh") }));

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
      // getAllowedDirectories returns [tmpDir] so worktreeDir is inside allowed area
      getAllowedDirectories: () => [tmpDir],
      machineName: "auto-clone-integration-machine",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      worktreeProvider: fakeWorktreeProvider,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
      getSymphonyDir: () => symphonyDir,
      getGatewayId: () => "test-gateway-id",
    });
    serversToClose.push(server);
    await server.start();

    const loopId = "11110000-0000-0000-0000-000000000001";
    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command: LoopCommand.Execute,
          closedLoopAuthToken: "tok",
          prompt: "test auto-clone",
          artifacts: [],
          repo: {
            fullName,
            branch: "main",
          },
        }),
      }
    );

    // (i) HTTP status is NOT 404
    assert.notEqual(
      response.status,
      404,
      `Expected non-404 response after auto-clone, got ${response.status}: ${await response.text().catch(() => "")}`
    );

    // (iii) Loop spawns — wait for upload-artifacts (signals process completed) then completed event
    await mock.waitForRequest("upload-artifacts");
    await waitForCompletedEvent(mock.requests, loopId);

    // (ii) The fake gh argv-capture contains the correct arguments
    const capturedArgv = readFileSync(argvCapture, "utf-8").trim().split("\n");
    assert.deepEqual(
      capturedArgv,
      ["repo", "clone", fullName, expectedDestPath],
      `Expected gh argv to be ['repo', 'clone', '${fullName}', '${expectedDestPath}'], got: ${JSON.stringify(capturedArgv)}`
    );

    // (iv) repos.json in config dir contains the cloned path entry
    const repos = readReposJson(configDir);
    const hasEntry = repos.some((r) => {
      const resolved = r.path.startsWith("~")
        ? path.join(os.homedir(), r.path.slice(1))
        : r.path;
      return resolved === expectedDestPath || r.path === expectedDestPath;
    });
    assert.ok(
      hasEntry,
      `Expected repos.json in ${configDir} to contain entry for ${expectedDestPath}, got: ${JSON.stringify(repos)}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-4.2: Failure-path tests
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: failure path", () => {
  const serversToClose: DesktopGatewayServer[] = [];
  const mockServersToClose: http.Server[] = [];
  const tempPaths: string[] = [];
  let savedEnv: Record<string, string | undefined> | undefined;

  afterEach(async () => {
    if (savedEnv !== undefined) {
      restoreEnv(savedEnv);
      savedEnv = undefined;
    }
    configureBinaryPathsResolver(null);
    resetShellPathCache();

    for (const server of serversToClose.splice(0)) {
      await server.stop();
    }

    for (const ms of mockServersToClose.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        ms.close((err) => (err ? reject(err) : resolve()));
      });
    }

    for (const p of tempPaths.splice(0)) {
      await fs.rm(p, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  test("T-4.2a: fake gh exits non-zero → ok:false, repos.json unchanged", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.2a-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    // Pre-populate repos.json with one existing entry
    const existingEntry = {
      path: "/existing/repo",
      addedAt: new Date().toISOString(),
    };
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({ repos: [existingEntry], settings: {} }, null, 2),
      "utf-8"
    );

    // Fake gh: exits non-zero with stderr
    const fakeGhPath = path.join(tmpRoot, "fake-gh-fail", "gh");
    writeFakeGh(
      fakeGhPath,
      ["#!/bin/sh", "echo 'fatal: repository not found' >&2", "exit 1"].join(
        "\n"
      )
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      "org/missing-repo",
      [sandboxDir],
      "loop-id-fail-001",
      configDir
    );

    // Helper returns ok:false
    assert.equal(result.ok, false, "Expected ok:false on gh failure");
    assert.ok(
      !result.ok &&
        typeof result.reason === "string" &&
        result.reason.length > 0,
      "Expected non-empty reason on failure"
    );

    // repos.json still has only the original entry, unchanged
    const repos = readReposJson(configDir);
    assert.equal(
      repos.length,
      1,
      `Expected repos.json to still have 1 entry, got: ${JSON.stringify(repos)}`
    );
    assert.equal(repos[0]?.path, existingEntry.path);
  });

  test("T-4.2b: EXECUTE command (REQUIRED) → 404 when clone fails", async () => {
    savedEnv = saveEnv();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pln284-4.2b-"));
    tempPaths.push(tmpDir);

    const sandboxDir = path.join(tmpDir, "sandbox");
    await fs.mkdir(sandboxDir, { recursive: true });

    const symphonyDir = path.join(tmpDir, "symphony");
    const configDir = path.join(symphonyDir, "config");
    await fs.mkdir(configDir, { recursive: true });

    process.env.HOME = tmpDir;

    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    // Fake gh: exits non-zero
    await fs.writeFile(
      path.join(fakeBin, "gh"),
      "#!/bin/sh\necho 'error: not found' >&2\nexit 1\n",
      { mode: 0o755 }
    );

    configureBinaryPathsResolver(() => ({ gh: path.join(fakeBin, "gh") }));

    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);

    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getAllowedDirectories: () => [sandboxDir],
      machineName: "auto-clone-fail-required-machine",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      worktreeProvider: fakeWorktreeProvider,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
      getSymphonyDir: () => symphonyDir,
      getGatewayId: () => "test-gateway-id",
    });
    serversToClose.push(server);
    await server.start();

    const loopId = "22220000-0000-0000-0000-000000000001";
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
          repo: { fullName: "org/no-such-repo", branch: "main" },
        }),
      }
    );

    // EXECUTE has repoRequirement === 'REQUIRED' → must get 404
    assert.equal(
      response.status,
      404,
      `Expected 404 for REQUIRED repo that fails to clone, got ${response.status}: ${await response.text().catch(() => "")}`
    );

    // Also check that RepoNotFound error event was posted
    const terminalEvent = await waitForTerminalEvent(mock.requests, loopId);
    assert.equal(
      terminalEvent.type,
      "error",
      `Expected error event type, got: ${String(terminalEvent.type)}`
    );
    assert.equal(
      terminalEvent.code,
      "REPO_NOT_FOUND",
      `Expected REPO_NOT_FOUND error code, got: ${String(terminalEvent.code)}`
    );
    // User-facing message must NOT contain gh output
    const message = String(terminalEvent.message ?? "");
    assert.ok(
      !message.includes("error: not found"),
      `Expected user-facing message to not contain raw gh stderr, got: ${message}`
    );
  });

  test("T-4.2c: DECOMPOSE command (NOT_REQUIRED) → NOT 404, loop continues without repo", async () => {
    savedEnv = saveEnv();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pln284-4.2c-"));
    tempPaths.push(tmpDir);

    const sandboxDir = path.join(tmpDir, "sandbox");
    await fs.mkdir(sandboxDir, { recursive: true });

    const symphonyDir = path.join(tmpDir, "symphony");
    await fs.mkdir(symphonyDir, { recursive: true });

    process.env.HOME = tmpDir;

    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    // DECOMPOSE doesn't need gh (repoRequirement is NOT_REQUIRED, clone skipped)
    await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;

    const mock = await startMockApiServer();
    mockServersToClose.push(mock.server);

    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getAllowedDirectories: () => [sandboxDir],
      machineName: "auto-clone-decompose-machine",
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
      getApiOrigin: () => `http://127.0.0.1:${mock.port}`,
      getSymphonyDir: () => symphonyDir,
      getGatewayId: () => "test-gateway-id",
    });
    serversToClose.push(server);
    await server.start();

    const loopId = "22220000-0000-0000-0000-000000000002";
    const response = await fetch(
      `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loopId,
          command: LoopCommand.Decompose,
          closedLoopAuthToken: "tok",
          prompt: "Decompose this",
          artifacts: [
            { id: "prd-1", type: "PRD", title: "My PRD", content: "content" },
          ],
          // repo.fullName present but DECOMPOSE is NOT_REQUIRED → no clone attempt
          repo: { fullName: "org/not-cloned-repo", branch: "main" },
        }),
      }
    );

    // DECOMPOSE with NOT_REQUIRED → must NOT be 404
    assert.notEqual(
      response.status,
      404,
      `Expected non-404 for DECOMPOSE (NOT_REQUIRED), got ${response.status}`
    );
    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
  });
});

// ---------------------------------------------------------------------------
// T-4.3: Shell-safety tests
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: shell safety", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(null);
    for (const p of tempPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("T-4.3a: gh binary path containing spaces — clone succeeds", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.3a-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    // gh path with a space in the directory name
    const ghDir = path.join(tmpRoot, "gh binary");
    mkdirSync(ghDir, { recursive: true });
    const fakeGhPath = path.join(ghDir, "gh");
    writeFakeGh(
      fakeGhPath,
      ["#!/bin/sh", `mkdir -p "$4"`, "exit 0"].join("\n")
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const fullName = "org/space-test";
    const result = await cloneRepoViaGh(
      fullName,
      [sandboxDir],
      "loop-id-space",
      configDir
    );

    const expectedDestPath = path.join(sandboxDir, "space-test");
    assert.equal(
      result.ok,
      true,
      `Expected ok:true with gh path with spaces, got reason: ${(result as { reason?: string }).reason ?? ""}`
    );
    assert.ok(result.ok && result.path === expectedDestPath);
    // Target directory should have been created by fake gh
    assert.ok(
      existsSync(expectedDestPath),
      `Expected ${expectedDestPath} to exist after clone`
    );
  });

  test("T-4.3b: fullName with shell metacharacters — no injection, raw string as single argv element", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.3b-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    const canaryFile = `/tmp/pwn-canary-PLN284-${Date.now()}`;
    // fullName with semicolon injection attempt — should NOT execute the touch command
    const maliciousFullName = `acme/widget;touch ${canaryFile}`;
    const captureFile = path.join(tmpRoot, "inject-argv-capture.txt");

    const fakeGhPath = path.join(tmpRoot, "fake-gh-inject", "gh");
    writeFakeGh(
      fakeGhPath,
      [
        "#!/bin/sh",
        // Write each argument on its own line to capture file
        `printf '%s\\n' "$@" > ${JSON.stringify(captureFile)}`,
        // Fake gh exits non-zero (doesn't matter for safety test)
        "exit 1",
      ].join("\n")
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    // We don't care about the result; only that no canary was created
    try {
      await cloneRepoViaGh(
        maliciousFullName,
        [sandboxDir],
        "loop-id-inject",
        configDir
      );
    } catch {
      // ignore errors — we only assert on safety
    }

    // Canary file must NOT exist (no shell injection occurred)
    assert.equal(
      existsSync(canaryFile),
      false,
      `Shell injection succeeded — canary file ${canaryFile} exists!`
    );

    // The captured argv should show fullName as a single element (not split at ;)
    if (existsSync(captureFile)) {
      const captured = readFileSync(captureFile, "utf-8").trim().split("\n");
      // argv[2] (3rd element) should be the raw malicious string intact
      assert.equal(
        captured[2],
        maliciousFullName,
        `Expected fullName to be a single argv element, got split argv: ${JSON.stringify(captured)}`
      );
    }
    // If capture file doesn't exist (pre-clone check failed), that's also fine
    // — the canary not existing is the primary safety assertion.
  });
});

// ---------------------------------------------------------------------------
// T-4.4: Orphan cleanup test
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: orphan cleanup", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(null);
    for (const p of tempPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("T-4.4: post-clone assertPathAllowed failure → destPath removed from disk", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.4-"));
    tempPaths.push(tmpRoot);

    // Strategy: fake gh creates destPath as a symlink pointing OUTSIDE allowedDir.
    // Pre-clone: assertPathAllowed(destPath, [allowedDir]) passes because destPath
    //   doesn't exist yet — canonicalization walks up to allowedDir (which is valid).
    // Post-clone: realpath(destPath) resolves the symlink to outsideDir,
    //   which is NOT under allowedDir → DirectoryNotAllowedError → cleanup runs.
    const allowedDir = path.join(tmpRoot, "allowed");
    mkdirSync(allowedDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    // Outside dir: where the symlink will point to
    const outsideDir = path.join(tmpRoot, "outside");
    mkdirSync(outsideDir, { recursive: true });

    const fullName = "org/orphan-repo";
    const destPath = path.join(allowedDir, "orphan-repo");

    // Fake gh: creates destPath as a symlink pointing outside the allowed dir.
    // This means:
    //   pre-clone: assertPathAllowed(destPath, [allowedDir]) → destPath doesn't exist yet
    //              → assertPathAllowed uses the path string check which should pass
    //              (path.startsWith check on destPath itself, which is under allowedDir)
    //   post-clone: gh creates destPath as a symlink to outsideDir
    //              → assertPathAllowed resolves realpath(destPath) = outsideDir (outside)
    //              → throws DirectoryNotAllowedError
    const fakeGhPath = path.join(tmpRoot, "fake-gh-orphan", "gh");
    writeFakeGh(
      fakeGhPath,
      [
        "#!/bin/sh",
        // Create destPath as a symlink pointing to the outside dir
        `ln -s ${JSON.stringify(outsideDir)} "$4"`,
        "exit 0",
      ].join("\n")
    );
    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      fullName,
      [allowedDir],
      "loop-id-orphan",
      configDir
    );

    // Helper returns ok:false
    assert.equal(
      result.ok,
      false,
      `Expected ok:false when post-clone path check fails, got: ${JSON.stringify(result)}`
    );

    // The orphaned destPath must have been cleaned up
    assert.equal(
      existsSync(destPath),
      false,
      `Expected ${destPath} to be removed after cleanup, but it still exists`
    );
  });
});

// ---------------------------------------------------------------------------
// T-4.5: Stderr sanitization tests
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh: stderr sanitization", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(null);
    for (const p of tempPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("T-4.5a: credential URL in stderr is redacted (://***@ pattern)", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.5a-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    // Fake gh: writes a credential URL to stderr and exits non-zero
    const fakeGhPath = path.join(tmpRoot, "fake-gh-cred", "gh");
    writeFakeGh(
      fakeGhPath,
      [
        "#!/bin/sh",
        "echo 'https://x-oauth-token:abc123@github.com/foo/bar.git' >&2",
        "exit 1",
      ].join("\n")
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      "org/cred-test",
      [sandboxDir],
      "loop-id-cred",
      configDir
    );

    assert.equal(result.ok, false, "Expected ok:false when gh exits non-zero");
    assert.ok(!result.ok, "TypeScript narrowing");

    // The reason must NOT contain the raw credential
    assert.ok(
      !result.reason.includes("abc123"),
      `Expected reason to NOT contain raw token 'abc123', got: ${result.reason}`
    );

    // The reason MUST contain the redacted form from sanitizeErrorMessage:
    // .replace(/:\/\/[^@]+@/g, "://***@")
    assert.ok(
      result.reason.includes("://***@"),
      `Expected reason to contain redacted form '://***@', got: ${result.reason}`
    );
  });

  test("T-4.5b: 40-char hex token in stderr is replaced with [REDACTED]", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "pln284-4.5b-"));
    tempPaths.push(tmpRoot);

    const sandboxDir = path.join(tmpRoot, "sandbox");
    mkdirSync(sandboxDir, { recursive: true });

    const configDir = path.join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });

    // 40-char hex string — matches `\b[0-9a-f]{20,}\b` in sanitizeErrorMessage
    const hexToken = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const fakeGhPath = path.join(tmpRoot, "fake-gh-hex", "gh");
    writeFakeGh(
      fakeGhPath,
      ["#!/bin/sh", `echo "auth failed: token=${hexToken}" >&2`, "exit 1"].join(
        "\n"
      )
    );

    configureBinaryPathsResolver(() => ({ gh: fakeGhPath }));

    const result = await cloneRepoViaGh(
      "org/hex-test",
      [sandboxDir],
      "loop-id-hex",
      configDir
    );

    assert.equal(result.ok, false, "Expected ok:false when gh exits non-zero");
    assert.ok(!result.ok, "TypeScript narrowing");

    // The hex token must appear as [REDACTED]
    assert.ok(
      result.reason.includes("[REDACTED]"),
      `Expected reason to contain '[REDACTED]', got: ${result.reason}`
    );

    // The raw hex token must NOT appear
    assert.ok(
      !result.reason.includes(hexToken),
      `Expected reason to NOT contain raw hex token '${hexToken}', got: ${result.reason}`
    );
  });
});
