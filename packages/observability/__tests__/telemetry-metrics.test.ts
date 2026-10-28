import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { log } from "../log";
import type { ProtocolMetric } from "../telemetry/metrics";
import {
  ConnectionState,
  emitProtocolMetric,
  emitQueueMetric,
} from "../telemetry/metrics";
import { Origin } from "../telemetry/origin";

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

// ---------------------------------------------------------------------------
// Datadog log-to-metric attribute-path contract (ISS-6530)
// ---------------------------------------------------------------------------

// The attribute paths the example-infrastructure pipeline rules read, written as
// literals ON PURPOSE. Deriving them from QueueMetric/ProtocolMetric would make
// this test agree with whatever the emitter currently does, which is the exact
// failure it exists to catch — the rules for api.executor_saturation and
// relay.replay_window_usage each named a field no emitter wrote and published
// nothing for months. The duplication IS the test; a change here requires a
// paired PR in that repo.
const DATADOG_COMPUTE_PATHS = ["metric", "origin", "value"] as const;

describe("emitted payload carries the attributes the Datadog rules read", () => {
  // Each case calls its real typed emitter rather than a shared one behind a
  // cast, so the metric name is checked against QueueMetric too: dropping it
  // from the union stops this compiling.
  it.each([
    {
      metric: "executor_saturation",
      emit: () =>
        emitQueueMetric({
          metric: "executor_saturation",
          origin: Origin.Api,
          value: 0.5,
        }),
    },
  ])(
    "$metric ships metric/origin/value as top-level JSON attributes",
    ({ emit, metric }) => {
      const spy = vi.spyOn(log, "info");

      emit();

      // A single JSON-string argument is the contract, not an incidental
      // detail: Datadog parses a lone JSON message into attributes, which is
      // what makes `@value` addressable. Switching to log.info(message, meta)
      // would move every path and silently dark every rule in the family.
      expect(spy).toHaveBeenCalledTimes(1);
      const [message, ...rest] = spy.mock.calls[0];
      expect(rest).toEqual([]);
      expect(typeof message).toBe("string");

      const parsed = JSON.parse(message as string);
      expect(Object.keys(parsed)).toEqual(
        expect.arrayContaining([...DATADOG_COMPUTE_PATHS])
      );
      expect(parsed.metric).toBe(metric);
      // Deliberately NOT Origin.Api. The payload is built FROM that const, so
      // asserting it back compares the test to itself. "api" is the value the
      // `@origin:api` predicate in all three pipeline rules names, so pinning the
      // literal here is what makes a change to Origin.Api fail locally instead of
      // darkening those rules silently.
      expect(parsed.origin).toBe("api");
      expect(parsed.value).toBe(0.5);
    }
  );
});
