import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  runShutdownSequence,
  type ShutdownDeps,
  type ShutdownFailure,
} from "../src/main/lifecycle/shutdown.js";

/** Build stub deps that record call order. */
function makeStubDeps(overrides?: Partial<ShutdownDeps>) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    updateCheckTimer: null,
    clearUpdateCheckTimer: () => {
      calls.push("clearUpdateCheckTimer");
    },
    observability: {
      shutdown: async () => {
        calls.push("observability.shutdown");
      },
    },
    cloudSocket: {
      stop: () => {
        calls.push("cloudSocket.stop");
      },
    },
    commandExecutor: {
      dispose: () => {
        calls.push("commandExecutor.dispose");
      },
    },
    agentMonitor: {
      stop: () => {
        calls.push("agentMonitor.stop");
      },
    },
    server: {
      stop: async () => {
        calls.push("server.stop");
      },
    },
    desktopWindow: {
      dispose: () => {
        calls.push("desktopWindow.dispose");
      },
    },
    tray: {
      dispose: () => {
        calls.push("tray.dispose");
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

type ScheduledTimer = { id: number; callback: () => void; ms: number };

/**
 * Deterministic fake scheduler for the shutdown timers. `runShutdownSequence`
 * uses `setTimeoutFn` for BOTH the per-phase deadline and the overall deadline;
 * this harness records every scheduled timer (with its delay) and lets a test
 * fire exactly the timers it wants — by delay — so hung-phase vs
 * overall-deadline behavior is exercised without any wall-clock waits.
 *
 * Because the sequence schedules each phase's deadline only when it REACHES that
 * phase, `settleFiring(promise, ms)` advances the sequence phase-by-phase: each
 * iteration first FULLY drains the microtask queue so a phase whose work has
 * completed clears its own deadline timer, and only THEN fires a timer of the
 * given delay that is still pending — which belongs exclusively to a genuinely
 * hung phase. That ordering is what prevents a healthy phase (whose
 * `Promise.resolve().then(work).then(...)` chain needs several microtask turns
 * to settle) from being spuriously timed out.
 */
function makeFakeScheduler() {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 1;
  const setTimeoutFn = ((callback: () => void, ms?: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, callback, ms: ms ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearedIds: number[] = [];
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === "number") {
      clearedIds.push(id);
      timers.delete(id);
    }
  }) as typeof clearTimeout;

  const fireTimersWithDelay = (ms: number): boolean => {
    let fired = false;
    for (const timer of [...timers.values()]) {
      if (timer.ms === ms) {
        timers.delete(timer.id);
        timer.callback();
        fired = true;
      }
    }
    return fired;
  };

  return {
    setTimeoutFn,
    fireTimersWithDelay,
    /**
     * Drive `promise` to settlement, firing ONLY a genuinely-hung phase's
     * deadline timer. A healthy in-flight phase also has a pending delay-`ms`
     * timer for the few microtask turns before its `then(work).then(...)` chain
     * settles and clears it, so we must NOT fire a timer just because it is
     * pending. Instead, each round drains microtasks and identifies a delay-`ms`
     * timer whose id SURVIVED the drain unchanged (a healthy phase would have
     * advanced and cleared/replaced it) — that stable timer belongs to a hung
     * phase, so we fire it and advance to the next phase.
     *
     * The loop THROWS when its iteration bound is exhausted before the sequence
     * settles, so a real hang fails the test immediately instead of falling
     * through to the runner's default timeout with a still-pending promise (the
     * `test:node` determinism contract).
     */
    settleFiring: async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let settled = false;
      let value: T | undefined;
      let error: unknown;
      let rejected = false;
      promise.then(
        (resolved) => {
          settled = true;
          value = resolved;
        },
        (rejection) => {
          settled = true;
          rejected = true;
          error = rejection;
        }
      );
      const idsWithDelay = () =>
        new Set(
          [...timers.values()]
            .filter((timer) => timer.ms === ms)
            .map((timer) => timer.id)
        );
      const maxIterations = 200;
      let iteration = 0;
      let before = idsWithDelay();
      while (!settled && iteration < maxIterations) {
        await drainMicrotasks();
        iteration += 1;
        if (settled) {
          break;
        }
        const after = idsWithDelay();
        // A timer id present both before and after a full microtask drain means
        // its phase did not advance — it is hung. Fire exactly those.
        const stableHungIds = [...after].filter((id) => before.has(id));
        for (const id of stableHungIds) {
          const timer = timers.get(id);
          if (timer) {
            timers.delete(id);
            timer.callback();
          }
        }
        before = idsWithDelay();
      }
      await drainMicrotasks();
      if (!settled) {
        throw new Error(
          `settleFiring: sequence did not settle within ${maxIterations} iterations (delay ${ms}ms) — it is hung`
        );
      }
      if (rejected) {
        throw error;
      }
      return value as T;
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.ms),
    clearedIds,
    restore: () => {
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

/**
 * Drain the microtask queue so an awaited phase's `Promise.resolve().then(work)
 * .then(...)` chain fully settles (and clears its own deadline timer) before the
 * scheduler decides whether that phase is hung. 20 turns is comfortably more
 * than the chain depth of any single phase.
 */
async function drainMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/** Let queued microtasks settle so awaited phase transitions advance. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("runShutdownSequence", () => {
  test("clean path: all deps succeed, cleanup steps called in order", async () => {
    const { deps, calls } = makeStubDeps();

    const result = await runShutdownSequence(deps);

    assert.equal(result, "clean");
    assert.deepEqual(calls, [
      "clearUpdateCheckTimer",
      "observability.shutdown",
      "cloudSocket.stop",
      "commandExecutor.dispose",
      "agentMonitor.stop",
      "server.stop",
      "desktopWindow.dispose",
      "tray.dispose",
    ]);
  });

  test("hung observability.shutdown flush times out and the sequence completes cleanly (ISS-4585)", async () => {
    const scheduler = makeFakeScheduler();
    const logs: string[] = [];
    const failures: ShutdownFailure[] = [];
    const { deps, calls } = makeStubDeps({
      observability: {
        // The OTel/Datadog flush never resolves — the offline / wedged-socket
        // path that force-killed desktop-dev with SIGKILL (137) on shutdown.
        shutdown: () => new Promise<void>(() => {}),
      },
      log: (message) => logs.push(message),
      reportFailure: (failure) => failures.push(failure),
    });

    try {
      // Fire the per-phase deadline whenever a hung phase is reached; the hung
      // observability flush is abandoned and the sequence proceeds to exit.
      const result = await scheduler.settleFiring(
        runShutdownSequence(deps, {
          phaseTimeoutMs: 3000,
          setTimeoutFn: scheduler.setTimeoutFn,
        }),
        3000
      );

      // The hung flush must NOT wedge shutdown: the sequence finishes clean and
      // every later phase still runs, so the process can exit(0) — not 137.
      assert.equal(result, "clean");
      assert.deepEqual(calls, [
        "clearUpdateCheckTimer",
        "cloudSocket.stop",
        "commandExecutor.dispose",
        "agentMonitor.stop",
        "server.stop",
        "desktopWindow.dispose",
        "tray.dispose",
      ]);
      assert.equal(failures.length, 0);
      assert.match(
        logs.join("\n"),
        /shutdown phase timed out after 3000ms: observability\.shutdown — proceeding to exit/
      );
      assert.match(logs.join("\n"), /shutdown sequence end: clean/);
    } finally {
      scheduler.restore();
    }
  });

  test("hung REQUIRED phase does not block later phases but reports timed_out", async () => {
    const scheduler = makeFakeScheduler();
    const failures: ShutdownFailure[] = [];
    const logs: string[] = [];
    const { deps, calls } = makeStubDeps({
      // A mid-sequence REQUIRED phase (agentMonitor.stop) wedges; the phases
      // after it must still run once the per-phase deadline fires, BUT the run
      // must be classified timed_out — a hung required cleanup step must not
      // masquerade as a clean exit(0) (wongk, ISS-4585).
      agentMonitor: {
        stop: () => new Promise<void>(() => {}),
      },
      log: (message) => logs.push(message),
      reportFailure: (failure) => failures.push(failure),
    });

    try {
      const result = await scheduler.settleFiring(
        runShutdownSequence(deps, {
          phaseTimeoutMs: 3000,
          setTimeoutFn: scheduler.setTimeoutFn,
        }),
        3000
      );

      assert.equal(result, "timed_out");
      // server.stop / desktopWindow.dispose / tray.dispose still ran.
      assert.deepEqual(calls, [
        "clearUpdateCheckTimer",
        "observability.shutdown",
        "cloudSocket.stop",
        "commandExecutor.dispose",
        "server.stop",
        "desktopWindow.dispose",
        "tray.dispose",
      ]);
      // The timed_out failure names the hung required phase and is reported.
      assert.equal(failures.length, 1);
      assert.equal(failures[0].result, "timed_out");
      assert.equal(failures[0].phase, "agentMonitor.stop");
      assert.match(
        logs.join("\n"),
        /shutdown sequence end: timed_out phase=agentMonitor\.stop/
      );
    } finally {
      scheduler.restore();
    }
  });

  test("overall deadline still reports timed_out when a phase stays hung past every deadline", async () => {
    const scheduler = makeFakeScheduler();
    const failures: ShutdownFailure[] = [];
    const logs: string[] = [];
    const { deps } = makeStubDeps({
      server: {
        stop: () => new Promise<void>(() => {}), // never resolves
      },
      log: (message) => logs.push(message),
      reportFailure: (failure) => failures.push(failure),
    });

    try {
      // Per-phase deadline (10000ms) sits ABOVE the overall deadline (5000ms)
      // here, so the per-phase timer never wins — this isolates the overall
      // backstop: a hung server.stop that outlives every per-phase deadline must
      // still be classified timed_out at the sequence level.
      const shutdownPromise = runShutdownSequence(deps, {
        timeoutMs: 5000,
        phaseTimeoutMs: 10_000,
        setTimeoutFn: scheduler.setTimeoutFn,
      });

      // Advance into the hung server.stop phase (all earlier phases resolve
      // synchronously), then fire ONLY the overall deadline.
      await flushMicrotasks(50);
      scheduler.fireTimersWithDelay(5000);

      const result = await shutdownPromise;

      assert.equal(result, "timed_out");
      assert.equal(failures.length, 1);
      assert.equal(failures[0].result, "timed_out");
      assert.equal(failures[0].phase, "server.stop");
      assert.match(logs.join("\n"), /shutdown sequence end: timed_out/);
    } finally {
      scheduler.restore();
    }
  });

  test("hung REQUIRED server.stop times out at the PHASE deadline (before the overall) and still reports timed_out (wongk)", async () => {
    const scheduler = makeFakeScheduler();
    const failures: ShutdownFailure[] = [];
    const logs: string[] = [];
    const { deps, calls } = makeStubDeps({
      // server.stop is required cleanup and wedges. Here the per-phase deadline
      // (3000ms) sits BELOW the overall deadline (5000ms), so the phase timer
      // wins the race — the exact case wongk flagged: cleanup returns and quit
      // proceeds, but this must NOT be reported as a clean exit(0).
      server: {
        stop: () => new Promise<void>(() => {}),
      },
      log: (message) => logs.push(message),
      reportFailure: (failure) => failures.push(failure),
    });

    try {
      const result = await scheduler.settleFiring(
        runShutdownSequence(deps, {
          timeoutMs: 5000,
          phaseTimeoutMs: 3000,
          setTimeoutFn: scheduler.setTimeoutFn,
        }),
        3000
      );

      assert.equal(result, "timed_out");
      // Later required phases still ran (cleanup proceeded past the hung one).
      assert.deepEqual(calls, [
        "clearUpdateCheckTimer",
        "observability.shutdown",
        "cloudSocket.stop",
        "commandExecutor.dispose",
        "agentMonitor.stop",
        "desktopWindow.dispose",
        "tray.dispose",
      ]);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].result, "timed_out");
      assert.equal(failures[0].phase, "server.stop");
      assert.match(
        logs.join("\n"),
        /shutdown sequence end: timed_out phase=server\.stop/
      );
    } finally {
      scheduler.restore();
    }
  });

  test("failed path: a rejecting phase still reports failure and proceeds (behavior preserved)", async () => {
    const failures: ShutdownFailure[] = [];
    const { deps } = makeStubDeps({
      server: {
        stop: () => Promise.reject(new Error("stop failed")),
      },
      reportFailure: (failure) => failures.push(failure),
    });

    // Use a setTimeoutFn that never fires so no timeout can win the race.
    const neverTimeout = (() =>
      42 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout;

    const result = await runShutdownSequence(deps, {
      setTimeoutFn: neverTimeout,
    });

    assert.equal(result, "failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(
      {
        result: failures[0].result,
        phase: failures[0].phase,
        error: failures[0].error,
      },
      {
        result: "failed",
        phase: "server.stop",
        error: "stop failed",
      }
    );
  });

  test("shutdown telemetry callback failures are swallowed", async () => {
    const { deps } = makeStubDeps({
      server: {
        stop: () => Promise.reject(new Error("stop failed")),
      },
      reportFailure: () => {
        throw new Error("telemetry unavailable");
      },
    });

    const neverTimeout = (() =>
      42 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout;

    const result = await runShutdownSequence(deps, {
      setTimeoutFn: neverTimeout,
    });

    assert.equal(result, "failed");
  });

  test("overall deadline timer is cleared after cleanup resolves (no leaked handles)", async () => {
    const scheduler = makeFakeScheduler();
    const { deps } = makeStubDeps();

    try {
      const result = await runShutdownSequence(deps, {
        setTimeoutFn: scheduler.setTimeoutFn,
      });

      assert.equal(result, "clean");
      // Every scheduled timer (per-phase deadlines + the overall deadline) was
      // cleared on its winning branch — nothing left pending, no leaked handle.
      assert.deepEqual(scheduler.pendingDelays(), []);
      assert.ok(
        scheduler.clearedIds.length > 0,
        "at least one timer should have been cleared"
      );
    } finally {
      scheduler.restore();
    }
  });

  test("ISS-4903: a sync lane that did not drain before the sequence makes the verdict timed_out, never clean", async () => {
    const logs: string[] = [];
    const failures: ShutdownFailure[] = [];
    const { deps, calls } = makeStubDeps({
      log: (message) => {
        logs.push(message);
      },
      reportFailure: (failure) => {
        failures.push(failure);
      },
      // The db-host is disposed BEFORE this sequence runs, so an un-drained lane
      // cannot be a phase here — it is seeded as a completed-but-failed step.
      priorIncompletePhases: ["transcriptSync.quiesce"],
    });

    const result = await runShutdownSequence(deps);

    assert.equal(
      result,
      "timed_out",
      "shutdown must not report clean while a lane was still executing work"
    );
    assert.equal(failures.length, 1, "the un-drained lane is reported");
    assert.equal(failures[0].result, "timed_out");
    assert.equal(
      failures[0].phase,
      "transcriptSync.quiesce",
      "the verdict names the step that did not drain"
    );
    assert.ok(
      logs.some((line) =>
        line.includes(
          "shutdown pre-sequence steps did not drain: transcriptSync.quiesce"
        )
      ),
      "the log states WHY this run cannot be clean, at sequence start"
    );
    assert.ok(
      !logs.includes("shutdown sequence end: clean"),
      "the clean marker must never be emitted over live work"
    );
    // Every remaining phase still runs: an un-drained lane degrades the VERDICT,
    // it never wedges or short-circuits teardown.
    assert.deepEqual(calls, [
      "clearUpdateCheckTimer",
      "observability.shutdown",
      "cloudSocket.stop",
      "commandExecutor.dispose",
      "agentMonitor.stop",
      "server.stop",
      "desktopWindow.dispose",
      "tray.dispose",
    ]);
  });

  test("ISS-4903: an EMPTY prior-incomplete list still reports clean (drained lanes are not a failure)", async () => {
    const logs: string[] = [];
    const { deps } = makeStubDeps({
      log: (message) => {
        logs.push(message);
      },
      priorIncompletePhases: [],
    });

    assert.equal(await runShutdownSequence(deps), "clean");
    assert.ok(
      logs.includes("shutdown sequence end: clean"),
      "a fully drained teardown is still allowed to be clean"
    );
    assert.ok(
      !logs.some((line) => line.includes("did not drain")),
      "no un-drained diagnostic when every lane drained"
    );
  });

  test("ISS-4903: the EARLIEST un-drained step wins over a later required-phase timeout", async () => {
    const scheduler = makeFakeScheduler();
    const failures: ShutdownFailure[] = [];
    const { deps } = makeStubDeps({
      // A required phase that also hangs — the lane failed FIRST, so it is the
      // phase the verdict names.
      server: { stop: () => new Promise<void>(() => undefined) },
      reportFailure: (failure) => {
        failures.push(failure);
      },
      priorIncompletePhases: ["transcriptSync.quiesce"],
    });

    try {
      const pending = runShutdownSequence(deps, {
        setTimeoutFn: scheduler.setTimeoutFn,
      });
      const result = await scheduler.settleFiring(pending, 3000);

      assert.equal(result, "timed_out");
      assert.equal(failures[0].phase, "transcriptSync.quiesce");
    } finally {
      scheduler.restore();
    }
  });
});
