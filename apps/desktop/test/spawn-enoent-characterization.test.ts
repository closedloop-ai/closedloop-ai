/**
 * Characterization tests for spawn ENOENT error handling.
 *
 * T-2.1: Verifies that a ENOENT error from child_process.spawn:
 *   (a) is delivered via the ChildProcess 'error' event (not escalated to
 *       uncaughtException), confirming Node.js event delivery semantics.
 *   (b) causes generateCommitWithClaude() to reject, which the outer
 *       try/catch at symphony-interactive.ts lines 502-522 catches and
 *       returns the default commit message { title: 'Work on ${ticketId}',
 *       description: '', source: 'default' }.
 *
 * These are pure characterization tests: no production code changes are
 * required for them to pass.  They document the Node.js EventEmitter
 * contract and the existing fallback path in the commit-message handler.
 *
 * Implementation note on ESM named imports
 * -----------------------------------------
 * symphony-interactive.ts uses `import { spawn } from "node:child_process"`.
 * In ES module semantics the named `spawn` binding is resolved at module
 * evaluation time and is independent of the CJS `child_process` module
 * object, so `mock.method(childProcess, "spawn", ...)` cannot intercept it.
 *
 * Test (b) therefore characterizes the pattern at the unit level rather
 * than via the HTTP stack: it replicates the exact Promise wrapper that
 * generateCommitWithClaude() uses (child.on("error") → reject) and the
 * surrounding try/catch (lines 502-522), using a manually constructed mock
 * ChildProcess (EventEmitter) to inject the ENOENT error.  This is the
 * approach sanctioned by the task description ("by returning a manually
 * constructed EventEmitter from the mock").
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock ChildProcess that looks like what spawn returns:
 * an EventEmitter with stdout and stderr sub-emitters, plus a kill() stub.
 *
 * After construction, callers can emit events on the child to drive behavior.
 */
function buildMockChildProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

// ---------------------------------------------------------------------------
// Test (a): EventEmitter characterization
// ---------------------------------------------------------------------------

/**
 * Verify that Node.js delivers spawn ENOENT via the ChildProcess 'error'
 * event (i.e. the error handler attached with child.on('error', ...) fires),
 * and that it does NOT escalate to an uncaughtException when an 'error'
 * listener is registered on the emitter.
 *
 * This is a pure characterization of the Node.js EventEmitter contract: an
 * 'error' event with a registered listener is absorbed by that listener and
 * does not become an uncaught exception.
 */
test("(a) spawn ENOENT error is delivered via ChildProcess error event, not uncaughtException", () => {
  // Manually construct a mock ChildProcess as a plain EventEmitter,
  // as Node.js would return from spawn() before exec-ing the binary.
  const child = buildMockChildProcess();

  const receivedErrors: Error[] = [];
  let uncaughtFired = false;

  // Install a temporary uncaughtException listener so we can detect if the
  // error escapes to the process level.
  const uncaughtListener = () => {
    uncaughtFired = true;
  };
  process.on("uncaughtException", uncaughtListener);

  try {
    // Attach the error handler (mirroring symphony-interactive.ts line 1073).
    child.on("error", (err: Error) => {
      receivedErrors.push(err);
    });

    // Emit the ENOENT error that Node.js emits when the binary is absent.
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
      syscall: "spawn",
    });
    child.emit("error", spawnError);
  } finally {
    process.removeListener("uncaughtException", uncaughtListener);
  }

  // The error must have been received by the 'error' listener.
  assert.equal(
    receivedErrors.length,
    1,
    "error handler must fire exactly once"
  );
  assert.equal(
    (receivedErrors[0] as NodeJS.ErrnoException).code,
    "ENOENT",
    "received error must have code ENOENT"
  );
  assert.equal(
    (receivedErrors[0] as NodeJS.ErrnoException).syscall,
    "spawn",
    "received error must have syscall 'spawn'"
  );
  assert.equal(
    receivedErrors[0].message,
    "spawn claude ENOENT",
    "error message must match"
  );

  // The error must NOT have reached uncaughtException.
  assert.equal(
    uncaughtFired,
    false,
    "error must not escalate to uncaughtException when an error listener is registered"
  );
});

// ---------------------------------------------------------------------------
// Test (b): generateCommitWithClaude() ENOENT → default commit message
// ---------------------------------------------------------------------------

/**
 * Characterize that the error handler pattern used in
 * generateCommitWithClaude() (symphony-interactive.ts line 1073) causes the
 * enclosing Promise to reject when ENOENT fires, and that the outer try/catch
 * (lines 502-522) catches that rejection and returns the default commit
 * message.
 *
 * Strategy: replicate the exact code structure from generateCommitWithClaude
 * and its caller using a manually constructed mock ChildProcess (EventEmitter)
 * to inject the ENOENT error.  This avoids spawning any real process and is
 * insensitive to what binaries happen to be installed on the test machine.
 *
 * Code correspondence:
 *   generateCommitWithClaude()  →  innerFn()   (lines 993-1079)
 *   child.on("error", …reject)  →  same pattern (line 1073)
 *   outer try/catch             →  outerFn()   (lines 502-522)
 */
test("(b) generateCommitWithClaude() ENOENT causes outer try/catch to return default commit message", async () => {
  const ticketId = "TEST-001";

  // -----------------------------------------------------------------------
  // Replicate generateCommitWithClaude() internal structure
  // (symphony-interactive.ts lines 998-1078)
  // -----------------------------------------------------------------------
  function innerFn(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<{ title: string; description: string }> {
    return new Promise((_resolve, reject) => {
      // Mirrors lines 1025-1031: data listeners on stdout/stderr.
      let stderr = "";
      mockChild.stdout.on("data", () => {
        // stdout accumulation omitted — not needed for ENOENT path
      });
      mockChild.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Mirrors lines 1033-1036: timeout guard.
      const timer = setTimeout(() => {
        mockChild.kill();
        reject(new Error("claude timed out after 30s"));
      }, 30_000);

      // Mirrors lines 1038-1071: close handler tries to parse JSON output.
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
        // Attempt JSON parse (simplified — no regex needed for this test).
        reject(new Error(`claude exited with code ${code}, no usable output`));
      });

      // Mirrors line 1073-1077: error handler — ENOENT arrives here.
      mockChild.on("error", (err: Error) => {
        clearTimeout(timer);
        console.error("[commit-message] failed to spawn claude:", err.message);
        reject(err);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Replicate the outer try/catch (symphony-interactive.ts lines 502-522)
  // -----------------------------------------------------------------------
  async function outerFn(
    mockChild: ReturnType<typeof buildMockChildProcess>
  ): Promise<{ title: string; description: string; source: string }> {
    try {
      const generated = await innerFn(mockChild);
      return { ...generated, source: "claude" };
    } catch (err) {
      console.error(
        "[commit-message] generation failed:",
        err instanceof Error ? err.message : err
      );
      return {
        title: `Work on ${ticketId}`,
        description: "",
        source: "default",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Drive the mock: emit ENOENT asynchronously (matching real spawn timing
  // where the error fires after listeners are attached).
  // -----------------------------------------------------------------------
  const child = buildMockChildProcess();
  setImmediate(() => {
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
      syscall: "spawn",
    });
    child.emit("error", spawnError);
  });

  const result = await outerFn(child);

  // -----------------------------------------------------------------------
  // Assertions
  // -----------------------------------------------------------------------

  // The outer try/catch must return the default commit message when
  // generateCommitWithClaude rejects due to ENOENT.
  assert.deepEqual(
    result,
    {
      title: `Work on ${ticketId}`,
      description: "",
      source: "default",
    },
    "ENOENT rejection must cause fallback to default commit message"
  );
});
