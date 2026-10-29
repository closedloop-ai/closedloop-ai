/**
 * ISS-11414: `execFileNonBlocking`/`execNonBlocking` are drop-ins for
 * `execFileSync`/`execSync`. Each case runs the SAME command through the real
 * sync function and through the helper and compares the return value, or
 * every enumerable field of the thrown error, so a call site that swaps one
 * for the other keeps its output and its error surfacing byte for byte.
 */
import assert from "node:assert/strict";
import {
  type ExecFileSyncOptions,
  type ExecSyncOptions,
  execFileSync,
  execSync,
} from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  execFileNonBlocking,
  execNonBlocking,
  type NonBlockingExecFileOptions,
  type NonBlockingExecOptions,
} from "../src/server/non-blocking-exec.js";

/** The return value or thrown error, plus what the call wrote to the parent's stderr. */
type Outcome = ({ ok: unknown } | { thrown: Record<string, unknown> }) & {
  echoed: string;
};

/** The 1 MiB default plus one read's worth of headroom. */
const MAX_KEPT_AFTER_OVERFLOW = 1024 * 1024 + 256 * 1024;

/** The `maxBuffer` default both forms use. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** The most one pipe read returns (libuv reads at most 64 KiB at a time). */
const PIPE_READ_BYTES = 64 * 1024;

/** The overflow children write only `x`. */
const ONLY_X = /^x+$/;

/** Stands in for the kept overflow text once its bounds are checked. */
const KEPT_OVERFLOW_MARKER = "<kept overflow output>";

type OverflowKept = { code: unknown; kept: string; outputMatches: boolean };

/**
 * What an overflow kept. How a child's output splits into pipe reads varies
 * from run to run, so the kept length does too, for `execFileSync` itself as
 * much as for the non-blocking form (measured on Linux, Node 24: 1059776 or
 * 1114112 bytes for the same 2 MB write). The tests check the bounds of the
 * kept text for both forms and compare every other field exactly.
 */
function overflowKept(outcome: Outcome): OverflowKept {
  if (!("thrown" in outcome)) {
    return { code: undefined, kept: "", outputMatches: false };
  }
  const kept = String(outcome.thrown.stdout);
  const output = outcome.thrown.output;
  return {
    code: outcome.thrown.code,
    kept,
    outputMatches: Array.isArray(output) && output[1] === kept,
  };
}

/** `outcome` with its kept overflow text replaced by one marker. */
function withKeptOverflowMasked(outcome: Outcome): Outcome {
  if (!("thrown" in outcome && Array.isArray(outcome.thrown.output))) {
    return outcome;
  }
  const [stdin, , stderr] = outcome.thrown.output;
  return {
    ...outcome,
    thrown: {
      ...outcome.thrown,
      stdout: KEPT_OVERFLOW_MARKER,
      output: [stdin, KEPT_OVERFLOW_MARKER, stderr],
    },
  };
}

/** Whether `kept` is a prefix of the overflow child's output past `limit` by at most one read. */
function keptWithinOneRead(kept: string, limit: number): boolean {
  return (
    ONLY_X.test(kept) &&
    kept.length > limit &&
    kept.length <= limit + PIPE_READ_BYTES
  );
}

/** Enumerable error fields, with the per-run pid and the self-reference flattened. */
function describeThrown(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    throw new Error("sync and async failures must be Errors");
  }
  const fields: Record<string, unknown> = {
    message: error.message,
    keys: Object.keys(error).join(","),
  };
  for (const [key, value] of Object.entries(error)) {
    if (key === "pid") {
      fields.pid = typeof value;
    } else if (key === "error") {
      fields.error = value === error ? "<self>" : String(value);
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

/** Route the parent's stderr into a string while `run` executes. */
async function withParentStderr<T>(
  run: () => Promise<T>
): Promise<{ result: T; echoed: string }> {
  const original = process.stderr.write;
  let echoed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    echoed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), echoed };
  } finally {
    process.stderr.write = original;
  }
}

function syncOutcome(run: () => unknown): Promise<Outcome> {
  return outcomeOf(() => Promise.resolve().then(run));
}

function asyncOutcome(run: () => Promise<unknown>): Promise<Outcome> {
  return outcomeOf(run);
}

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  const { result, echoed } = await withParentStderr(async () => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { thrown: describeThrown(error) };
    }
  });
  return { ...result, echoed };
}

let workDir: string;
let logFd: number;

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "non-blocking-exec-"));
  execFileSync("git", ["init", "-q"], { cwd: workDir, stdio: "pipe" });
  logFd = openSync(path.join(workDir, "fd.log"), "a");
});

afterAll(() => {
  closeSync(logFd);
  rmSync(workDir, { recursive: true, force: true });
});

type FileCase = {
  name: string;
  file: string;
  args: string[];
  options: () => NonBlockingExecFileOptions;
  overflow?: true;
};

const FILE_CASES: FileCase[] = [
  {
    name: "success, utf-8",
    file: "git",
    args: ["--version"],
    options: () => ({ encoding: "utf-8", stdio: "pipe" }),
  },
  {
    name: "success, Buffer",
    file: "git",
    args: ["--version"],
    options: () => ({ stdio: "pipe" }),
  },
  {
    name: "success, all stdio ignored",
    file: "git",
    args: ["--version"],
    options: () => ({ stdio: ["ignore", "ignore", "ignore"] }),
  },
  {
    name: "success, stdout piped and stderr ignored",
    file: "git",
    args: ["--version"],
    options: () => ({ stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }),
  },
  {
    name: "non-zero exit with stderr, utf-8",
    file: "git",
    args: ["rev-parse", "--verify", "no-such-ref"],
    options: () => ({ cwd: workDir, encoding: "utf-8", stdio: "pipe" }),
  },
  {
    name: "non-zero exit with stderr, Buffer",
    file: "git",
    args: ["rev-parse", "--verify", "no-such-ref"],
    options: () => ({ cwd: workDir, stdio: "pipe" }),
  },
  {
    name: "non-zero exit, stdio omitted (stderr echoed to the parent)",
    file: "git",
    args: ["rev-parse", "--verify", "no-such-ref"],
    options: () => ({ cwd: workDir, encoding: "utf-8", timeout: 5000 }),
  },
  {
    name: "binary missing",
    file: "/no/such/binary",
    args: ["x"],
    options: () => ({ encoding: "utf-8", stdio: "pipe" }),
  },
  {
    name: "cwd missing",
    file: "git",
    args: ["status"],
    options: () => ({
      cwd: path.join(workDir, "missing"),
      encoding: "utf-8",
      stdio: "pipe",
    }),
  },
  {
    name: "timeout",
    file: "sleep",
    args: ["5"],
    options: () => ({ encoding: "utf-8", stdio: "pipe", timeout: 200 }),
  },
  {
    name: "killed by a signal",
    file: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
    options: () => ({ encoding: "utf-8", stdio: "pipe" }),
  },
  {
    name: "env reaches the child",
    file: "sh",
    args: ["-c", "echo $NON_BLOCKING_EXEC_PROBE"],
    options: () => ({
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, NON_BLOCKING_EXEC_PROBE: "42" },
    }),
  },
  {
    name: "a child that reads stdin sees EOF",
    file: "cat",
    args: [],
    options: () => ({ encoding: "utf-8", stdio: "pipe", timeout: 2000 }),
  },
  {
    name: "default maxBuffer overflow",
    file: process.execPath,
    // Stays alive after the write so both runs end on the overflow kill, not
    // on a race between that kill and the child's own exit.
    args: [
      "-e",
      "process.stdout.write('x'.repeat(2_000_000)); setTimeout(() => {}, 5000)",
    ],
    options: () => ({ encoding: "utf-8", stdio: "pipe" }),
    overflow: true,
  },
];

type ShellCase = {
  name: string;
  command: string;
  options: () => NonBlockingExecOptions;
  overflow?: true;
};

const SHELL_CASES: ShellCase[] = [
  {
    name: "success, compound command",
    command: "echo a && echo '---' && echo b",
    options: () => ({ cwd: workDir, encoding: "utf-8" }),
  },
  {
    name: "non-zero exit keeps stdout",
    command: "echo partial; exit 2",
    options: () => ({ encoding: "utf-8", stdio: "pipe" }),
  },
  {
    name: "non-zero exit, stdio omitted (stderr echoed to the parent)",
    command: "echo oops 1>&2; exit 3",
    options: () => ({ encoding: "utf-8" }),
  },
  {
    name: "output to a file descriptor, non-zero exit",
    command: "echo to-fd; exit 4",
    options: () => ({
      stdio: ["ignore", logFd, logFd],
      shell: "/bin/bash",
      timeout: 5000,
    }),
  },
  {
    name: "output to a file descriptor, timeout",
    command: "sleep 5",
    options: () => ({
      stdio: ["ignore", logFd, logFd],
      shell: "/bin/bash",
      timeout: 200,
    }),
  },
  {
    name: "output to a file descriptor, success",
    command: "echo ok",
    options: () => ({ stdio: ["ignore", logFd, logFd], shell: "/bin/bash" }),
  },
  {
    name: "timeout, piped",
    command: "sleep 5",
    options: () => ({ encoding: "utf-8", stdio: "pipe", timeout: 200 }),
  },
  {
    name: "shell missing",
    command: "echo x",
    options: () => ({ stdio: "pipe", shell: "/no/such/shell" }),
  },
  {
    name: "explicit maxBuffer overflow",
    command: "head -c 3000 /dev/zero | tr '\\000' x; exec sleep 5",
    options: () => ({ encoding: "utf-8", maxBuffer: 1000 }),
    overflow: true,
  },
  {
    name: "a shell command that reads stdin sees EOF",
    command: "cat; echo done",
    options: () => ({ encoding: "utf-8", stdio: "pipe", timeout: 2000 }),
  },
  {
    name: "missing file read",
    command: "cat /no/such/file.json",
    options: () => ({ encoding: "utf-8" }),
  },
];

describe("execFileNonBlocking matches execFileSync", () => {
  for (const scenario of FILE_CASES) {
    test(scenario.name, async () => {
      const sync = await syncOutcome(() =>
        execFileSync(
          scenario.file,
          scenario.args,
          scenario.options() as ExecFileSyncOptions
        )
      );
      const nonBlocking = await asyncOutcome(() =>
        execFileNonBlocking(scenario.file, scenario.args, scenario.options())
      );
      if (scenario.overflow) {
        const limit = scenario.options().maxBuffer ?? DEFAULT_MAX_BUFFER;
        for (const outcome of [sync, nonBlocking]) {
          const { code, kept, outputMatches } = overflowKept(outcome);
          assert.equal(code, "ENOBUFS");
          assert.ok(keptWithinOneRead(kept, limit), `kept ${kept.length}`);
          assert.ok(outputMatches);
        }
        assert.deepEqual(
          withKeptOverflowMasked(nonBlocking),
          withKeptOverflowMasked(sync)
        );
        return;
      }
      assert.deepEqual(nonBlocking, sync);
    });
  }
});

describe("execNonBlocking matches execSync", () => {
  for (const scenario of SHELL_CASES) {
    test(scenario.name, async () => {
      const sync = await syncOutcome(() =>
        execSync(scenario.command, scenario.options() as ExecSyncOptions)
      );
      const nonBlocking = await asyncOutcome(() =>
        execNonBlocking(scenario.command, scenario.options())
      );
      if (scenario.overflow) {
        const limit = scenario.options().maxBuffer ?? DEFAULT_MAX_BUFFER;
        for (const outcome of [sync, nonBlocking]) {
          const { code, kept, outputMatches } = overflowKept(outcome);
          assert.equal(code, "ENOBUFS");
          assert.ok(keptWithinOneRead(kept, limit), `kept ${kept.length}`);
          assert.ok(outputMatches);
        }
        assert.deepEqual(
          withKeptOverflowMasked(nonBlocking),
          withKeptOverflowMasked(sync)
        );
        return;
      }
      assert.deepEqual(nonBlocking, sync);
    });
  }

  test("writes through a file descriptor the same way", async () => {
    const marker = `fd-marker-${Date.now()}`;
    await execNonBlocking(`echo ${marker}`, {
      stdio: ["ignore", logFd, logFd],
      shell: "/bin/bash",
    });
    assert.match(
      readFileSync(path.join(workDir, "fd.log"), "utf-8"),
      new RegExp(marker)
    );
  });
});

describe("the event loop keeps running while a child runs", () => {
  test("a child that waits for the parent's timer finishes, which a blocking call could never do", {
    timeout: 20_000,
  }, async () => {
    const signal = path.join(workDir, `timer-fired-${Date.now()}`);
    // The child exits only after this process's timer has created the file.
    // execFileSync would block the timer until the child's own timeout.
    const timer = setTimeout(() => writeFileSync(signal, ""), 50);
    try {
      const stdout = await execFileNonBlocking(
        "sh",
        [
          "-c",
          'while [ ! -f "$1" ]; do sleep 0.02; done; echo saw-timer',
          "_",
          signal,
        ],
        { encoding: "utf-8", stdio: "pipe", timeout: 10_000 }
      );
      assert.equal(stdout, "saw-timer\n");
    } finally {
      clearTimeout(timer);
    }
  });
});

describe("output retained after a maxBuffer overflow is bounded", () => {
  test("a child that keeps writing after the overflow kill does not grow the kept output", {
    timeout: 20_000,
  }, async () => {
    const script = [
      "process.on('SIGTERM', () => {",
      "  process.stdout.write('y'.repeat(4_000_000), () => process.exit(0));",
      "});",
      "process.stdout.write('x'.repeat(2_000_000));",
      "setTimeout(() => {}, 10_000);",
    ].join("\n");
    const outcome = await asyncOutcome(() =>
      execFileNonBlocking(process.execPath, ["-e", script], {
        encoding: "utf-8",
        stdio: "pipe",
      })
    );

    assert.ok("thrown" in outcome);
    assert.equal(outcome.thrown.code, "ENOBUFS");
    const kept = String(outcome.thrown.stdout);
    assert.ok(
      kept.length < MAX_KEPT_AFTER_OVERFLOW,
      `kept ${kept.length} bytes after the overflow`
    );
    assert.equal(kept.includes("y"), false);
  });
});

describe("a timeout ends the call even while a grandchild holds the pipes", () => {
  // The grandchild sleeps far past this test's own timeout: if the call waited
  // for every pipe holder to exit, the test would time out instead of passing.
  test("matches execSync for a shell that backgrounds a long sleep", {
    timeout: 8000,
  }, async () => {
    const command = "sleep 30 & echo started";
    const options = {
      encoding: "utf-8",
      shell: "/bin/bash",
      timeout: 500,
    } as const;

    const sync = await syncOutcome(() => execSync(command, options));
    const nonBlocking = await asyncOutcome(() =>
      execNonBlocking(command, options)
    );

    assert.ok("thrown" in sync && sync.thrown.code === "ETIMEDOUT");
    assert.deepEqual(nonBlocking, sync);
  });
});
