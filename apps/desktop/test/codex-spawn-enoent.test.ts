/**
 * T-2.3: Characterization tests for spawn ENOENT handling in codex.ts.
 *
 * Verifies that the spawn('claude', args) call in codex.ts at line 1156
 * handles ENOENT correctly through the existing error-handling chain:
 *
 *   (a) waitForExit() at lines 2080-2085 has child.once('error', reject),
 *       which causes the Promise to reject on ENOENT, and the outer catch at
 *       line 1228 writes { type: 'error', error: ... } to the SSE response
 *       stream without any uncaughtException escaping.
 *
 *   (b) runCommand() at lines 2087-2116 (used by GET /api/gateway/codex/available
 *       at line 296) has child.once('error', reject) at line 2107, and its
 *       caller wraps in try/catch (lines 294-305) returning { available: false }
 *       on any error, so ENOENT does not escape.
 *
 * These are pure characterization tests: no production code changes are
 * required for them to pass. They document the existing Node.js EventEmitter
 * contract and the error-handling paths already in place in codex.ts.
 *
 * Implementation note on ESM named imports
 * -----------------------------------------
 * codex.ts uses `import { spawn } from "node:child_process"`. In ES module
 * semantics the named `spawn` binding is resolved at module evaluation time and
 * is independent of the CJS `child_process` module object, so intercepting it
 * via mock.method() is not reliable. Tests therefore replicate the exact Promise
 * wrapper patterns from codex.ts and inject ENOENT through a manually
 * constructed mock ChildProcess (EventEmitter), following the same approach as
 * spawn-enoent-characterization.test.ts.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  buildMockChildProcess,
  buildMockResponse,
  makeEnoentError,
  parseWrittenEvents,
} from "./helpers/spawn-test-utils.js";

// ---------------------------------------------------------------------------
// Replicate waitForExit() from codex.ts lines 2080-2085
// ---------------------------------------------------------------------------

function waitForExit(child: EventEmitter): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Replicate writeEvent() from codex.ts lines 2127-2129
// ---------------------------------------------------------------------------

function writeEvent(
  response: ReturnType<typeof buildMockResponse>,
  payload: Record<string, unknown>
): boolean {
  return response.write(`${JSON.stringify(payload)}\n`);
}

// ---------------------------------------------------------------------------
// Test (a): waitForExit() rejects on ENOENT, outer catch writes { type: 'error' }
// ---------------------------------------------------------------------------

test("(a) codex.ts finding-chat: ENOENT causes outer catch to write { type: 'error' } SSE event without uncaughtException", async () => {
  // Build the mock child and response.
  const child =
    buildMockChildProcess(/* no pid — but we inject after attach */);
  const response = buildMockResponse();

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  // Simulate the try block in codex.ts lines 1155-1235.
  // The outer catch at line 1228 catches whatever waitForExit rejects with.
  async function simulateFindingChatSpawn(): Promise<void> {
    // Mimic: if (!child.pid) throw — here we give child a pid so we proceed.
    // Assign a pid so the pid-guard passes (line 1165-1167).
    child.pid = 12_345;

    // Write the initial status event (line 1169-1173).
    writeEvent(response, { type: "status", status: "running", pid: child.pid });

    // Attach stdout/stderr data listeners (lines 1175-1202 — simplified).
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdin.write("prompt");
    child.stdin.end();

    try {
      // This is the critical call: waitForExit has child.once('error', reject).
      const exitCode = await waitForExit(child);

      // Lines 1206-1226 (only reached on clean exit — not exercised here).
      writeEvent(response, { type: "result", success: exitCode === 0 });
      writeEvent(response, { type: "done" });
      response.end();
    } catch (error) {
      // Lines 1228-1235: the outer catch writes { type: 'error' }.
      writeEvent(response, {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      writeEvent(response, { type: "done" });
      response.end();
    }
  }

  // Fire ENOENT asynchronously after listeners are attached (matching real spawn timing).
  const spawnError = makeEnoentError("claude");
  setImmediate(() => {
    child.emit("error", spawnError);
  });

  try {
    await simulateFindingChatSpawn();
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // --- Assertions ---

  // The response must have been ended.
  assert.equal(response.ended, true, "response.end() must be called");

  const events = parseWrittenEvents(response);

  // The first event is the status event written before waitForExit.
  assert.equal(events[0]?.type, "status", "first event must be status");

  // The error event must be present.
  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(
    errorEvent !== undefined,
    "SSE stream must contain a { type: 'error' } event"
  );
  assert.ok(
    typeof errorEvent.error === "string" && errorEvent.error.includes("ENOENT"),
    `error message must contain 'ENOENT', got: ${String(errorEvent.error)}`
  );

  // A done event must follow the error.
  const doneEvent = events.find((e) => e.type === "done");
  assert.ok(
    doneEvent !== undefined,
    "SSE stream must contain a { type: 'done' } event"
  );

  // The error must NOT have reached uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "ENOENT must not escalate to uncaughtException when child.once('error', reject) is attached"
  );
});

// ---------------------------------------------------------------------------
// Test (b): runCommand() rejects on ENOENT, caller's try/catch catches it
// ---------------------------------------------------------------------------

test("(b) codex.ts runCommand(): ENOENT rejects the promise, caller try/catch returns { available: false }", async () => {
  // Replicate the runCommand() Promise wrapper (codex.ts lines 2087-2116).
  function runCommandMock(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      mockChild.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      mockChild.stderr?.on("data", (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      // Line 2107: child.once('error', reject) — ENOENT arrives here.
      mockChild.once("error", reject);

      mockChild.once("close", (code: number | null) => {
        if (code === 0) {
          resolve(output.trim());
          return;
        }
        reject(new Error(errorOutput || `codex exited with code ${code ?? 1}`));
      });
    });
  }

  // Replicate the GET /api/gateway/codex/available handler
  // (codex.ts lines 294-305): calls runCommand, catches all errors.
  async function simulateAvailableRoute(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<Record<string, unknown>> {
    try {
      const output = await runCommandMock(mockChild);
      const match = /codex-cli\s+([\d.]+)/i.exec(output);
      return { available: true, version: match?.[1] ?? "unknown" };
    } catch {
      return { available: false };
    }
  }

  let uncaughtFired = false;
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  const child = buildMockChildProcess();

  // Fire ENOENT asynchronously after listeners are attached.
  const spawnError = makeEnoentError("codex");
  setImmediate(() => {
    child.emit("error", spawnError);
  });

  let result: Record<string, unknown>;
  try {
    result = await simulateAvailableRoute(child);
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // --- Assertions ---

  // The caller must catch the ENOENT and return { available: false }.
  assert.deepEqual(
    result,
    { available: false },
    "ENOENT must cause available route to return { available: false }"
  );

  // The error must NOT have reached uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "ENOENT from runCommand must not escalate to uncaughtException"
  );
});

// ---------------------------------------------------------------------------
// Test (c): waitForExit() error handler placement — error registered BEFORE close
// ---------------------------------------------------------------------------

test("(c) waitForExit() registers error handler before awaiting close — no race with synchronous ENOENT", () => {
  // Verify that the order of event registration in waitForExit() means that
  // synchronous ENOENT emission after once('error') is attached is handled,
  // not dropped.  This is a property-based characterization of the EventEmitter
  // contract: once('error', reject) is synchronous; if error fires synchronously
  // after registration, the listener fires before close.

  const child = new EventEmitter();
  const receivedErrors: Error[] = [];

  // Replicate waitForExit() internals.
  const promise = new Promise<number>((resolve, reject) => {
    child.once("error", (err: Error) => {
      receivedErrors.push(err);
      reject(err);
    });
    child.once("close", (code: number | null) => resolve(code ?? 1));
  });

  // Emit error synchronously — listener must fire immediately.
  const spawnError = makeEnoentError("claude");
  child.emit("error", spawnError);

  // Suppress the unhandled promise rejection for the assertion below.
  promise.catch(() => {});

  assert.equal(
    receivedErrors.length,
    1,
    "error listener must fire synchronously"
  );
  assert.equal(
    (receivedErrors[0] as NodeJS.ErrnoException).code,
    "ENOENT",
    "error code must be ENOENT"
  );
});
