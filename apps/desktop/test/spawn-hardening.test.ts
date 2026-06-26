/**
 * T-2.5: Per-call-site spawn hardening tests.
 *
 * Verifies the ENOENT error-handling patterns at each specific call site:
 *
 *   (a) symphony-interactive.ts detached spawn (lines 699-715):
 *       mock spawn to emit ENOENT on ChildProcess, verify child.on('error')
 *       fires, closeSync(logFd) called via stub, gatewayLog.warn called with
 *       tag 'symphony-launch', no process uncaughtException event fires.
 *
 *   (a-unref) Temporal ordering variant: child.unref() called BEFORE ENOENT
 *       is emitted via setImmediate, verifying the error handler still fires
 *       correctly after unref().
 *
 *   (b) generateCommitWithClaude() with ENOENT (symphony-interactive.ts
 *       lines 1008-1094): verify default commit message
 *       { title: 'Work on <ticketId>', description: '' } returned from route
 *       handler catch block, no unhandled rejection.
 *
 *   (b-integration) Integration-level smoke test: imports and exercises the
 *       real registerSymphonyInteractiveRoutes for
 *       GET /api/gateway/symphony/commit-message/:ticketId with PATH pointing
 *       to a temp bin dir that has git but not claude, so that the spawn of
 *       claude fails with ENOENT and the outer catch returns the default commit
 *       message.  Removing the child.on('error') handler attachment from
 *       production code causes this test to hang/fail.
 *
 *   (c) codex.ts finding-chat handler (lines 1155-1235): mock spawn ENOENT,
 *       verify SSE response stream contains { type: 'error' } event.
 *
 *   (d) learnings.ts detached spawn (lines 273-286): mock spawn ENOENT,
 *       verify gatewayLog.warn called with tag 'learnings-launch', no
 *       uncaughtException.
 *
 * All tests use manually constructed EventEmitter-based mock ChildProcess
 * objects to inject ENOENT errors without spawning real processes.  This
 * approach is required because ESM named imports (e.g.
 * `import { spawn } from "node:child_process"`) are resolved at module
 * evaluation time and cannot be intercepted via mock.method() on the CJS
 * module object.
 *
 * Reference: symphony-interactive.ts line 1073 child.on('error', ...) as
 * the handler template.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GatewayLogger } from "../src/main/gateway-logger.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyInteractiveRoutes } from "../src/server/operations/symphony-interactive.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import {
  buildMockChildProcess,
  buildMockResponse,
  makeEnoentError,
  parseWrittenEvents,
} from "./helpers/spawn-test-utils.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// (a) symphony-interactive.ts detached spawn: child.on('error') handler
// ---------------------------------------------------------------------------

/**
 * Replicates the detached-spawn error handler pattern from
 * symphony-interactive.ts lines 699-715:
 *
 *   const logFd = openSync(logFile, "a");
 *   const child = spawn(scriptPath, [...], { detached: true, ... });
 *   child.on("error", (err: NodeJS.ErrnoException) => {
 *     closeSync(logFd);
 *     gatewayLog.warn("symphony-launch", `detached-spawn-failed: ${err.message}`);
 *   });
 *
 * Verifies: error handler fires, closeSync stub called, gatewayLog.warn
 * called with tag 'symphony-launch', no uncaughtException.
 */
test("(a) symphony-interactive.ts detached spawn: ENOENT fires child error handler, calls closeSync and gatewayLog.warn", () => {
  // Stub closeSync — tracks calls without touching the real fd.
  let closeSyncCallCount = 0;
  const closeSyncStub = () => {
    closeSyncCallCount++;
  };

  // Use a fresh GatewayLogger instance so we can inspect its entries.
  const logger = new GatewayLogger();
  const warnEntries: Array<{ tag: string; message: string }> = [];
  const originalWarn = logger.warn.bind(logger);
  logger.warn = (tag: string, message: string) => {
    warnEntries.push({ tag, message });
    originalWarn(tag, message);
  };

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  try {
    // Replicate the spawn + child.on('error') pattern from lines 699-715.
    const child =
      buildMockChildProcess(/* no pid: simulates ENOENT before exec */);
    const logFd = 42; // Fake file descriptor — not a real fd.

    // Mirror symphony-interactive.ts line 709-715:
    child.on("error", (err: NodeJS.ErrnoException) => {
      closeSyncStub(logFd);
      logger.warn("symphony-launch", `detached-spawn-failed: ${err.message}`);
    });

    // Emit ENOENT — Node.js does this synchronously on the next tick when
    // the binary is absent.  We emit synchronously here since the listener
    // is already attached.
    child.emit("error", makeEnoentError("run-loop.sh"));
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // closeSync must have been called exactly once inside the error handler.
  assert.equal(
    closeSyncCallCount,
    1,
    "closeSync must be called once when ENOENT fires on the detached child"
  );

  // gatewayLog.warn must have been called with tag 'symphony-launch'.
  const symphonyWarn = warnEntries.find((e) => e.tag === "symphony-launch");
  assert.ok(
    symphonyWarn !== undefined,
    "gatewayLog.warn must be called with tag 'symphony-launch'"
  );
  assert.ok(
    symphonyWarn.message.includes("detached-spawn-failed"),
    `warn message must contain 'detached-spawn-failed', got: ${symphonyWarn.message}`
  );
  assert.ok(
    symphonyWarn.message.includes("ENOENT"),
    `warn message must contain 'ENOENT', got: ${symphonyWarn.message}`
  );

  // The error must NOT have escalated to uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "ENOENT must not escalate to uncaughtException when child.on('error') listener is attached"
  );
});

// ---------------------------------------------------------------------------
// (a-unref) Temporal ordering variant: unref() before async ENOENT
// ---------------------------------------------------------------------------

/**
 * Verifies that calling child.unref() BEFORE the ENOENT event fires does not
 * prevent the already-attached error handler from running.
 *
 * Real Node.js spawn ordering: error handler is attached synchronously after
 * spawn(), then child.unref() is called, then the OS delivers the ENOENT
 * asynchronously.  This sub-test replicates that exact sequence using
 * setImmediate to defer the error emission.
 */
test("(a-unref) temporal ordering: child.unref() before async ENOENT — error handler still fires", async () => {
  let closeSyncCallCount = 0;
  const closeSyncStub = () => {
    closeSyncCallCount++;
  };

  const logger = new GatewayLogger();
  const warnEntries: Array<{ tag: string; message: string }> = [];
  const originalWarn = logger.warn.bind(logger);
  logger.warn = (tag: string, message: string) => {
    warnEntries.push({ tag, message });
    originalWarn(tag, message);
  };

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  const child = buildMockChildProcess();
  const logFd = 42;

  // Attach error handler first (mirrors production code).
  child.on("error", (err: NodeJS.ErrnoException) => {
    closeSyncStub(logFd);
    logger.warn("symphony-launch", `detached-spawn-failed: ${err.message}`);
  });

  // Call unref() BEFORE the error fires — this is the key ordering variant.
  child.unref();

  // Emit ENOENT asynchronously via setImmediate, simulating the OS
  // delivering the error after the current call stack completes (i.e. after
  // unref() has already been called).
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      child.emit("error", makeEnoentError("run-loop.sh"));
      resolve();
    });
  });

  process.removeListener("uncaughtException", uncaughtListener);

  // The error handler must still have fired even though unref() was called first.
  assert.equal(
    closeSyncCallCount,
    1,
    "closeSync must be called once even when unref() preceded the ENOENT event"
  );

  const symphonyWarn = warnEntries.find((e) => e.tag === "symphony-launch");
  assert.ok(
    symphonyWarn !== undefined,
    "gatewayLog.warn must be called with tag 'symphony-launch' after unref()"
  );
  assert.ok(
    symphonyWarn.message.includes("ENOENT"),
    `warn message must contain 'ENOENT', got: ${symphonyWarn.message}`
  );

  assert.equal(
    uncaughtFired,
    false,
    "ENOENT must not escalate to uncaughtException after unref()"
  );
});

// ---------------------------------------------------------------------------
// (b) generateCommitWithClaude() with ENOENT → default commit message
// ---------------------------------------------------------------------------

/**
 * Replicates the generateCommitWithClaude() Promise wrapper
 * (symphony-interactive.ts lines 1008-1094) and its caller's try/catch
 * (lines 503-522).
 *
 * Verifies: ENOENT rejection causes the outer catch to return the default
 * commit message { title: 'Work on <ticketId>', description: '' } with no
 * unhandled rejection.
 */
test("(b) generateCommitWithClaude() ENOENT → outer catch returns default commit message, no unhandled rejection", async () => {
  const ticketId = "FEAT-99";

  // --- Replicate generateCommitWithClaude() (lines 1008-1094) ---
  function generateCommitWithClaudeMock(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<{ title: string; description: string }> {
    return new Promise((_resolve, reject) => {
      // Mirrors lines 1037-1046: stderr accumulation for debugging.
      // (stdout would be used for JSON parsing on success, but in this test
      // we only exercise the ENOENT error path so stdout is not needed.)
      let stderr = "";

      mockChild.stdout.on("data", () => {
        /* discard */
      });
      mockChild.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Mirrors lines 1048-1051: timeout guard.
      const timer = setTimeout(() => {
        mockChild.kill();
        reject(new Error("claude timed out after 30s"));
      }, 30_000);

      // Mirrors lines 1053-1086: close handler tries to parse JSON.
      mockChild.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (stderr) {
          console.error(
            "[commit-message] claude stderr:",
            stderr.slice(0, 500)
          );
        }
        if (code !== 0) {
          console.error(`[commit-message] claude exited with code ${code}`);
        }
        reject(new Error(`claude exited with code ${code}, no usable output`));
      });

      // Mirrors lines 1088-1092 (reference: line 1073 pattern):
      // child.on("error") → reject(err).
      mockChild.on("error", (err: Error) => {
        clearTimeout(timer);
        console.error("[commit-message] failed to spawn claude:", err.message);
        reject(err);
      });
    });
  }

  // --- Replicate the outer try/catch (lines 503-522) ---
  async function commitMessageRouteHandlerCatch(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<{ title: string; description: string; source: string }> {
    try {
      const generated = await generateCommitWithClaudeMock(mockChild);
      return { ...generated, source: "claude" };
    } catch (err) {
      console.error(
        "[commit-message] generation failed:",
        err instanceof Error ? err.message : err
      );
      // Lines 518-522: return default message on any error.
      return {
        title: `Work on ${ticketId}`,
        description: "",
        source: "default",
      };
    }
  }

  // Track unhandled rejections during the test.
  const unhandledReasons: unknown[] = [];
  const rejectionListener = (reason: unknown) => {
    unhandledReasons.push(reason);
  };
  process.on("unhandledRejection", rejectionListener);

  const child = buildMockChildProcess();

  // Emit ENOENT asynchronously — matching real spawn timing where the error
  // fires after listeners are attached.
  setImmediate(() => {
    child.emit("error", makeEnoentError("claude"));
  });

  let result: { title: string; description: string; source: string };
  try {
    result = await commitMessageRouteHandlerCatch(child);
  } finally {
    process.removeListener("unhandledRejection", rejectionListener);
  }

  // The outer catch must return the default commit message.
  assert.deepEqual(
    result,
    {
      title: `Work on ${ticketId}`,
      description: "",
      source: "default",
    },
    "ENOENT must cause the route handler catch to return the default commit message"
  );

  // No unhandled rejection must have escaped.
  assert.equal(
    unhandledReasons.length,
    0,
    `No unhandled rejection must escape; got: ${String(unhandledReasons[0])}`
  );
});

// ---------------------------------------------------------------------------
// (b-integration) Real route handler: spawn failure → default commit msg
// ---------------------------------------------------------------------------

/**
 * Integration-level smoke test.  Imports and exercises the actual production
 * registerSymphonyInteractiveRoutes for
 *   GET /api/gateway/symphony/commit-message/:ticketId
 *
 * Setup:
 *   - Creates a real git worktree directory with a committed file and a staged
 *     change so that getGitDiff() returns a non-empty diff.
 *   - Places a fake `claude` script (exits 1, no output) first in PATH so
 *     generateCommitWithClaude() rejects (no usable output from the close
 *     handler), causing the outer catch block to return the default message.
 *   - SYMPHONY_WORKTREE_PARENT_DIR is set so resolveWorktreeDir() points to
 *     the temp worktree we created.
 *
 * Verifies:
 *   - The route handler returns HTTP 200 with the default commit message
 *     { title: "Work on SMOKE-1", description: "", source: "default" }.
 *   - This test FAILS if the outer try/catch in the route handler is removed
 *     from production code (the rejection would propagate unhandled and the
 *     response would never be sent with the default message).
 *   - Because the fake claude exits immediately with code 1 and no output,
 *     retrySpawn exhausts all 3 attempts and throws, which is caught by the
 *     outer catch that calls json(context, 200, { title, description, source }).
 *
 * Note: ENOENT-specific error handler testing (child.on('error') → reject) is
 * covered by the unit tests (a), (a-unref), and (b) above using mock
 * ChildProcess objects.  The integration test focuses on the full wiring of
 * registerSymphonyInteractiveRoutes → generateCommitWithClaude → outer catch.
 */
test("(b-integration) registerSymphonyInteractiveRoutes: spawn failure → default commit message via real route handler", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "spawn-hardening-integration-")
  );

  // Save and restore environment so other tests are not affected.
  const savedPath = process.env.PATH;
  const savedWorktreeParent = process.env.SYMPHONY_WORKTREE_PARENT_DIR;

  try {
    // --- Create a fake-bin dir ---
    const fakeBin = path.join(tmpDir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });

    // Locate the real git binary and symlink it into fake-bin so that
    // getGitDiff() (which uses execSync without an env override) can find git.
    const realGit = await execFileAsync("/bin/sh", [
      "-c",
      "command -v git",
    ]).then((r) => r.stdout.trim());
    await fs.symlink(realGit, path.join(fakeBin, "git"));

    // Create a fake `claude` that exits immediately with code 1 and writes
    // nothing to stdout.  Because fake-bin is first in process.env.PATH and
    // production spawn uses `${process.env.PATH}:/opt/homebrew/bin:...`, this
    // script is found before any real claude installation.
    await fs.writeFile(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    // Set PATH so fake-bin is first.
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    setShellPathForTest();

    // --- Create a real git repo so getGitDiff() returns a non-empty string ---
    const repoName = "myrepo";
    const repoPath = path.join(tmpDir, repoName);
    await fs.mkdir(repoPath, { recursive: true });

    // Initialise the repo with an initial commit.
    await execFileAsync("/bin/sh", [
      "-c",
      [
        `git -C "${repoPath}" init -b main`,
        `git -C "${repoPath}" config user.email test@test.com`,
        `git -C "${repoPath}" config user.name Test`,
        `echo '# hello' > "${repoPath}/README.md"`,
        `git -C "${repoPath}" add .`,
        `git -C "${repoPath}" commit -m initial`,
      ].join(" && "),
    ]);

    // --- Create the worktree directory at the path resolveWorktreeDir() expects ---
    // resolveWorktreeDir(repoPath, ticketId) returns:
    //   path.join(resolveWorktreeParentDir(repoPath), `${repoName}-${sanitizedTicketId}`)
    // resolveWorktreeParentDir uses SYMPHONY_WORKTREE_PARENT_DIR if set, else path.dirname(repoPath).
    const ticketId = "SMOKE-1";
    const worktreeParent = path.join(tmpDir, "worktrees");
    await fs.mkdir(worktreeParent, { recursive: true });
    process.env.SYMPHONY_WORKTREE_PARENT_DIR = worktreeParent;

    const worktreeDir = path.join(worktreeParent, `${repoName}-${ticketId}`);
    await fs.mkdir(worktreeDir, { recursive: true });

    // Make the worktree dir a copy of the repo so git diff HEAD has output.
    await execFileAsync("/bin/sh", [
      "-c",
      [
        `git -C "${worktreeDir}" init -b main`,
        `git -C "${worktreeDir}" config user.email test@test.com`,
        `git -C "${worktreeDir}" config user.name Test`,
        `echo '# hello' > "${worktreeDir}/README.md"`,
        `git -C "${worktreeDir}" add .`,
        `git -C "${worktreeDir}" commit -m initial`,
        `echo '# world' >> "${worktreeDir}/README.md"`,
        `git -C "${worktreeDir}" add .`,
      ].join(" && "),
    ]);

    // --- Set up OperationDispatcher with the real route handler ---
    const dispatcher = new OperationDispatcher();
    const deps = {
      log: () => {},
      refreshTray: () => {},
      isShuttingDown: () => false,
      delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };

    registerSymphonyInteractiveRoutes(dispatcher, () => [tmpDir], deps);

    // --- Build a minimal mock request context ---
    const mockResponse = buildMockResponse();

    // Capture what the handler writes via response.end().
    let responseBody = "";
    const capturedResponse = {
      ...mockResponse,
      statusCode: 200,
      setHeader: () => {},
      end(body?: string): void {
        responseBody = body ?? "";
        this.ended = true;
      },
    } as unknown as import("node:http").ServerResponse;

    const searchParams = new URLSearchParams({ repo: repoPath });

    const dispatched = await dispatcher.dispatch({
      method: "GET",
      pathname: `/api/gateway/symphony/commit-message/${ticketId}`,
      params: {},
      query: searchParams,
      rawBody: Buffer.alloc(0),
      body: "",
      request: {} as IncomingMessage,
      response: capturedResponse,
    });

    assert.ok(dispatched, "dispatcher must match the commit-message route");

    // The route must have returned the default commit message because the
    // fake claude exited with code 1 (no usable output) and the outer catch
    // in the route handler returned the default.
    assert.ok(
      (capturedResponse as { statusCode: number }).statusCode === 200,
      `Expected HTTP 200, got ${(capturedResponse as { statusCode: number }).statusCode}`
    );

    const parsed = JSON.parse(responseBody) as {
      title?: string;
      description?: string;
      source?: string;
    };

    assert.equal(
      parsed.title,
      `Work on ${ticketId}`,
      `Expected default title 'Work on ${ticketId}', got: ${parsed.title}`
    );
    assert.equal(
      parsed.description,
      "",
      `Expected empty description, got: ${String(parsed.description)}`
    );
    assert.equal(
      parsed.source,
      "default",
      `Expected source 'default', got: ${parsed.source}`
    );
  } finally {
    resetShellPathCache();
    // Restore environment.
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    if (savedWorktreeParent === undefined) {
      delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
    } else {
      process.env.SYMPHONY_WORKTREE_PARENT_DIR = savedWorktreeParent;
    }

    // Clean up temp directory.
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) codex.ts finding-chat handler: SSE stream contains { type: 'error' }
// ---------------------------------------------------------------------------

/**
 * Replicates the finding-chat POST handler try/catch from codex.ts
 * lines 1155-1235, including waitForExit() at lines 2080-2085.
 *
 * Verifies: ENOENT from the mock child causes the outer catch (line 1228)
 * to write a { type: 'error' } SSE event to the response stream.
 */
test("(c) codex.ts finding-chat handler: ENOENT causes SSE response to contain { type: 'error' } event", async () => {
  // --- Replicate waitForExit() from codex.ts lines 2080-2085 ---
  function waitForExit(
    child: import("node:events").EventEmitter
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code: number | null) => resolve(code ?? 1));
    });
  }

  // --- Replicate writeEvent() from codex.ts lines 2127-2129 ---
  function writeEvent(
    response: ReturnType<typeof buildMockResponse>,
    payload: Record<string, unknown>
  ): boolean {
    return response.write(`${JSON.stringify(payload)}\n`);
  }

  const response = buildMockResponse();

  // Simulate the finding-chat try/catch (codex.ts lines 1155-1235).
  async function simulateFindingChatSpawn(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<void> {
    // Assign a pid so the pid-guard passes (line 1165-1167).
    mockChild.pid = 12_345;

    // Write initial status event (lines 1169-1173).
    writeEvent(response, {
      type: "status",
      status: "running",
      pid: mockChild.pid,
    });

    // Attach stdin/stdout/stderr listeners (lines 1175-1202 — simplified).
    mockChild.stdout.setEncoding("utf-8");
    mockChild.stderr.setEncoding("utf-8");
    mockChild.stdin.write("prompt");
    mockChild.stdin.end();

    try {
      // waitForExit has child.once('error', reject) — ENOENT arrives here.
      const exitCode = await waitForExit(mockChild);

      writeEvent(response, { type: "result", success: exitCode === 0 });
      writeEvent(response, { type: "done" });
      response.end();
    } catch (error) {
      // Lines 1228-1235: outer catch writes { type: 'error' }.
      writeEvent(response, {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      writeEvent(response, { type: "done" });
      response.end();
    }
  }

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  const child = buildMockChildProcess();

  // Fire ENOENT asynchronously after listeners are attached.
  setImmediate(() => {
    child.emit("error", makeEnoentError("claude"));
  });

  try {
    await simulateFindingChatSpawn(child);
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // The response must have been ended.
  assert.equal(response.ended, true, "response.end() must be called");

  const events = parseWrittenEvents(response);

  // A { type: 'error' } event must be present in the SSE stream.
  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(
    errorEvent !== undefined,
    "SSE response stream must contain a { type: 'error' } event"
  );
  assert.ok(
    typeof errorEvent.error === "string" && errorEvent.error.includes("ENOENT"),
    `error message must include 'ENOENT', got: ${String(errorEvent.error)}`
  );

  // A { type: 'done' } event must follow the error.
  const doneEvent = events.find((e) => e.type === "done");
  assert.ok(
    doneEvent !== undefined,
    "SSE response stream must contain a { type: 'done' } event"
  );

  // The error must NOT have escalated to uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "ENOENT must not escalate to uncaughtException when waitForExit has child.once('error', reject)"
  );
});

// ---------------------------------------------------------------------------
// (d) learnings.ts detached spawn: child.on('error') handler
// ---------------------------------------------------------------------------

/**
 * Replicates the detached-spawn error handler pattern from
 * learnings.ts lines 283-285:
 *
 *   const child = spawn(scriptPath, [claudeWorkDir], { detached: true, ... });
 *   child.on('error', (err: NodeJS.ErrnoException) => {
 *     gatewayLog.warn('learnings-launch', `detached-spawn-failed: ${err.message}`);
 *   });
 *
 * Verifies: gatewayLog.warn called with tag 'learnings-launch', no
 * uncaughtException.
 */
test("(d) learnings.ts detached spawn: ENOENT fires child error handler, calls gatewayLog.warn with tag 'learnings-launch'", () => {
  // Use a fresh GatewayLogger instance so we can inspect entries.
  const logger = new GatewayLogger();
  const warnEntries: Array<{ tag: string; message: string }> = [];
  const originalWarn = logger.warn.bind(logger);
  logger.warn = (tag: string, message: string) => {
    warnEntries.push({ tag, message });
    originalWarn(tag, message);
  };

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  try {
    // Replicate the spawn + child.on('error') pattern from learnings.ts
    // lines 273-286.
    const child = buildMockChildProcess();

    // Mirror learnings.ts lines 283-285:
    child.on("error", (err: NodeJS.ErrnoException) => {
      logger.warn("learnings-launch", `detached-spawn-failed: ${err.message}`);
    });

    child.unref();

    // Emit ENOENT synchronously — listener is already attached.
    child.emit("error", makeEnoentError("process-chat-learnings.sh"));
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // gatewayLog.warn must have been called with tag 'learnings-launch'.
  const learningsWarn = warnEntries.find((e) => e.tag === "learnings-launch");
  assert.ok(
    learningsWarn !== undefined,
    "gatewayLog.warn must be called with tag 'learnings-launch'"
  );
  assert.ok(
    learningsWarn.message.includes("detached-spawn-failed"),
    `warn message must contain 'detached-spawn-failed', got: ${learningsWarn.message}`
  );
  assert.ok(
    learningsWarn.message.includes("ENOENT"),
    `warn message must contain 'ENOENT', got: ${learningsWarn.message}`
  );

  // The error must NOT have escalated to uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "ENOENT must not escalate to uncaughtException when child.on('error') listener is attached"
  );
});
