import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShutdown,
  destroyBudgetMs,
  SHUTDOWN_DEADLINE_EXCEEDED_EVENT,
  ShutdownStep,
} from "../lifecycle/shutdown";

const DEADLINE_MS = 1000;
const DESTROY_MS = destroyBudgetMs(DEADLINE_MS);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createShutdown", () => {
  it("resolves only after destroy() resolves, then flushes logs", async () => {
    const destroyed = deferred();
    const flushLogs = vi.fn(() => Promise.resolve());
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const shutdown = createShutdown({
      destroy: () => destroyed.promise,
      deadlineMs: DEADLINE_MS,
      flushLogs,
    });
    let settled = false;

    const done = shutdown().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DESTROY_MS - 1);
    expect(settled).toBe(false);
    expect(flushLogs).not.toHaveBeenCalled();

    destroyed.resolve();
    await done;

    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("resolves at destroy's share of the deadline when destroy() never does, and logs it", async () => {
    const flushLogs = vi.fn(() => Promise.resolve());
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const shutdown = createShutdown({
      destroy: () => new Promise<void>(() => undefined),
      deadlineMs: DEADLINE_MS,
      flushLogs,
    });
    let settled = false;

    const done = shutdown().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DESTROY_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: SHUTDOWN_DEADLINE_EXCEEDED_EVENT,
        deadlineMs: DEADLINE_MS,
      })
    );
    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(flushLogs).toHaveBeenCalledWith(DEADLINE_MS - DESTROY_MS);
  });

  it("holds the whole shutdown to the deadline when the log intake stalls", async () => {
    vi.spyOn(log, "flush").mockReturnValue(new Promise<void>(() => undefined));
    const shutdown = createShutdown({
      destroy: () => Promise.resolve(),
      deadlineMs: DEADLINE_MS,
    });
    let settled = false;

    const done = shutdown().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });

  it("closes storage after destroy() resolves and before the log flush", async () => {
    const order: string[] = [];
    const destroyed = deferred();
    const shutdown = createShutdown({
      destroy: () => {
        order.push("destroy");
        return destroyed.promise;
      },
      closeStorage: () => {
        order.push("close");
        return Promise.resolve();
      },
      deadlineMs: DEADLINE_MS,
      flushLogs: () => {
        order.push("flush");
        return Promise.resolve();
      },
    });

    const done = shutdown();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["destroy"]);

    destroyed.resolve();
    await done;
    expect(order).toEqual(["destroy", "close", "flush"]);
  });

  it("holds a stalled storage close to destroy's share, leaving the flush its reserve", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const flushLogs = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      destroy: () => Promise.resolve(),
      closeStorage: () => new Promise<void>(() => undefined),
      deadlineMs: DEADLINE_MS,
      flushLogs,
    });
    let settled = false;

    const done = shutdown().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DESTROY_MS - 1);
    expect(settled).toBe(false);
    expect(flushLogs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(flushLogs).toHaveBeenCalledWith(DEADLINE_MS - DESTROY_MS);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: SHUTDOWN_DEADLINE_EXCEEDED_EVENT,
        step: ShutdownStep.CloseStorage,
      })
    );
  });

  it("still closes storage when destroy() overruns, without extending the deadline", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const closeStorage = vi.fn(() => new Promise<void>(() => undefined));
    const flushLogs = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      destroy: () => new Promise<void>(() => undefined),
      closeStorage,
      deadlineMs: DEADLINE_MS,
      flushLogs,
    });
    const startedAt = Date.now();

    const done = shutdown();
    await vi.advanceTimersByTimeAsync(DESTROY_MS);
    // The close gets a zero-length race: no budget left, but it still starts.
    await vi.runAllTimersAsync();
    await done;

    expect(closeStorage).toHaveBeenCalledTimes(1);
    // The flush is handed exactly what is left, and still has time to run.
    const elapsedMs = Date.now() - startedAt;
    expect(flushLogs).toHaveBeenCalledWith(DEADLINE_MS - elapsedMs);
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });

  it("flushes callbacks after destroy() and the storage close, with what is left of destroy's share", async () => {
    const order: string[] = [];
    const flushCallbacks = vi.fn((_deadlineMs: number) => {
      order.push("callbacks");
      return Promise.resolve();
    });
    let clock = 0;
    const shutdown = createShutdown({
      now: () => clock,
      destroy: () => {
        order.push("destroy");
        clock += 100;
        return Promise.resolve();
      },
      closeStorage: () => {
        order.push("close");
        return Promise.resolve();
      },
      flushCallbacks,
      deadlineMs: DEADLINE_MS,
      flushLogs: () => {
        order.push("flush");
        return Promise.resolve();
      },
    });

    await shutdown();

    expect(order).toEqual(["destroy", "close", "callbacks", "flush"]);
    expect(flushCallbacks).toHaveBeenCalledWith(DESTROY_MS - 100);
  });

  it("stops the gauges before destroy()", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      stopGauges: () => {
        order.push("stopGauges");
      },
      destroy: () => {
        order.push("destroy");
        return Promise.resolve();
      },
      deadlineMs: DEADLINE_MS,
      flushLogs: () => Promise.resolve(),
    });

    await shutdown();

    expect(order).toEqual(["stopGauges", "destroy"]);
  });

  it("returns the same promise to a second call and destroys once", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      destroy,
      deadlineMs: DEADLINE_MS,
      flushLogs: () => Promise.resolve(),
    });

    const first = shutdown();
    const second = shutdown();

    expect(second).toBe(first);
    await first;
    expect(shutdown()).toBe(first);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
