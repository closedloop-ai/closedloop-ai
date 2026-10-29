import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindComputeTargetById,
  mockGetCommandById,
  mockIngestCommandEvent,
  mockRegister,
  mockListNonTerminal,
  mockSetOnlineState,
  mockClearOperationBacklog,
  mockIsComputeTargetSigningEligible,
  mockScheduleLogFlush,
} = vi.hoisted(() => ({
  mockFindComputeTargetById: vi.fn(),
  mockGetCommandById: vi.fn(),
  mockIngestCommandEvent: vi.fn(),
  mockRegister: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockSetOnlineState: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
  mockIsComputeTargetSigningEligible: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    listNonTerminalDispatchCommands: mockListNonTerminal,
    ingestCommandEvent: mockIngestCommandEvent,
    getCommandById: mockGetCommandById,
    countCommandsForTarget: vi.fn(async () => 0),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: mockRegister,
    updateOwned: vi.fn(),
    setOnlineState: mockSetOnlineState,
    heartbeat: vi.fn(async () => undefined),
    findById: mockFindComputeTargetById,
  },
  isComputeTargetGatewayConflictResult: (result: {
    ok: boolean;
    error?: string;
  }) => !result.ok && result.error === "gateway_conflict",
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mockScheduleLogFlush,
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: mockClearOperationBacklog,
    subscribeOperations: vi.fn(() => () => {}),
    subscribeTargetConnection: vi.fn(() => () => {}),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isComputeTargetSigningEligible: mockIsComputeTargetSigningEligible,
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    capture: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn(() => ({})),
  ZERO_GATEWAY_SESSION_ID: "zero-gateway-session-id",
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitConnectionStateEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitProtocolMetric: vi.fn(),
  emitQueueMetric: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn(async () => undefined),
}));

vi.mock("@/lib/desktop-gateway-wire", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/desktop-gateway-wire")>();
  return {
    ...actual,
    isTerminalEventData: vi.fn(),
    toEnvelope: <T extends Record<string, unknown>>(payload: T) => payload,
    toWireCommandFromStore: vi.fn((cmd: unknown) => cmd),
  };
});

vi.mock("@/lib/type-guards", () => ({
  isRecord: (val: unknown) =>
    typeof val === "object" && val !== null && !Array.isArray(val),
}));

// Spread the real module rather than list its exports: only the timeout is
// under test here, and an exhaustive factory breaks every consumer of this
// module the day it gains an export.
vi.mock("@/lib/desktop-gateway-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-gateway-types")>()),
  HELLO_OPERATION_TIMEOUT_MS: 5000,
}));

import { dispatchSocketEvent } from "../service";

const AUTH = {
  organizationId: "org-relay-test",
  userId: "user-relay-test",
  clerkUserId: "clerk-relay-test",
};

/**
 * The exact message string every hello outcome logs under. Pinned as a constant
 * because 30 days of production Datadog history keys on it
 * (`"Relay hello processed" @outcome:nack`) — ISS-8043 changed the LEVEL and
 * added fields, and must not have changed this.
 */
const HELLO_LOG_MESSAGE = "Relay hello processed";

const HELLO_PAYLOAD = {
  machineName: "test-machine",
  platform: "linux",
  gatewayId: "gateway-relay-test",
  supportedOperations: [] as string[],
};

type HelloTimeoutCase = {
  name: string;
  arrange: () => Promise<void> | void;
  payloadOverrides?: { computeTargetId?: string };
  expectedDisconnect: true | undefined;
  expectedNackReason?: (typeof DesktopHelloNackReason)[keyof typeof DesktopHelloNackReason];
  expectAck?: boolean;
  /**
   * ISS-8043. `reason` names WHICH STAGE failed; `runStage` maps a 5s deadline
   * and a thrown error onto the SAME reason, so timeout-vs-failure is the axis
   * `reason` cannot express. Each nack case pins the kind it actually produces.
   */
  expectedErrorKind?: "timeout" | "failure";
};

const helloTimeoutCases: HelloTimeoutCase[] = [
  {
    name: "listNonTerminalDispatchCommands hang → nack PendingCommandsLookupFailed + disconnect",
    arrange: () => {
      mockListNonTerminal.mockReturnValue(new Promise<never>(() => {}));
    },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.PendingCommandsLookupFailed,
    expectedErrorKind: "timeout",
  },
  {
    name: "setOnlineState hang → nack OnlineStateUpdateFailed + disconnect",
    arrange: async () => {
      const { computeTargetsService } = await import(
        "@/app/compute-targets/service"
      );
      vi.mocked(computeTargetsService.updateOwned).mockResolvedValue({
        ok: true,
        value: { id: "target-relay-existing" },
      } as Awaited<ReturnType<typeof computeTargetsService.updateOwned>>);
      mockListNonTerminal.mockResolvedValue([]);
      mockSetOnlineState.mockReturnValue(new Promise<never>(() => {}));
    },
    payloadOverrides: { computeTargetId: "target-relay-existing" },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.OnlineStateUpdateFailed,
    expectedErrorKind: "timeout",
  },
  {
    name: "feature-flag SDK hang → soft-fail to hello.ack (no nack, no disconnect)",
    arrange: () => {
      mockListNonTerminal.mockResolvedValue([]);
      mockIsComputeTargetSigningEligible.mockReturnValue(
        new Promise<never>(() => {})
      );
    },
    expectedDisconnect: undefined,
    expectAck: true,
  },
  {
    name: "updateOwned rejects with non-timeout error → nack ComputeTargetUpdateFailed + disconnect",
    arrange: async () => {
      const { computeTargetsService } = await import(
        "@/app/compute-targets/service"
      );
      vi.mocked(computeTargetsService.updateOwned).mockRejectedValue(
        new Error("simulated prisma constraint violation")
      );
    },
    payloadOverrides: { computeTargetId: "target-relay-existing" },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.ComputeTargetUpdateFailed,
    expectedErrorKind: "failure",
  },
  {
    name: "register rejects with non-timeout error → nack ComputeTargetRegisterFailed + disconnect",
    arrange: () => {
      mockRegister.mockRejectedValue(new Error("simulated network error"));
    },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
    expectedErrorKind: "failure",
  },
  // ISS-8043. The two cases above reject IMMEDIATELY, so both report
  // `errorKind: "failure"` whether or not the label survived the trip out of
  // `resolveRelayHelloTarget`. These two hang instead: the ONLY way to report
  // "timeout" here is for `runStage`'s label to be carried on the StageResult
  // and read back second-hand by `logRelayHello`. Drop `label` from
  // `StageResult`, or pass the wrong one, and these two go red — which is the
  // whole justification for that field.
  {
    name: "updateOwned hang → nack ComputeTargetUpdateFailed, errorKind timeout via second-hand label",
    arrange: async () => {
      const { computeTargetsService } = await import(
        "@/app/compute-targets/service"
      );
      vi.mocked(computeTargetsService.updateOwned).mockReturnValue(
        new Promise<never>(() => {})
      );
    },
    payloadOverrides: { computeTargetId: "target-relay-existing" },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.ComputeTargetUpdateFailed,
    expectedErrorKind: "timeout",
  },
  {
    name: "register hang → nack ComputeTargetRegisterFailed, errorKind timeout via second-hand label",
    arrange: () => {
      mockRegister.mockReturnValue(new Promise<never>(() => {}));
    },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
    expectedErrorKind: "timeout",
  },
];

describe("relay dispatchSocketEvent desktop.hello — timeout handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockRegister.mockResolvedValue({
      ok: true,
      value: { id: "target-relay-test" },
    });
    mockClearOperationBacklog.mockReturnValue(undefined);
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "missing_gateway",
    });
    mockFindComputeTargetById.mockResolvedValue(null);
    mockGetCommandById.mockResolvedValue(null);
    mockIngestCommandEvent.mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(helloTimeoutCases)("$name", async (testCase) => {
    await testCase.arrange();

    const dispatchPromise = dispatchSocketEvent({
      event: "desktop.hello",
      payload: { ...HELLO_PAYLOAD, ...testCase.payloadOverrides },
      auth: AUTH,
      targetId: undefined,
      correlation: {},
      requestArrivedAt: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(6000);

    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const { response } = result;
    expect(response.disconnect).toBe(testCase.expectedDisconnect);

    const nackEmit = response.emit.find(
      (e) => e.event === "desktop.hello.nack"
    );
    if (testCase.expectedNackReason) {
      expect(nackEmit).toBeDefined();
      expect(nackEmit?.payload).toMatchObject({
        reason: testCase.expectedNackReason,
      });
    } else {
      expect(nackEmit).toBeUndefined();
    }

    if (testCase.expectAck) {
      const ackEmit = response.emit.find(
        (e) => e.event === "desktop.hello.ack"
      );
      expect(ackEmit).toBeDefined();
    }

    // ISS-8043. The nack was previously logged by a reason-less `log.info`,
    // which is why the wire reason never reached a production log line and 142
    // of these went unnoticed for 30 days. The log IS the contract here, which
    // is the narrow case AGENTS.md allows asserting on it.
    const { log } = await import("@repo/observability/log");
    const errorCalls = vi
      .mocked(log.error)
      .mock.calls.filter(([message]) => message === HELLO_LOG_MESSAGE);
    const infoCalls = vi
      .mocked(log.info)
      .mock.calls.filter(([message]) => message === HELLO_LOG_MESSAGE);

    if (testCase.expectedNackReason) {
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]?.[1]).toMatchObject({
        outcome: "nack",
        reason: testCase.expectedNackReason,
        errorKind: testCase.expectedErrorKind,
      });
      // The cause must travel with the line — a reason alone cannot tell an
      // on-call WHICH query or WHAT failed. Asserted as an actual Error, not
      // merely present: `toHaveProperty("error")` also passes for
      // `{ error: undefined }`, which would ship the exact blind spot
      // ISS-8043 exists to remove.
      expect(errorCalls[0]?.[1]).toMatchObject({ error: expect.any(Error) });
      // Fields that predate ISS-8043 must survive: 30 days of saved Datadog
      // queries key on this message string and these attributes.
      expect(errorCalls[0]?.[1]).toMatchObject({
        organizationId: AUTH.organizationId,
        userId: AUTH.userId,
      });
      expect(errorCalls[0]?.[1]).toHaveProperty("timings");
      expect(errorCalls[0]?.[1]).toHaveProperty("totalMs");
      // A nack must not ALSO surface as a routine info line.
      expect(infoCalls).toHaveLength(0);
      // A nack answers HTTP 200, so `route.ts` — which schedules its flush
      // only from the catch block — never flushes for one. Unflushed, this
      // line sits in the agentless buffer and dies with the frozen serverless
      // function, leaving ISS-8290's monitor exactly as blind as the
      // `log.info` this replaced. Logging it at `error` is only half the fix;
      // delivering it is the other half.
      expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
    } else {
      // The ack path is untouched: still info, never error.
      expect(infoCalls).toHaveLength(1);
      expect(infoCalls[0]?.[1]).toMatchObject({ outcome: "ack" });
      expect(errorCalls).toHaveLength(0);
      // And it is deliberately NOT flushed. The flush is bound to the nack
      // line, not to the route's return: this endpoint carries ALL relay
      // socket traffic, so a per-request flush would put a Datadog intake
      // round-trip on the hottest internal path for no ISS-8043 benefit.
      expect(mockScheduleLogFlush).not.toHaveBeenCalled();
    }
  });
});

describe("relay dispatchSocketEvent desktop.hello — command-signing capability behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockRegister.mockResolvedValue({
      ok: true,
      value: { id: "target-relay-test" },
    });
    mockClearOperationBacklog.mockReturnValue(undefined);
    mockListNonTerminal.mockResolvedValue([]);
    mockSetOnlineState.mockResolvedValue(true);
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "missing_gateway",
    });
    mockFindComputeTargetById.mockResolvedValue(null);
    mockGetCommandById.mockResolvedValue(null);
    mockIngestCommandEvent.mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function dispatchHelloResponse(payload: Record<string, unknown> = {}) {
    const result = await dispatchSocketEvent({
      event: "desktop.hello",
      payload: { ...HELLO_PAYLOAD, ...payload },
      auth: AUTH,
      targetId: undefined,
      correlation: {},
      requestArrivedAt: Date.now(),
    });
    if (!result.ok) {
      throw new Error("relay hello dispatch failed");
    }
    return result.response;
  }

  async function dispatchHello(payload: Record<string, unknown> = {}) {
    const response = await dispatchHelloResponse(payload);
    const ackEmit = response.emit.find(
      (emit) => emit.event === "desktop.hello.ack"
    );
    if (!ackEmit) {
      throw new Error("desktop hello ack was not emitted");
    }
    return ackEmit.payload as { serverCapabilities?: Record<string, unknown> };
  }

  it("emits computeTargetSigning for eligible relay hello", async () => {
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "eligible",
    });

    const ack = await dispatchHello();

    expect(mockIsComputeTargetSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-relay-test",
      userId: "user-relay-test",
      clerkUserId: "clerk-relay-test",
      gatewayId: "gateway-relay-test",
    });
    expect(ack.serverCapabilities?.computeTargetSigning).toBe(true);
  });

  it.each([
    {
      name: "ineligible relay target",
      signingResult: { status: "ineligible", reason: "no_active_managed_key" },
      payload: {},
    },
    {
      name: "unknown eligibility",
      signingResult: {
        status: "unknown",
        reason: "command_signing_eligibility_unknown",
      },
      payload: {},
    },
    {
      name: "missing gateway",
      signingResult: { status: "ineligible", reason: "missing_gateway" },
      payload: { gatewayId: undefined },
    },
  ])(
    "omits computeTargetSigning for $name",
    async ({ signingResult, payload }) => {
      mockIsComputeTargetSigningEligible.mockResolvedValue(signingResult);

      const ack = await dispatchHello(payload);

      expect(ack.serverCapabilities?.computeTargetSigning).toBeUndefined();
    }
  );

  it("keeps agentSessionSync independent when signing is omitted", async () => {
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "no_active_managed_key",
    });

    const ack = await dispatchHello();

    expect(ack.serverCapabilities).toEqual({
      agentSessionSync: true,
      // FEA-4138: the sync lane advertises gzip decompression whenever sync
      // itself is supported (a server-version capability, not a per-org gate).
      agentSessionSyncCompression: true,
      // ISS-4541/ISS-4578: the sync lane also advertises additive multi-part
      // activity-tiling merge alongside sync (same server-version gate).
      agentSessionSyncActivityChunking: true,
      // ISS-9859: this build merges a part marked `prRefsPaginated` into the
      // stored PR links, so a desktop may paginate an oversized `prRefs`.
      agentSessionSyncPrRefChunking: true,
      agentSessionSyncMonitoredActivity: true,
      // ISS-5850: this build's span schema declares startMs/endMs, so a span
      // carrying the collector's measured extent is persisted rather than
      // stripped — advertised alongside sync on the same server-version gate.
      // The desktop reads its ABSENCE as "an older server", and withholds the
      // cursor stamp that would claim the extent was delivered, so this shape
      // staying exhaustive is what stops the capability drifting unreviewed.
      agentSessionSyncSpanExtent: true,
      // ISS-7896: same contract one rung up — this build stores
      // `metadata.humanTurnTimestamps` whole rather than capping it at 100.
      agentSessionSyncHumanTurnTimestamps: true,
      agentSessionSyncAgentTurnTimestamps: true,
      agentSessionSyncTokenEventOwner: true,
    });
  });

  it("soft-fails a signing rejection to an ACK with baseline capabilities", async () => {
    mockIsComputeTargetSigningEligible.mockRejectedValue(
      new Error("signing provider unavailable")
    );

    const response = await dispatchHelloResponse();
    const ack = response.emit.find(
      (emit) => emit.event === "desktop.hello.ack"
    );

    expect(response.disconnect).toBeUndefined();
    expect(
      response.emit.some((emit) => emit.event === "desktop.hello.nack")
    ).toBe(false);
    expect(ack?.payload).toMatchObject({
      serverCapabilities: {
        agentSessionSync: true,
        agentSessionSyncCompression: true,
        agentSessionSyncActivityChunking: true,
        agentSessionSyncPrRefChunking: true,
        agentSessionSyncMonitoredActivity: true,
        agentSessionSyncSpanExtent: true,
        agentSessionSyncHumanTurnTimestamps: true,
        agentSessionSyncAgentTurnTimestamps: true,
        agentSessionSyncTokenEventOwner: true,
      },
    });
    expect(ack?.payload).not.toHaveProperty(
      "serverCapabilities.computeTargetSigning"
    );
  });

  it("soft-fails a signing timeout to an ACK with baseline capabilities", async () => {
    mockIsComputeTargetSigningEligible.mockReturnValue(
      new Promise<never>(() => {})
    );

    const responsePromise = dispatchHelloResponse();
    await vi.advanceTimersByTimeAsync(6000);
    const response = await responsePromise;
    const ack = response.emit.find(
      (emit) => emit.event === "desktop.hello.ack"
    );

    expect(response.disconnect).toBeUndefined();
    expect(
      response.emit.some((emit) => emit.event === "desktop.hello.nack")
    ).toBe(false);
    expect(ack?.payload).toMatchObject({
      serverCapabilities: {
        agentSessionSync: true,
        agentSessionSyncCompression: true,
        agentSessionSyncActivityChunking: true,
        agentSessionSyncPrRefChunking: true,
        agentSessionSyncMonitoredActivity: true,
        agentSessionSyncSpanExtent: true,
        agentSessionSyncHumanTurnTimestamps: true,
        agentSessionSyncAgentTurnTimestamps: true,
        agentSessionSyncTokenEventOwner: true,
      },
    });
    expect(ack?.payload).not.toHaveProperty(
      "serverCapabilities.computeTargetSigning"
    );
  });

  it("emits server capabilities on relay sequence-gap hello acks", async () => {
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "eligible",
    });
    mockFindComputeTargetById.mockResolvedValue({
      id: "target-relay-existing",
      gatewayId: "gateway-relay-test",
    });
    mockIngestCommandEvent.mockResolvedValueOnce({
      accepted: false,
      reason: "sequence_gap",
    });
    mockGetCommandById.mockResolvedValueOnce({
      commandId: "cmd-relay-gap",
      computeTargetId: "target-relay-existing",
      lastSequenceAcked: 11,
    });

    const result = await dispatchSocketEvent({
      event: "desktop.command.event",
      payload: {
        commandId: "cmd-relay-gap",
        data: { partial: true },
        eventType: "chunk",
        sequence: 13,
      },
      auth: AUTH,
      targetId: "target-relay-existing",
      correlation: { gatewaySessionId: "raw-gateway-session-id" },
      requestArrivedAt: Date.now(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const helloAck = result.response.emit.find(
      (emit) => emit.event === "desktop.hello.ack"
    );
    expect(helloAck?.payload).toEqual(
      expect.objectContaining({
        computeTargetId: "target-relay-existing",
        resumeFromSequence: { "cmd-relay-gap": 11 },
        serverCapabilities: {
          agentSessionSync: true,
          // FEA-4138: sync lane advertises gzip decompression alongside sync.
          agentSessionSyncCompression: true,
          // ISS-4541/ISS-4578: sync lane advertises multi-part activity-tiling
          // merge alongside sync.
          agentSessionSyncActivityChunking: true,
          // ISS-9859: this build merges a part marked `prRefsPaginated` into the
          // stored PR links, so a desktop may paginate an oversized `prRefs`.
          agentSessionSyncPrRefChunking: true,
          agentSessionSyncMonitoredActivity: true,
          // ISS-5850: sync lane advertises span-extent persistence alongside
          // sync — the relay's sequence-gap re-ack must carry the same set the
          // first ack did, or a resuming desktop would see the capability
          // vanish mid-connection and stop stamping the extent cursor.
          agentSessionSyncSpanExtent: true,
          agentSessionSyncHumanTurnTimestamps: true,
          agentSessionSyncAgentTurnTimestamps: true,
          agentSessionSyncTokenEventOwner: true,
          computeTargetSigning: true,
        },
      })
    );
    expect(mockFindComputeTargetById).toHaveBeenCalledWith(
      "target-relay-existing"
    );
  });
});

describe("relay dispatchSocketEvent desktop.hello — refusal rulings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({
      ok: true,
      value: { id: "target-relay-test" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function dispatchHello(payload: unknown) {
    const result = await dispatchSocketEvent({
      event: "desktop.hello",
      payload,
      auth: AUTH,
      targetId: undefined,
      correlation: {},
      requestArrivedAt: Date.now(),
    });
    if (!result.ok) {
      throw new Error("relay hello dispatch failed");
    }
    return result.response;
  }

  it("disconnects malformed hello input without inventing a nack reason", async () => {
    const response = await dispatchHello({ machineName: "missing-platform" });

    expect(response).toEqual({ emit: [], disconnect: true });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("disconnects an update-owned gateway conflict without registering or nacking", async () => {
    const { computeTargetsService } = await import(
      "@/app/compute-targets/service"
    );
    vi.mocked(computeTargetsService.updateOwned).mockResolvedValue({
      ok: false,
      error: "gateway_conflict",
    } as Awaited<ReturnType<typeof computeTargetsService.updateOwned>>);

    const response = await dispatchHello({
      ...HELLO_PAYLOAD,
      computeTargetId: "target-relay-existing",
    });

    expect(response).toEqual({ emit: [], disconnect: true });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("disconnects a register gateway conflict without a nack", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      error: "gateway_conflict",
    });

    const response = await dispatchHello(HELLO_PAYLOAD);

    expect(response).toEqual({ emit: [], disconnect: true });
    expect(response.emit).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "desktop.hello.nack" }),
      ])
    );
  });

  it("keeps InternalError in the advertised nack reason contract", () => {
    expect(DesktopHelloNackReason.InternalError).toBe("internal_error");
  });
});
