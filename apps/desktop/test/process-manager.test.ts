/**
 * ISS-5299 — Focused branch coverage for ProcessManager.exec().
 *
 * ProcessManager has no existing dedicated suite. The uncovered branches are:
 *   line 187 — both arms of the `timeoutMs === undefined ? {} : { timeout }` ternary
 *   line 211 — the `?? ""` stdout fallback (fires when the error has no .stdout)
 *   line 212 — the `?? execError.message` stderr fallback (fires when error has no .stderr)
 *   line 235 — the `!targetPath` early-return in assertOperationPath (cwd undefined)
 *
 * SECURITY CRITICAL: ProcessManager is the gateway shell-exec surface. The
 * assertOperationPath guard (line 234–240) is the last call-site fence before a
 * real child process is spawned. The cwd=undefined fast-return arm is exercised here
 * so deleting the guard breaks the coverage gate, not just the behaviour test.
 *
 * Lines 211/212: promisify(execFile) throws ERR_INVALID_ARG_VALUE synchronously
 * when the command contains a NUL byte (validated before any child is spawned).
 * That error object has no .stdout or .stderr, so both ?? fallbacks are exercised.
 * A missing binary (ENOENT) does NOT reach these fallbacks because
 * promisify(execFile) always attaches err.stdout="" and err.stderr="" on ENOENT,
 * and "" ?? x returns "" without evaluating x.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { vi } from "vitest";
import { ProcessManager } from "../src/server/process-manager.js";

// A real temp dir so the with-cwd tests pass assertPathAllowed.
const TEMP_DIR = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "pm-iss5299-"))
);

after(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeProcessManager(): ProcessManager {
  return new ProcessManager({ getAllowedDirectories: () => [TEMP_DIR] });
}

// ─── assertOperationPath line 235: early-return when cwd is undefined ───────

test("exec without cwd skips path check and succeeds", async () => {
  const pm = makeProcessManager();
  // cwd undefined → assertOperationPath(undefined) → `if (!targetPath) return`
  // The allowed-directory list is irrelevant; the guard is skipped entirely.
  const result = await pm.exec("/bin/sh", ["-c", "echo hello"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello");
  assert.equal(result.stderr, "");
});

// ─── exec() line 187: both arms of the timeoutMs ternary ────────────────────

test("exec with timeoutMs passes timeout to execFile (line 187 true arm)", async () => {
  const pm = makeProcessManager();
  const result = await pm.exec("/bin/sh", ["-c", "echo timed"], TEMP_DIR, {
    timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "timed");
});

test("exec without timeoutMs spreads empty object for execFile (line 187 false arm)", async () => {
  const pm = makeProcessManager();
  // options defaults to {} → timeoutMs is undefined → {} spread
  const result = await pm.exec("/bin/sh", ["-c", "echo untimed"], TEMP_DIR);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "untimed");
});

// ─── exec() lines 211/212: ?? fallbacks when error has no stdout/stderr ─────

test("exec with NUL byte in command exercises stdout?? and stderr?? fallbacks", async () => {
  const pm = makeProcessManager();
  // No cwd → assertOperationPath returns early.
  // NUL byte triggers synchronous ERR_INVALID_ARG_VALUE before any child spawns.
  // The thrown Error has no .stdout/.stderr so both ?? fallbacks fire.
  const result = await pm.exec("bad\0cmd", []);
  assert.equal(result.exitCode, 1);
  assert.equal(typeof result.errorCode, "string"); // "ERR_INVALID_ARG_VALUE"
  // stdout ?? "" — the right-hand "" is used (line 211)
  assert.equal(result.stdout, "");
  // stderr ?? execError.message — the message is used (line 212)
  assert.ok(
    result.stderr.length > 0,
    "stderr should contain the error message"
  );
});

// ─── Behavioural tests — security-critical path ─────────────────────────────

test("exec on missing binary returns errorCode, errorPath, errorSyscall, exitCode 1", async () => {
  const pm = makeProcessManager();
  const result = await pm.exec("/nonexistent_binary_xyz_iss5299", []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, "ENOENT");
  assert.equal(typeof result.errorPath, "string");
  assert.equal(typeof result.errorSyscall, "string");
});

test("exec captures numeric exit code from subprocess", async () => {
  const pm = makeProcessManager();
  const result = await pm.exec("/bin/sh", ["-c", "exit 3"]);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
});

test("killProcessGroup(0) is a no-op — zero pid rejected before any signal", async () => {
  const pm = makeProcessManager();
  // !0 is true → early return, no SIGTERM sent
  await assert.doesNotReject(() => pm.killProcessGroup(0, 0));
});

test("killProcessGroup(-1) is a no-op — negative pid rejected before any signal", async () => {
  const pm = makeProcessManager();
  // -1 < 1 is true → early return, no SIGTERM sent
  await assert.doesNotReject(() => pm.killProcessGroup(-1, 0));
});

test("killProcessGroup stops after SIGTERM when the process group exits", async () => {
  const signals: [number, string | number | undefined][] = [];
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        const error = new Error(
          "process does not exist"
        ) as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }
  );

  await makeProcessManager().killProcessGroup(42, 0);

  assert.deepEqual(signals, [
    [-42, "SIGTERM"],
    [42, 0],
  ]);
});

test("killProcessGroup escalates to SIGKILL while the process is running", async () => {
  const signals: [number, string | number | undefined][] = [];
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      signals.push([pid, signal]);
      return true;
    }
  );

  await makeProcessManager().killProcessGroup(42, 0);

  assert.deepEqual(signals, [
    [-42, "SIGTERM"],
    [42, 0],
    [-42, "SIGKILL"],
  ]);
});

test("killProcessGroup propagates non-ESRCH signal failures", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    const error = new Error("operation not permitted") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  });

  await assert.rejects(
    () => makeProcessManager().killProcessGroup(42, 0),
    (error: NodeJS.ErrnoException) => error.code === "EPERM"
  );
});

test("killProcessGroup tolerates a process group that already exited", async () => {
  const signals: [number, string | number | undefined][] = [];
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      signals.push([pid, signal]);
      const error = new Error(
        "process does not exist"
      ) as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }
  );

  await assert.doesNotReject(() =>
    makeProcessManager().killProcessGroup(42, 0)
  );
  assert.deepEqual(signals, [
    [-42, "SIGTERM"],
    [42, 0],
  ]);
});

test("killProcessGroup propagates non-ESRCH process probes", async () => {
  vi.spyOn(process, "kill").mockImplementation(
    (_pid: number, signal?: string | number) => {
      if (signal === 0) {
        const error = new Error(
          "operation not permitted"
        ) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return true;
    }
  );

  await assert.rejects(
    () => makeProcessManager().killProcessGroup(42, 0),
    (error: NodeJS.ErrnoException) => error.code === "EPERM"
  );
});
