import { log } from "@repo/observability/log";
import { Origin } from "@repo/observability/telemetry/origin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGaugeReporter } from "../telemetry/gauges";
import { DocSyncGauge } from "../telemetry/metrics";
import { metricSamples } from "./support/metric-samples";

const INTERVAL_MS = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function memoryUsage(rss: number, heapUsed: number): NodeJS.MemoryUsage {
  return { rss, heapUsed, heapTotal: 0, external: 0, arrayBuffers: 0 };
}

function samples(
  documents: number,
  connections: number,
  rss: number,
  heapUsed: number
) {
  return [
    [DocSyncGauge.OpenDocuments, documents],
    [DocSyncGauge.Connections, connections],
    [DocSyncGauge.MemoryRssBytes, rss],
    [DocSyncGauge.MemoryHeapUsedBytes, heapUsed],
  ].map(([metric, value]) => ({
    metric,
    value,
    origin: Origin.DocSync,
    _telemetryMetric: true,
  }));
}

describe("startGaugeReporter", () => {
  it("reports the four gauges at once, then every interval, until stopped", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    let documents = 2;
    let connections = 3;
    let memory = memoryUsage(100, 40);

    const stop = startGaugeReporter(
      {
        openDocuments: () => documents,
        connections: () => connections,
        memory: () => memory,
      },
      INTERVAL_MS
    );
    expect(metricSamples(info)).toEqual(samples(2, 3, 100, 40));

    documents = 5;
    connections = 7;
    memory = memoryUsage(200, 80);
    vi.advanceTimersByTime(INTERVAL_MS);
    stop();
    vi.advanceTimersByTime(INTERVAL_MS * 5);

    expect(metricSamples(info)).toEqual([
      ...samples(2, 3, 100, 40),
      ...samples(5, 7, 200, 80),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads process memory by default", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(process, "memoryUsage").mockReturnValue(memoryUsage(300, 120));

    startGaugeReporter(
      { openDocuments: () => 0, connections: () => 0 },
      INTERVAL_MS
    )();

    expect(metricSamples(info)).toEqual(samples(0, 0, 300, 120));
  });
});
