import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  runShutdownSequence,
  type ShutdownDeps,
  type ShutdownFailure,
} from "../src/main/shutdown.js";

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

  test("timeout path: result is 'timed_out' when server.stop never resolves", async () => {
    const failures: ShutdownFailure[] = [];
    const logs: string[] = [];
    const { deps } = makeStubDeps({
      server: {
        stop: () => new Promise<void>(() => {}), // never resolves
      },
      log: (message) => logs.push(message),
      reportFailure: (failure) => failures.push(failure),
    });

    // Stub setTimeoutFn that fires after cleanup has advanced into server.stop.
    const stubSetTimeout = ((cb: () => void) =>
      setTimeout(cb, 0)) as unknown as typeof setTimeout;

    const result = await runShutdownSequence(deps, {
      setTimeoutFn: stubSetTimeout,
    });

    assert.equal(result, "timed_out");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].result, "timed_out");
    assert.equal(failures[0].phase, "server.stop");
    assert.match(logs.join("\n"), /shutdown sequence end: timed_out/);
  });

  test("failed path: server.stop rejects with an error", async () => {
    const failures: ShutdownFailure[] = [];
    const { deps } = makeStubDeps({
      server: {
        stop: () => Promise.reject(new Error("stop failed")),
      },
      reportFailure: (failure) => failures.push(failure),
    });

    // Use a setTimeoutFn that never fires so timeout doesn't win
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

  test("timer is cleared after cleanup resolves (no leaked handles)", async () => {
    const { deps } = makeStubDeps();

    let capturedTimerId: ReturnType<typeof setTimeout> | null = null;
    let clearTimeoutCalledWith: unknown = null;

    // Monkey-patch clearTimeout to observe the call
    const origClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      clearTimeoutCalledWith = id;
      origClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;

    try {
      // Use a real-ish setTimeoutFn that returns a recognizable timer id
      const stubSetTimeout = ((_cb: () => void, _ms: number) => {
        const _id = origClearTimeout.bind(null) as unknown as ReturnType<
          typeof setTimeout
        >;
        capturedTimerId = 12_345 as unknown as ReturnType<typeof setTimeout>;
        return capturedTimerId;
      }) as unknown as typeof setTimeout;

      const result = await runShutdownSequence(deps, {
        setTimeoutFn: stubSetTimeout,
      });

      assert.equal(result, "clean");
      assert.equal(
        clearTimeoutCalledWith,
        capturedTimerId,
        "clearTimeout should be called with the timer id returned by setTimeoutFn"
      );
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});
