import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegister,
  mockListNonTerminal,
  mockSetOnlineState,
  mockClearOperationBacklog,
  mockIsComputeTargetSigningEligible,
  mockIsAgentSessionSyncSupportedForUser,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockSetOnlineState: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
  mockIsComputeTargetSigningEligible: vi.fn(),
  mockIsAgentSessionSyncSupportedForUser: vi.fn(),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    listNonTerminalDispatchCommands: mockListNonTerminal,
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
    countCommandsForTarget: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: mockRegister,
    updateOwned: vi.fn(),
    setOnlineState: mockSetOnlineState,
    heartbeat: vi.fn().mockResolvedValue(undefined),
  },
  isComputeTargetGatewayConflictResult: (result: {
    ok: boolean;
    error?: string;
  }) => !result.ok && result.error === "gateway_conflict",
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: mockClearOperationBacklog,
    subscribeOperations: vi.fn().mockReturnValue(() => {}),
    subscribeTargetConnection: vi.fn().mockReturnValue(() => {}),
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

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: mockIsAgentSessionSyncSupportedForUser,
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    capture: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn().mockReturnValue({}),
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

vi.mock("@/lib/desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: vi
    .fn()
    .mockResolvedValue({ accepted: true }),
}));

vi.mock("@/lib/desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: vi.fn().mockResolvedValue({ accepted: true }),
}));

vi.mock("@/lib/desktop-analytics-schema", () => ({
  DESKTOP_ANALYTICS_SOCKET_EVENT: "desktop.analytics",
}));

vi.mock("@/lib/desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn().mockReturnValue({ ok: true, emits: [] }),
}));

vi.mock("@/lib/desktop-gateway-wire", () => ({
  isDesktopCommandEventType: vi.fn(),
  isTerminalEventData: vi.fn(),
  toEnvelope: <T extends Record<string, unknown>>(payload: T) => payload,
  toWireCommandFromStore: vi.fn((cmd: unknown) => cmd),
}));

vi.mock("@/lib/type-guards", () => ({
  isRecord: (val: unknown) =>
    typeof val === "object" && val !== null && !Array.isArray(val),
}));

vi.mock("@/lib/desktop-gateway-types", () => ({
  PROTOCOL_VERSION: "1",
  HELLO_OPERATION_TIMEOUT_MS: 5000,
}));

import { dispatchSocketEvent } from "../service";

const AUTH = {
  organizationId: "org-relay-test",
  userId: "user-relay-test",
  clerkUserId: "clerk-relay-test",
};

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
};

const helloTimeoutCases: HelloTimeoutCase[] = [
  {
    name: "listNonTerminalDispatchCommands hang → nack PendingCommandsLookupFailed + disconnect",
    arrange: () => {
      mockListNonTerminal.mockReturnValue(new Promise<never>(() => {}));
    },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.PendingCommandsLookupFailed,
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
  },
  {
    name: "feature-flag SDK hang → soft-fail to hello.ack (no nack, no disconnect)",
    arrange: () => {
      mockListNonTerminal.mockResolvedValue([]);
      mockIsComputeTargetSigningEligible.mockReturnValue(
        new Promise<never>(() => {})
      );
      mockIsAgentSessionSyncSupportedForUser.mockReturnValue(
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
  },
  {
    name: "register rejects with non-timeout error → nack ComputeTargetRegisterFailed + disconnect",
    arrange: () => {
      mockRegister.mockRejectedValue(new Error("simulated network error"));
    },
    expectedDisconnect: true,
    expectedNackReason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
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
    mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(false);
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
      pluginVersion: undefined,
      relaySocketId: undefined,
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
    mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function dispatchHello(payload: Record<string, unknown> = {}) {
    const result = await dispatchSocketEvent({
      event: "desktop.hello",
      payload: { ...HELLO_PAYLOAD, ...payload },
      auth: AUTH,
      targetId: undefined,
      correlation: {},
      pluginVersion: undefined,
      relaySocketId: undefined,
      requestArrivedAt: Date.now(),
    });
    if (!result.ok) {
      throw new Error("relay hello dispatch failed");
    }
    const ackEmit = result.response.emit.find(
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
    expect(ack.serverCapabilities).toEqual({ computeTargetSigning: true });
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
  ])("omits computeTargetSigning for $name", async ({
    signingResult,
    payload,
  }) => {
    mockIsComputeTargetSigningEligible.mockResolvedValue(signingResult);

    const ack = await dispatchHello(payload);

    expect(ack.serverCapabilities).toBeUndefined();
  });

  it("keeps agentSessionSync independent when signing is omitted", async () => {
    mockIsComputeTargetSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "no_active_managed_key",
    });
    mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(true);

    const ack = await dispatchHello();

    expect(ack.serverCapabilities).toEqual({ agentSessionSync: true });
  });
});
