/**
 * Goal stage 2 (atomic row-level ack): the request-gated `acceptedSessionIds`
 * echo on the accepted ack. Split out of the (grandfathered, shrink-only) main
 * handler suite; shares its fixtures.
 *
 * The load-bearing property is that the echo reports what the server PERSISTED,
 * not what the client SENT. `upsertSessions` deliberately skips a slice it will
 * not write (a foreign chunk), and echoing that id anyway would let the desktop
 * clear an outbox row the server never stored — silent loss, and precisely what
 * this stage exists to remove.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDesktopAgentSessionsEvent } from "../desktop-agent-sessions-handler";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  upsertBatchMock,
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

const TWO_SESSION_PAYLOAD = {
  ...validPayload,
  sessionCount: 2,
  sessions: [
    validPayload.sessions[0],
    { ...validPayload.sessions[0], externalSessionId: "sess-2" },
  ],
};

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
});

describe("handleDesktopAgentSessionsEvent acceptedSessionIds echo", () => {
  it("goal stage 2: echoes acceptedSessionIds when — and only when — the batch requests them", async () => {
    // Request-gated on purpose: installed desktops parse the success response
    // with a `.strict()` validator, so the field may never appear unrequested.
    const upsertBatch = upsertBatchMock(["sess-1"]);

    await expect(
      handleDesktopAgentSessionsEvent(
        { ...validPayload, wantsAcceptedSessionIds: true },
        baseContext,
        {
          isFeatureEnabled: async () => true,
          isOrgPolicyEnabled: async () => true,
          upsertBatch,
        }
      )
    ).resolves.toEqual({ accepted: true, acceptedSessionIds: ["sess-1"] });

    // An explicit `false` behaves exactly like the legacy omitted flag: no echo.
    await expect(
      handleDesktopAgentSessionsEvent(
        { ...validPayload, wantsAcceptedSessionIds: false },
        baseContext,
        {
          isFeatureEnabled: async () => true,
          isOrgPolicyEnabled: async () => true,
          upsertBatch,
        }
      )
    ).resolves.toEqual({ accepted: true });
  });

  it("goal stage 2: a session the batch SENT but the server did not persist is absent from the echo", async () => {
    // `upsertSessions` returns `false` for a slice it deliberately skipped (a
    // foreign chunk — its revision does not match the server's pending
    // assembly) without throwing, so the batch is still `accepted`. The echo
    // must follow the PERSISTED set, so the desktop keeps `sess-2` queued on
    // its bounded `ack_omitted` budget instead of clearing a row that was
    // never stored.
    const upsertBatch = upsertBatchMock(["sess-1"]);

    await expect(
      handleDesktopAgentSessionsEvent(
        { ...TWO_SESSION_PAYLOAD, wantsAcceptedSessionIds: true },
        baseContext,
        {
          isFeatureEnabled: async () => true,
          isOrgPolicyEnabled: async () => true,
          upsertBatch,
        }
      )
    ).resolves.toEqual({ accepted: true, acceptedSessionIds: ["sess-1"] });

    // The skipped session really was submitted — this is a persist outcome, not
    // a client-side filter.
    expect(
      upsertBatch.mock.calls[0]?.[1]?.sessions.map(
        (session: { externalSessionId: string }) => session.externalSessionId
      )
    ).toEqual(["sess-1", "sess-2"]);
  });
});
