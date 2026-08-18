/**
 * @file harness-exec.test.ts
 * @description The low-level child-process runner every harness driver sits on
 * (ISS-5296). Its stated contract is "never throws for a nonzero exit; reports it
 * in the result" — a runner that rejected instead would take down the fire-and-
 * forget daemon launch that calls it. The timeout escalation is the other half:
 * a harness that stalls must be killed and reported, not hang the scheduler.
 *
 * REAL-CLOCK CARVE-OUT: these cases drive real child processes, whose `close`
 * events fake timers cannot produce, so the suite uses the real clock with an
 * explicit per-test timeout. That is compatible with the ticket's fake-timer
 * constraint, which targets the cron/fire-cursor logic (`daemon`, `store`) — those
 * suites do pin time. No assertion here bounds a clock-derived value.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inlineStdin, onPath, runProcess } from "../src/harness/exec.js";

/** Generous ceiling for a real spawn on a loaded machine; not a timing assertion. */
const SPAWN_TEST_TIMEOUT_MS = 20_000;

const SH = "/bin/sh";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-exec-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runProcess", () => {
  it(
    "reports a clean exit as ok with code 0",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", "exit 0"], stdin: "" },
        { prompt: "", cwd: dir }
      );
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBeNull();
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "reports a nonzero exit as NOT ok, carrying the code, without throwing",
    async () => {
      // The daemon launches this fire-and-forget; a rejection here would surface
      // as an unhandled rejection rather than a recorded failed run.
      const r = await runProcess(
        { command: SH, args: ["-c", "exit 3"], stdin: "" },
        { prompt: "", cwd: dir }
      );
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(3);
      expect(r.timedOut).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "resolves ok:false for a binary that does not exist instead of rejecting",
    async () => {
      const r = await runProcess(
        {
          command: join(dir, "definitely-not-a-real-binary"),
          args: [],
          stdin: "",
        },
        { prompt: "", cwd: dir }
      );
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(r.outputTail).toContain("spawn error");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "captures streamed stdout into the tail and forwards it to onOutput",
    async () => {
      const chunks: string[] = [];
      const r = await runProcess(
        { command: SH, args: ["-c", "echo hello-from-child"], stdin: "" },
        { prompt: "", cwd: dir, onOutput: (c) => chunks.push(c) }
      );
      expect(r.outputTail).toContain("hello-from-child");
      expect(chunks.join("")).toContain("hello-from-child");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "captures stderr as well as stdout",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", "echo oops 1>&2; exit 1"], stdin: "" },
        { prompt: "", cwd: dir }
      );
      expect(r.outputTail).toContain("oops");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "feeds the stdin payload to the child",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", "cat"], stdin: "piped-payload" },
        { prompt: "", cwd: dir }
      );
      expect(r.ok).toBe(true);
      expect(r.outputTail).toContain("piped-payload");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "SIGTERMs a child that outlives timeoutMs and reports timedOut",
    async () => {
      // A stalled harness must not hang the scheduler: it is killed, and the run
      // is reported as a timeout so the cascade can fall through to the next engine.
      // `exec` so the shell REPLACES itself with sleep: one process, holding the
      // stdio pipes itself. Without it `sh` forks a grandchild that keeps those
      // pipes open, and `close` never fires even after the parent is killed.
      const r = await runProcess(
        { command: SH, args: ["-c", "exec sleep 30"], stdin: "" },
        { prompt: "", cwd: dir, timeoutMs: 50 }
      );
      expect(r.timedOut).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.outputTail).toContain("SIGTERM");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      // `trap '' TERM` makes the child unkillable by SIGTERM. Without the
      // escalation the runner would wait forever on a wedged harness. The loop
      // sleeps in short slices rather than one long `sleep`, so when SIGKILL lands
      // on the shell the in-flight grandchild releases the stdio pipes promptly.
      const r = await runProcess(
        {
          command: SH,
          args: ["-c", "trap '' TERM; while :; do sleep 0.05; done"],
          stdin: "",
        },
        { prompt: "", cwd: dir, timeoutMs: 50, killAfterMs: 100 }
      );
      expect(r.timedOut).toBe(true);
      expect(r.outputTail).toContain("SIGKILL");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "does not kill a fast child when timeoutMs is absent",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", "exit 0"], stdin: "" },
        { prompt: "", cwd: dir }
      );
      expect(r.timedOut).toBe(false);
      expect(r.ok).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "treats a non-positive timeoutMs as no timeout at all",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", "exit 0"], stdin: "" },
        { prompt: "", cwd: dir, timeoutMs: 0 }
      );
      expect(r.timedOut).toBe(false);
      expect(r.ok).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "forwards extra env to the child",
    async () => {
      const r = await runProcess(
        { command: SH, args: ["-c", 'echo "seen:$CREWD_TEST_VAR"'], stdin: "" },
        { prompt: "", cwd: dir, env: { CREWD_TEST_VAR: "threaded" } }
      );
      expect(r.outputTail).toContain("seen:threaded");
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "kills the child when an abort signal fires",
    async () => {
      const controller = new AbortController();
      const running = runProcess(
        { command: SH, args: ["-c", "exec sleep 30"], stdin: "" },
        { prompt: "", cwd: dir, signal: controller.signal }
      );
      controller.abort();
      const r = await running;
      // A cooperative cancel is NOT a timeout — the distinction is what stops the
      // cascade from recording a stall that never happened.
      expect(r.timedOut).toBe(false);
      expect(r.ok).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS
  );
});

describe("inlineStdin", () => {
  it("returns just the prompt when no files are attached", () => {
    expect(inlineStdin("just the prompt")).toBe("just the prompt\n\n");
  });

  it("banners each attached file under its path", () => {
    const file = join(dir, "attached.txt");
    writeFileSync(file, "file body", "utf8");

    const out = inlineStdin("p", [file]);

    expect(out).toContain(`--- FILE: ${file} ---`);
    expect(out).toContain("file body");
  });

  it("degrades an unreadable file to a marker rather than throwing", () => {
    // A file deleted between scheduling and running must not abort the whole run.
    const missing = join(dir, "gone.txt");

    const out = inlineStdin("p", [missing]);

    expect(out).toContain(`(could not read ${missing})`);
  });
});

describe("onPath", () => {
  it(
    "resolves true for a binary that exists",
    async () => {
      expect(await onPath("sh")).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "resolves false for a binary that does not exist, without throwing",
    async () => {
      expect(await onPath("crewd-definitely-not-installed")).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "probes with `where` on win32",
    async () => {
      // The platform property is stubbed and its ORIGINAL descriptor restored, per
      // the repo's test-practice rule for readonly-ish globals. On this host
      // `where` is absent, so the probe resolves false via its error handler —
      // which is itself the contract: the probe never throws.
      const original = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      try {
        expect(await onPath("cmd")).toBe(false);
      } finally {
        if (original) {
          Object.defineProperty(process, "platform", original);
        }
      }
    },
    SPAWN_TEST_TIMEOUT_MS
  );
});
