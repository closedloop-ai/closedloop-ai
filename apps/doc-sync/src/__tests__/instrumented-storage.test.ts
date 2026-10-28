import { log } from "@repo/observability/log";
import { Origin } from "@repo/observability/telemetry/origin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStorage } from "../storage/document-storage";
import { instrumentedStorage } from "../storage/instrumented-storage";
import { DocSyncCount, DocSyncHistogram } from "../telemetry/metrics";
import { memoryStorage } from "./support/memory-storage";
import { metricSamples } from "./support/metric-samples";

const STATE = new Uint8Array([1, 2, 3]);

let info: ReturnType<typeof spyInfo>;

function spyInfo() {
  return vi.spyOn(log, "info").mockImplementation(() => undefined);
}

beforeEach(() => {
  info = spyInfo();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each call reads the next value. */
function clock(...readings: number[]): () => number {
  return () => readings.shift() ?? Number.NaN;
}

describe("instrumentedStorage", () => {
  it("samples a resolved store's duration from the clock", async () => {
    const { storage, rows } = memoryStorage();

    await instrumentedStorage(storage, clock(10, 35)).store("doc-a", STATE);

    expect(rows.get("doc-a")).toBe(STATE);
    expect(metricSamples(info)).toEqual([
      {
        metric: DocSyncHistogram.StoreDurationMs,
        value: 25,
        origin: Origin.DocSync,
        _telemetryMetric: true,
      },
    ]);
  });

  it("counts a failed store and rethrows the same error", async () => {
    const failure = new Error("store failed");
    const storage: DocumentStorage = {
      ...memoryStorage().storage,
      store: () => Promise.reject(failure),
    };

    await expect(
      instrumentedStorage(storage, clock(0, 1)).store("doc-a", STATE)
    ).rejects.toBe(failure);

    expect(metricSamples(info)).toEqual([
      {
        metric: DocSyncCount.StoreFailures,
        count: 1,
        origin: Origin.DocSync,
        _telemetryMetric: true,
      },
    ]);
  });

  it("forwards fetch and ping without sampling", async () => {
    const ping = vi.fn(() => Promise.resolve());
    const { storage } = memoryStorage([["doc-a", STATE]]);
    const instrumented = instrumentedStorage({ ...storage, ping });

    await expect(instrumented.fetch("doc-a")).resolves.toBe(STATE);
    await instrumented.ping();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(metricSamples(info)).toEqual([]);
  });
});
