/**
 * How the desktop-sync handler TAXONOMIZES an error thrown out of the batch
 * upsert — the one decision that picks the HTTP status the desktop dispatches
 * on, and therefore which recovery path a rejected batch takes.
 *
 * Split out of `desktop-agent-sessions-handler.test.ts` (ISS-7768): that suite is
 * over the line ceiling and shrink-only, and this is a cohesive unit of its own —
 * every case here drives the same `catch` and asserts the same two-way choice
 * between the client-shaped 400 class and the transient-server 500 class.
 */
import { DesktopAgentSessionsAckReason } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionTimestampField,
  SessionTimestampOutOfRangeError,
  TokenEventTransportIdentityCollisionError,
} from "../desktop-agent-sessions-errors";
import { handleDesktopAgentSessionsEvent } from "../desktop-agent-sessions-handler";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  validationFailedAck,
  validDesktopAgentSessionsPayload as validPayload,
} from "./desktop-agent-sessions-handler-fixtures";

const { mockEmitTelemetryMetric, mockLog } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
  mockLog.debug.mockReset();
  mockLog.info.mockReset();
  mockLog.warn.mockReset();
  mockLog.error.mockReset();
});

describe("handleDesktopAgentSessionsEvent — rejection taxonomy", () => {
  it("returns ingestion_failed for ingestion failures", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        upsertBatch: () => Promise.reject(new Error("db down")),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
    // The failure telemetry reason must stay in lockstep with the ack reason so
    // dashboards that join the two on `reason` don't drift (FEA-2847).
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "agent_sessions.sync.failed",
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      })
    );
  });

  it("returns validation_failed for a deterministic token transport collision", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        upsertBatch: () =>
          Promise.reject(new TokenEventTransportIdentityCollisionError()),
      })
    ).resolves.toEqual(validationFailedAck());

    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "agent_sessions.sync.failed",
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      })
    );
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("ISS-8735: an out-of-range session timestamp stays ingestion_failed", async () => {
    // The ticket rules retry semantics unchanged: this replaces a Postgres
    // throw that already answered 500, so the class deliberately does not
    // inherit the client-shaped 400.
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        upsertBatch: () =>
          Promise.reject(
            new SessionTimestampOutOfRangeError(
              SessionTimestampField.StartedAt,
              "-100000-01-01T00:00:00.000Z"
            )
          ),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  });

  it("ISS-7768: an unrecognized failure still degrades to ingestion_failed", async () => {
    // The positive sibling to the test above, and the reason re-taxonomizing one
    // error is safe: the catch-all is unchanged. A rejection the server cannot
    // name is still a SERVER-shaped failure, so it keeps the bounded transient
    // reason rather than being swept into the new client-shaped class. Without
    // this, widening the `instanceof` to something too broad would go unnoticed.
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        upsertBatch: () => Promise.reject(new Error("some unmapped failure")),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  });
});
