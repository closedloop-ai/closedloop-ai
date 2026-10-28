/**
 * ISS-7587 — ProcessManager.spawnDetached.
 *
 * A sibling of `process-manager.test.ts`, which is chartered to exec()'s
 * branches (ISS-5299). Every child here is a short-lived `process.execPath -e`
 * script: nothing in this file resolves KNOWN_BINARY_LOCATIONS or a real
 * claude/codex binary, so the suite cannot depend on what is installed on the
 * runner.
 *
 * "a synchronous spawn rejection still closes the log descriptor" is a
 * regression test that fails against the pre-fix source: spawn() validates its
 * arguments synchronously, and the throw skipped both of spawnDetached's former
 * closeSync calls, leaking the descriptor for the life of the process.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { ProcessManager } from "../src/server/process-manager.js";
import { DirectoryNotAllowedError } from "../src/server/security.js";

const TEMP_DIR = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pm-iss7587-"))
);

const DISALLOWED_DIR = path.join(os.tmpdir(), "not-allowed-iss7587");

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── spawnDetached ──────────────────────────────────────────────────────────

test("spawnDetached returns a pid, creates the log directory, and closes the fd", async () => {
  const pm = makeProcessManager();
  const logFile = path.join(TEMP_DIR, "detached-nested", "run.log");
  const opened = trackOpenedDescriptors();

  const { pid } = await pm.spawnDetached({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("detached-output\\n");'],
    logFile,
  });

  assert.ok(pid > 0, `expected a real pid, got ${pid}`);
  assert.ok(fs.existsSync(path.dirname(logFile)));
  assertDescriptorClosed(opened);

  const text = await waitForLogContent(logFile, "detached-output");
  assert.ok(text.includes("detached-output"));
});

test("spawnDetached appends to an existing log file", async () => {
  const pm = makeProcessManager();
  const logFile = path.join(TEMP_DIR, "detached-append.log");
  fs.writeFileSync(logFile, "previous-run\n");

  await pm.spawnDetached({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("second-run\\n");'],
    logFile,
  });

  const text = await waitForLogContent(logFile, "second-run");
  assert.ok(
    text.includes("previous-run"),
    `append mode should preserve prior content, got ${JSON.stringify(text)}`
  );
});

test("a synchronous spawn rejection still closes the log descriptor", async () => {
  const pm = makeProcessManager();
  const logFile = path.join(TEMP_DIR, "detached-sync-throw.log");
  const opened = trackOpenedDescriptors();

  // A NUL byte is rejected by spawn()'s synchronous argument validation, before
  // any child exists — the path that used to skip every closeSync.
  await assert.rejects(
    () =>
      pm.spawnDetached({
        command: "bad\0command",
        logFile,
      }),
    (error: NodeJS.ErrnoException) => error.code === "ERR_INVALID_ARG_VALUE"
  );

  assertDescriptorClosed(opened);
});

test("spawnDetached rejects a logFile outside the allowed directories", async () => {
  const pm = makeProcessManager();
  const opened = trackOpenedDescriptors();

  const disallowedLog = path.join(DISALLOWED_DIR, "run.log");

  await assert.rejects(
    () =>
      pm.spawnDetached({
        command: process.execPath,
        args: ["-e", ""],
        logFile: disallowedLog,
      }),
    (error: Error) =>
      error instanceof DirectoryNotAllowedError &&
      error.targetPath === disallowedLog
  );

  // The guard runs before the descriptor is opened, so nothing can leak.
  assert.equal(opened.length, 0);
});

test("spawnDetached rejects a cwd outside the allowed directories", async () => {
  const pm = makeProcessManager();

  await assert.rejects(
    () =>
      pm.spawnDetached({
        command: process.execPath,
        args: ["-e", ""],
        cwd: DISALLOWED_DIR,
        logFile: path.join(TEMP_DIR, "unused.log"),
      }),
    (error: Error) =>
      error instanceof DirectoryNotAllowedError &&
      error.targetPath === DISALLOWED_DIR
  );
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeProcessManager(): ProcessManager {
  return new ProcessManager({ getAllowedDirectories: () => [TEMP_DIR] });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fails unless the descriptor `spawnDetached` opened has left this process's
 * table. `fstatSync` raising EBADF is a direct observation of the table, which a
 * `closeSync` call count is not — a leak is about the descriptor, not about
 * which line ran.
 *
 * Throws rather than asserting: Biome's `noMisplacedAssertion` reserves the
 * assert forms for a test body, and a throw fails the calling test the same way.
 */
function assertDescriptorClosed(opened: readonly number[]): void {
  const [fd, ...extra] = opened;
  if (fd === undefined || extra.length > 0) {
    throw new Error(
      `expected spawnDetached to open exactly one log descriptor, got ${opened.length}`
    );
  }

  try {
    fs.fstatSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") {
      return;
    }
    throw error;
  }
  throw new Error(`log descriptor ${fd} was left open`);
}

/**
 * Records every descriptor `fs.openSync` hands out for the rest of the test,
 * calling through to the real implementation. Restored by `vi.restoreAllMocks`.
 */
function trackOpenedDescriptors(): number[] {
  const opened: number[] = [];
  const openSync = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(
    (...args: Parameters<typeof fs.openSync>) => {
      const fd = openSync(...args);
      opened.push(fd);
      return fd;
    }
  );
  return opened;
}

/**
 * Reads `file` until it contains `expected`, bounded by an attempt count rather
 * than a wall-clock deadline. The child is detached and unref'd, so there is no
 * exit event to await — this is the only observation point for its output.
 */
async function waitForLogContent(
  file: string,
  expected: string
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (text.includes(expected)) {
      return text;
    }
    await delay(10);
  }
  throw new Error(
    `${file} never received ${JSON.stringify(expected)} within 1000 attempts`
  );
}
