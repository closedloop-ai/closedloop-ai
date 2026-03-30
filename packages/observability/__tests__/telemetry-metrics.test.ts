import { describe, expect, it } from "vitest";
import { computeMetricSnapshot } from "../telemetry/metrics";

// ---------------------------------------------------------------------------
// computeMetricSnapshot
// ---------------------------------------------------------------------------

describe("computeMetricSnapshot", () => {
  it("returns an empty object for an empty log line array", () => {
    expect(computeMetricSnapshot([])).toEqual({});
  });

  it("filters out lines where _telemetryMetric is not true", () => {
    const lines = [
      { metric: "queued_command_count", count: 5 },
      { metric: "queued_command_count", count: 3, _telemetryMetric: false },
      { metric: "queued_command_count", count: 3, _telemetryMetric: "yes" },
    ];
    expect(computeMetricSnapshot(lines)).toEqual({});
  });

  it("aggregates count fields by metric name", () => {
    const lines = [
      { metric: "queued_command_count", count: 5, _telemetryMetric: true },
      { metric: "queued_command_count", count: 3, _telemetryMetric: true },
    ];
    const snapshot = computeMetricSnapshot(lines);
    expect(snapshot.queued_command_count).toBe(8);
  });

  it("aggregates value fields by metric name", () => {
    const lines = [
      { metric: "ack_latency", value: 100, _telemetryMetric: true },
      { metric: "ack_latency", value: 150, _telemetryMetric: true },
    ];
    const snapshot = computeMetricSnapshot(lines);
    expect(snapshot.ack_latency).toBe(250);
  });

  it("prefers count over value when both are present", () => {
    const lines = [
      {
        metric: "retry_attempts",
        count: 2,
        value: 99,
        _telemetryMetric: true,
      },
    ];
    const snapshot = computeMetricSnapshot(lines);
    expect(snapshot.retry_attempts).toBe(2);
  });

  it("defaults numeric to 1 when neither count nor value is present", () => {
    const lines = [{ metric: "event_ordering_gaps", _telemetryMetric: true }];
    const snapshot = computeMetricSnapshot(lines);
    expect(snapshot.event_ordering_gaps).toBe(1);
  });

  it("aggregates multiple distinct metric names independently", () => {
    const lines = [
      { metric: "queued_command_count", count: 4, _telemetryMetric: true },
      { metric: "ack_latency", value: 200, _telemetryMetric: true },
      { metric: "queued_command_count", count: 1, _telemetryMetric: true },
    ];
    const snapshot = computeMetricSnapshot(lines);
    expect(snapshot.queued_command_count).toBe(5);
    expect(snapshot.ack_latency).toBe(200);
  });

  it("skips lines with a non-string metric field", () => {
    const lines = [
      { metric: 42, count: 5, _telemetryMetric: true },
      { count: 5, _telemetryMetric: true },
    ];
    expect(computeMetricSnapshot(lines)).toEqual({});
  });
});
