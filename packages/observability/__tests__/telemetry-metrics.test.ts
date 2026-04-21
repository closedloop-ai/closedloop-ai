import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { log } from "../log";
import type { ProtocolMetric } from "../telemetry/metrics";
import {
  ConnectionState,
  computeMetricSnapshot,
  emitProtocolMetric,
} from "../telemetry/metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

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

// ---------------------------------------------------------------------------
// emitProtocolMetric — connection_state_count
// ---------------------------------------------------------------------------

describe("emitProtocolMetric — connection_state_count", () => {
  it("emits state as top-level field with _telemetryMetric marker", () => {
    const spy = vi.spyOn(log, "info");
    emitProtocolMetric({
      metric: "connection_state_count",
      state: ConnectionState.Online,
      count: 1,
      computeTargetId: "ct_test",
      gatewaySessionId: "sess_test",
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    const capturedArg = spy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(capturedArg);
    expect(parsed.state).toBe(ConnectionState.Online);
    expect(parsed._telemetryMetric).toBe(true);
    expect(parsed.metric).toBe("connection_state_count");
    expect(parsed.computeTargetId).toBe("ct_test");
  });

  it("aggregates connection_state_count entries by count ignoring state", () => {
    const lines = [
      {
        metric: "connection_state_count",
        state: ConnectionState.Online,
        count: 1,
        _telemetryMetric: true,
      },
      {
        metric: "connection_state_count",
        state: ConnectionState.Online,
        count: 1,
        _telemetryMetric: true,
      },
      {
        metric: "connection_state_count",
        state: ConnectionState.Degraded,
        count: 1,
        _telemetryMetric: true,
      },
    ];
    expect(computeMetricSnapshot(lines).connection_state_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ProtocolMetric type-level cardinality
// ---------------------------------------------------------------------------

describe("ProtocolMetric type-level cardinality", () => {
  it("compiles", () => {
    // Positive: valid connection_state_count metric is assignable to ProtocolMetric
    expectTypeOf({
      metric: "connection_state_count" as const,
      state: ConnectionState.Online,
      count: 1 as const,
      computeTargetId: "x",
      timestamp: "t",
    }).toMatchTypeOf<ProtocolMetric>();

    // Negative: state must be a ConnectionState value, not an arbitrary string.
    const _a: ProtocolMetric = {
      metric: "connection_state_count",
      // @ts-expect-error — "invalid" is not assignable to ConnectionState
      state: "invalid",
      count: 1,
    };

    // Negative: connection_state_count requires the `state` field.
    // @ts-expect-error — state is required on the connection_state_count arm
    const _b: ProtocolMetric = {
      metric: "connection_state_count",
      count: 1,
    };

    // Negative: connection_churn_rate (ProtocolBaseMetric) does not accept `state`.
    const _c: ProtocolMetric = {
      metric: "connection_churn_rate",
      // @ts-expect-error — state is not a valid field on non-connection_state_count arms
      state: ConnectionState.Online,
    };
  });
});
