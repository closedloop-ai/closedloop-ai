/**
 * @file ISS-11283 branch coverage for
 * database/database-integrity/store-integrity-probe.ts paths the existing
 * suite (store-integrity-probe.test.ts) never exercises: firstRowValue's
 * non-object-row guard, classifyIndexPresence/runOnce's defensive
 * Array.isArray checks against a version-skewed reader payload, the WAL
 * probe's ternary false arm (no lastAnomalyReason), an optional check's read
 * rejecting with a non-Error value, runImportSafeChecks' own truncation arm,
 * the poll tick's own catch ternary (Error vs non-Error), start() called
 * twice, and stop() called without a prior start().
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createStoreIntegrityProbe,
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityReader,
} from "../src/main/database/database-integrity/store-integrity-probe.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import { deferred } from "./deferred.js";

const noopEmit = (_: StoreIntegrityDiagnostics): void => {};

/** A scripted reader. This is a copy of the private helper in
 *  store-integrity-probe.test.ts (that suite does not export it), kept
 *  identical in shape and behavior. */
function scriptedReader(script: {
  quickCheck?: unknown[];
  indexes?: { name: string }[];
}): StoreIntegrityReader {
  return {
    runStoreIntegrityCheck: () =>
      Promise.resolve({
        quickRows: (script.quickCheck ?? []) as Record<string, unknown>[],
        indexRows: script.indexes ?? [],
      }),
  };
}

/** Waits for the Nth `onTickSettled` firing (1-indexed) so a test can prove a
 *  tick fully ran without a blind sleep. */
function tickWaiter(count: number): {
  onTickSettled: () => void;
  ready: Promise<void>;
} {
  let seen = 0;
  const ready = deferred();
  return {
    onTickSettled: () => {
      seen += 1;
      if (seen >= count) {
        ready.resolve();
      }
    },
    ready: ready.promise,
  };
}

describe("firstRowValue: non-object row", () => {
  it("classifies a raw non-object quick_check row as healthy (undefined -> null)", async () => {
    // A version-skewed host can answer `quickRows` entries that are not row
    // objects at all; the typed contract forbids this in-process, so the cast
    // below represents exactly what crosses the untyped db-host proxy.
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({
          quickRows: [null, 42] as unknown as Record<string, unknown>[],
          indexRows: [],
        }),
    };
    const probe = createStoreIntegrityProbe(reader, { emit: noopEmit });
    const result = await probe.runOnce();
    expect(result.healthy).toBe(true);
    expect(result.issueCount).toBe(0);
  });
});

describe("classifyIndexPresence / runOnce: defensive Array.isArray guards", () => {
  it("treats a non-array indexRows payload as no indexes present, without throwing", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({
          quickRows: [{ quick_check: "ok" }],
          indexRows: undefined as unknown as { name: string }[],
        }),
    };
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      expectedIndexNames: ["idx_expected"],
    });
    const result = await probe.runOnce();
    expect(result.healthy).toBe(false);
    expect(result.issues).toEqual([
      {
        check: "index_presence",
        category: "missing_index",
        object: "idx_expected",
        objectType: "index",
      },
    ]);
  });

  it("treats a non-array quickRows payload as no quick_check rows to classify", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({
          quickRows: undefined as unknown as Record<string, unknown>[],
          indexRows: [],
        }),
    };
    const probe = createStoreIntegrityProbe(reader, { emit: noopEmit });
    const result = await probe.runOnce();
    expect(result.healthy).toBe(true);
    expect(result.issueCount).toBe(0);
  });
});

describe("classifyWalProbeHealth: ternary false arm (no lastAnomalyReason)", () => {
  it("pushes a wal_frame_probe issue with no object/objectType when the reason is null", async () => {
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({
          quickRows: [{ quick_check: "ok" }],
          indexRows: [],
        }),
      readWalProbeHealth: () =>
        Promise.resolve({
          measurable: true,
          probes: 10,
          anomalies: 3,
          lastAnomalyReason: null,
        }),
    };
    const probe = createStoreIntegrityProbe(reader, { emit: noopEmit });
    const result = await probe.runOnce();
    expect(result.healthy).toBe(false);
    const walIssues = result.issues.filter(
      (issue) => issue.check === "wal_frame_probe"
    );
    expect(walIssues).toEqual([
      { check: "wal_frame_probe", category: "wal_probe_failure" },
    ]);
  });
});

describe("runOptionalCheck: catch ternary over a rejected read", () => {
  it("logs String(error) when an optional check's read rejects with a non-Error value", async () => {
    const logs: string[] = [];
    const explodingCheck = defineStoreIntegrityOptionalCheck({
      name: "token_parity",
      label: "rejecting read",
      read: () => Promise.reject("read-boom-string"),
      schema: z.unknown(),
      classify: () => {
        // Never reached: the read rejects before classify runs.
      },
    });
    const probe = createStoreIntegrityProbe(
      scriptedReader({ quickCheck: [{ quick_check: "ok" }] }),
      {
        emit: noopEmit,
        log: (message) => logs.push(message),
        extraChecks: [explodingCheck],
      }
    );
    const result = await probe.runOnce();
    expect(result.healthy).toBe(true);
    expect(result.checksRun.includes("token_parity")).toBe(false);
    expect(logs).toContain(
      "store-integrity: rejecting read failed: read-boom-string"
    );
  });
});

describe("runImportSafeChecks: its own truncation arm", () => {
  it("truncates a boot-import-safe check's issues and reports truncated=true", async () => {
    const emitted: StoreIntegrityDiagnostics[] = [];
    const manyIssuesCheck = defineStoreIntegrityOptionalCheck({
      name: "token_parity",
      label: "many issues during boot import",
      read: () => Promise.resolve({}),
      schema: z.unknown(),
      classify: (_value, issues) => {
        for (let i = 0; i < 5; i++) {
          issues.push({
            check: "token_parity",
            category: "token_total_out_of_range",
            object: `col_${i}`,
            objectType: "unknown",
          });
        }
      },
      runsDuringBootImport: true,
    });
    const waiter = tickWaiter(1);
    const probe = createStoreIntegrityProbe(scriptedReader({}), {
      emit: (diagnostics) => emitted.push(diagnostics),
      initialDelayMs: 1,
      intervalMs: 10_000,
      maxReportedIssues: 2,
      isBootImportInProgress: () => true,
      extraChecks: [manyIssuesCheck],
      onTickSettled: waiter.onTickSettled,
    });
    probe.start();
    await waiter.ready;
    probe.stop();
    expect(emitted.length).toBe(1);
    expect(emitted[0].healthy).toBe(false);
    expect(emitted[0].issueCount).toBe(5);
    expect(emitted[0].issues.length).toBe(2);
    expect(emitted[0].truncated).toBe(true);
  });
});

describe("tick(): its own catch ternary over a rejected runOnce()", () => {
  it("logs error.message when the reader's read rejects with an Error", async () => {
    const logs: string[] = [];
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () => Promise.reject(new Error("reader-boom")),
    };
    const waiter = tickWaiter(1);
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      initialDelayMs: 1,
      intervalMs: 10_000,
      log: (message) => logs.push(message),
      onTickSettled: waiter.onTickSettled,
    });
    probe.start();
    await waiter.ready;
    probe.stop();
    expect(logs).toContain("store-integrity check failed: reader-boom");
  });

  it("logs String(error) when the reader's read rejects with a non-Error value", async () => {
    const logs: string[] = [];
    const reader: StoreIntegrityReader = {
      runStoreIntegrityCheck: () => Promise.reject("reader-boom-string"),
    };
    const waiter = tickWaiter(1);
    const probe = createStoreIntegrityProbe(reader, {
      emit: noopEmit,
      initialDelayMs: 1,
      intervalMs: 10_000,
      log: (message) => logs.push(message),
      onTickSettled: waiter.onTickSettled,
    });
    probe.start();
    await waiter.ready;
    probe.stop();
    expect(logs).toContain("store-integrity check failed: reader-boom-string");
  });
});

describe("start()/stop() guard branches", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() called twice does not arm a second pair of timers", () => {
    vi.useFakeTimers();
    const probe = createStoreIntegrityProbe(scriptedReader({}), {
      emit: noopEmit,
      initialDelayMs: 5,
      intervalMs: 15,
    });
    probe.start();
    expect(vi.getTimerCount()).toBe(2);
    // The `if (initialTimer || interval) return;` guard: a second start()
    // must not arm another one-shot + interval pair.
    probe.start();
    expect(vi.getTimerCount()).toBe(2);
    probe.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() without a prior start() is a no-op (initialTimer and interval are both null)", () => {
    const probe = createStoreIntegrityProbe(scriptedReader({}), {
      emit: noopEmit,
    });
    expect(() => probe.stop()).not.toThrow();
  });
});

describe("maybeUnref: timer shape guard", () => {
  it("does not call .unref() when the global setTimeout/setInterval return a plain number (browser-style handle)", () => {
    // maybeUnref's `ReturnType<typeof setTimeout>` type is Node's Timeout
    // object, which always carries `.unref`, so the only way to reach its
    // `typeof timer !== "object"` arm through real behavior is a scheduler
    // whose global setTimeout/setInterval return a bare numeric id (the
    // browser-style contract some hosts still provide). Faking those two
    // globals is the process boundary this test is allowed to fake; each
    // stub records the calls `start()` made to it.
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const timeoutCalls: unknown[][] = [];
    const intervalCalls: unknown[][] = [];
    let unrefCalled = false;
    globalThis.setTimeout = ((...args: unknown[]) => {
      timeoutCalls.push(args);
      return 1001;
    }) as typeof globalThis.setTimeout;
    globalThis.setInterval = ((...args: unknown[]) => {
      intervalCalls.push(args);
      return 1002;
    }) as typeof globalThis.setInterval;
    // A number has no `.unref`; if maybeUnref's guard regressed to calling it
    // unconditionally, accessing `.unref` on `1001`/`1002` would throw here.
    const originalNumberUnref = (Number.prototype as { unref?: unknown }).unref;
    (Number.prototype as { unref?: unknown }).unref = () => {
      unrefCalled = true;
    };
    try {
      const probe = createStoreIntegrityProbe(scriptedReader({}), {
        emit: noopEmit,
        initialDelayMs: 1000,
        intervalMs: 1000,
      });
      expect(() => probe.start()).not.toThrow();
      probe.stop();
      expect(timeoutCalls.length).toBe(1);
      expect(intervalCalls.length).toBe(1);
      expect(unrefCalled).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
      if (originalNumberUnref === undefined) {
        Reflect.deleteProperty(Number.prototype, "unref");
      } else {
        (Number.prototype as { unref?: unknown }).unref = originalNumberUnref;
      }
    }
  });
});
