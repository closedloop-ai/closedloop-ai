import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { log } from "../log";
import type { ProtocolMetric } from "../telemetry/metrics";
import { ConnectionState, emitProtocolMetric } from "../telemetry/metrics";

afterEach(() => {
  vi.restoreAllMocks();
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
