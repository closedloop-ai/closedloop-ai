import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHealthProbe,
  DOC_SYNC_DEPENDENCY_LOST_EVENT,
  DOC_SYNC_DEPENDENCY_RESTORED_EVENT,
  DocSyncDependency,
} from "../http/health-probe";

const TIMEOUT_MS = 2000;
const CACHE_MS = 1000;

let error: ReturnType<typeof spyError>;
let info: ReturnType<typeof spyInfo>;

function spyError() {
  return vi.spyOn(log, "error").mockImplementation(() => undefined);
}

function spyInfo() {
  return vi.spyOn(log, "info").mockImplementation(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
  error = spyError();
  info = spyInfo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function probe(ping: () => Promise<void>) {
  return createHealthProbe({ ping, timeoutMs: TIMEOUT_MS, cacheMs: CACHE_MS });
}

function refused(): Promise<void> {
  return Promise.reject(
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
  );
}

function lostLogs() {
  return error.mock.calls.filter(
    ([, fields]) =>
      JSON.stringify(fields).includes(DOC_SYNC_DEPENDENCY_LOST_EVENT) === true
  );
}

function restoredLogs() {
  return info.mock.calls.filter(
    ([, fields]) =>
      JSON.stringify(fields).includes(DOC_SYNC_DEPENDENCY_RESTORED_EVENT) ===
      true
  );
}

describe("createHealthProbe", () => {
  it("reports ok when the ping resolves, and logs nothing", async () => {
    await expect(probe(() => Promise.resolve()).check()).resolves.toEqual({
      ok: true,
    });

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("reports not ok when the ping rejects, logging the loss once with its code", async () => {
    await expect(probe(refused).check()).resolves.toEqual({ ok: false });

    expect(error).toHaveBeenCalledWith("Doc sync dependency lost", {
      event: DOC_SYNC_DEPENDENCY_LOST_EVENT,
      dependency: DocSyncDependency.Database,
      code: "ECONNREFUSED",
    });
  });

  it("reports not ok at the timeout when the ping never settles, with code timeout", async () => {
    let verdict: { ok: boolean } | undefined;
    probe(() => new Promise<void>(() => undefined))
      .check()
      .then((settled) => {
        verdict = settled;
      });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(verdict).toEqual({ ok: false });
    expect(error).toHaveBeenCalledWith(
      "Doc sync dependency lost",
      expect.objectContaining({ code: "timeout" })
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a second ping while a timed-out one is still pending", async () => {
    let settle: (() => void) | undefined;
    const ping = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const health = probe(ping);

    const first = health.check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(first).resolves.toEqual({ ok: false });
    await vi.advanceTimersByTimeAsync(CACHE_MS);
    const second = health.check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(second).resolves.toEqual({ ok: false });
    expect(ping).toHaveBeenCalledTimes(1);

    settle?.();
    await vi.advanceTimersByTimeAsync(CACHE_MS);
    const third = health.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(ping).toHaveBeenCalledTimes(2);
    settle?.();
    await expect(third).resolves.toEqual({ ok: true });
  });

  it("shares one ping between concurrent checks", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const health = probe(ping);

    const verdicts = await Promise.all([health.check(), health.check()]);

    expect(verdicts).toEqual([{ ok: true }, { ok: true }]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("reuses a verdict younger than cacheMs, and pings again after it", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const health = probe(ping);

    await health.check();
    await vi.advanceTimersByTimeAsync(CACHE_MS - 1);
    await health.check();
    expect(ping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await health.check();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("logs a loss once across repeated failures, and a restore once on recovery", async () => {
    let up = false;
    const health = probe(() => (up ? Promise.resolve() : refused()));

    await health.check();
    await vi.advanceTimersByTimeAsync(CACHE_MS);
    await health.check();
    expect(lostLogs()).toHaveLength(1);
    expect(restoredLogs()).toHaveLength(0);

    up = true;
    await vi.advanceTimersByTimeAsync(CACHE_MS);
    await expect(health.check()).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(CACHE_MS);
    await health.check();

    expect(restoredLogs()).toEqual([
      [
        "Doc sync dependency restored",
        {
          event: DOC_SYNC_DEPENDENCY_RESTORED_EVENT,
          dependency: DocSyncDependency.Database,
        },
      ],
    ]);
    expect(lostLogs()).toHaveLength(1);
  });
});
