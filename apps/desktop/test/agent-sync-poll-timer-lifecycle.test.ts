import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ISS-4758: pin that BOTH desktop sync pollers leave the process exitable.
 *
 * The stress runs that found the original flake only cover passing paths —
 * none of them fails if the `unref` disappears. This one exercises the real
 * failure mode: a child arms the poller, never calls `stop()`, and must still
 * exit. Drop the `unref` in either service and the child hangs until the bound
 * below, which is exactly how the outage presented in CI (just at 30 minutes).
 */

const CHILD = fileURLToPath(
  new URL("./agent-sync-poll-timer-lifecycle-child.ts", import.meta.url)
);

// Generous next to a child that should exit in well under a second, but far
// below the node:test per-test cap so a regression fails HERE with a clear
// message instead of somewhere downstream.
const EXIT_BUDGET_MS = 20_000;

type ChildResult = { code: number | null; stdout: string; stderr: string };

test("the session-lane poll timer never keeps a process alive after a missed stop()", async () => {
  const problem = describeLaneProblem(await runLane("session"), "session");

  assert.equal(problem, null);
});

test("the invocation-lane poll timer never keeps a process alive after a missed stop()", async () => {
  const problem = describeLaneProblem(
    await runLane("invocation"),
    "invocation"
  );

  assert.equal(problem, null);
});

/** Returns a human-readable problem, or null when the lane behaved. */
function describeLaneProblem(result: ChildResult, lane: string): string | null {
  if (result.code !== 0) {
    return `${lane} lane child exited ${result.code}: ${result.stderr}`;
  }
  const probe = JSON.parse(result.stdout.trim()) as {
    armed: number;
    unrefed: number;
  };
  // Guards against a VACUOUS pass: a child that armed nothing would also exit.
  if (probe.armed === 0) {
    return `${lane} lane armed no timer, so its exit proves nothing (start() gate changed?)`;
  }
  if (probe.unrefed !== probe.armed) {
    return `${lane} lane left ${probe.armed - probe.unrefed} timer(s) holding the event loop open`;
  }
  return null;
}

function runLane(lane: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    // Inherit this process's loader flags so the TS child resolves the same way.
    const child = spawn(process.execPath, [...process.execArgv, CHILD, lane], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const budget = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${lane} lane child did not exit within ${EXIT_BUDGET_MS}ms — a poll timer is holding the event loop open (missing unref). stdout=${stdout}`
        )
      );
    }, EXIT_BUDGET_MS);
    child.on("error", (error) => {
      clearTimeout(budget);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(budget);
      resolve({ code, stdout, stderr });
    });
  });
}
