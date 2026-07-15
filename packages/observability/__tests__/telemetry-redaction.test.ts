import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import { SHORT_HASH_PATTERN } from "../redact-correlation";
import { buildTelemetryTraceContext } from "../telemetry/context";
import { emitConnectionStateEvent } from "../telemetry/emitter";
import { ConnectionState, emitProtocolMetric } from "../telemetry/metrics";
import { Origin } from "../telemetry/origin";
import { TelemetryCategory } from "../telemetry/schema";

const RAW_GATEWAY_SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

afterEach(() => {
  vi.restoreAllMocks();
});

// The telemetry metric + event pipelines both emit via log.info, so the raw
// gatewaySessionId session token must be hashed before it reaches the sink.

describe("emitProtocolMetric — gatewaySessionId redaction", () => {
  it("hashes gatewaySessionId and never logs the raw token (ack_latency)", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});

    emitProtocolMetric({
      metric: "ack_latency",
      origin: Origin.Api,
      value: 12,
      computeTargetId: "ct-1",
      gatewaySessionId: RAW_GATEWAY_SESSION_ID,
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    const logged = spy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(logged) as Record<string, unknown>;
    expect(parsed._telemetryMetric).toBe(true);
    expect(parsed.gatewaySessionId).toEqual(
      expect.stringMatching(SHORT_HASH_PATTERN)
    );
    expect(parsed.gatewaySessionId).not.toBe(RAW_GATEWAY_SESSION_ID);
    expect(logged).not.toContain(RAW_GATEWAY_SESSION_ID);
  });

  it("redacts the connection_state_count gatewaySessionId too", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});

    emitProtocolMetric({
      metric: "connection_state_count",
      state: ConnectionState.Online,
      count: 1,
      computeTargetId: "ct-1",
      gatewaySessionId: RAW_GATEWAY_SESSION_ID,
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    const logged = spy.mock.calls.at(-1)?.[0] as string;
    expect(logged).not.toContain(RAW_GATEWAY_SESSION_ID);
    expect(
      (JSON.parse(logged) as Record<string, unknown>).gatewaySessionId
    ).toEqual(expect.stringMatching(SHORT_HASH_PATTERN));
  });
});

describe("emitConnectionStateEvent — gatewaySessionId redaction", () => {
  it("hashes gatewaySessionId in the emitted telemetry trace", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});

    emitConnectionStateEvent(
      TelemetryCategory.ConnectionRegistered,
      buildTelemetryTraceContext({
        computeTargetId: "ct-1",
        gatewaySessionId: RAW_GATEWAY_SESSION_ID,
      })
    );

    const logged = spy.mock.calls.at(-1)?.[0] as string;
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged) as {
      trace?: { gatewaySessionId?: string };
    };
    expect(parsed.trace?.gatewaySessionId).toEqual(
      expect.stringMatching(SHORT_HASH_PATTERN)
    );
    expect(parsed.trace?.gatewaySessionId).not.toBe(RAW_GATEWAY_SESSION_ID);
    expect(logged).not.toContain(RAW_GATEWAY_SESSION_ID);
  });
});
