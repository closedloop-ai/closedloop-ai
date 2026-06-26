import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegister,
  mockListNonTerminal,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
  mockClearOperationBacklog,
  mockHeartbeat,
  mockIsDirectDesktopAuthSigningEligible,
  mockIsAgentSessionSyncSupportedForUser,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockIsDirectDesktopAuthSigningEligible: vi.fn(),
  mockIsAgentSessionSyncSupportedForUser: vi.fn(),
}));

vi.mock("../desktop-command-store", () => ({
  desktopCommandStore: {
    listNonTerminalDispatchCommands: mockListNonTerminal,
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
  },
}));

const { mockSetOnlineState } = vi.hoisted(() => ({
  mockSetOnlineState: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../app/compute-targets/service", () => ({
  computeTargetsService: {
    register: mockRegister,
    updateOwned: vi.fn(),
    setOnlineState: mockSetOnlineState,
    heartbeat: mockHeartbeat,
  },
  isComputeTargetGatewayConflictResult: (result: {
    ok: boolean;
    error?: string;
  }) => !result.ok && result.error === "gateway_conflict",
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    subscribeOperations: mockSubscribeOperations,
    subscribeTargetConnection: mockSubscribeTargetConnection,
    clearOperationBacklog: mockClearOperationBacklog,
  },
}));

vi.mock("../../app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: vi.fn(),
    touchLastUsedAt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../app/users/service", () => ({
  usersService: {
    findById: vi.fn(),
  },
}));

vi.mock("../auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: vi.fn().mockResolvedValue(null),
}));

vi.mock("../compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isDirectDesktopAuthSigningEligible: mockIsDirectDesktopAuthSigningEligible,
}));

vi.mock("../agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: mockIsAgentSessionSyncSupportedForUser,
}));

vi.mock("../desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: vi
    .fn()
    .mockResolvedValue({ accepted: true }),
}));

vi.mock("../desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: vi.fn().mockResolvedValue({ accepted: true }),
}));

vi.mock("../desktop-analytics-schema", () => ({
  DESKTOP_ANALYTICS_SOCKET_EVENT: "desktop.analytics",
  DesktopAnalyticsAckReason: { ValidationFailed: "validation_failed" },
}));

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn().mockReturnValue({ ok: true, emits: [] }),
}));

vi.mock("../desktop-gateway-reconnect", () => ({
  partitionPendingCommandsForReconnect: vi
    .fn()
    .mockReturnValue({ emit: [], skipped: [] }),
}));

vi.mock("../desktop-gateway-wire", () => ({
  emitCommand: vi.fn(),
  parseCommandAckPayload: vi.fn(),
  parseCommandEventPayload: vi.fn(),
  parseHelloPayload: vi.fn(),
  toEnvelope: vi.fn((payload: Record<string, unknown>) => payload),
  toWireCommandFromRelayOperation: vi.fn(),
  toWireCommandFromStore: vi.fn(),
  isDesktopCommandEventType: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: {
    capture: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn().mockReturnValue({}),
}));

import { handleSocketHello } from "../desktop-gateway-socket-server";

function installSuccessfulHelloDefaults() {
  mockRegister.mockResolvedValue({
    ok: true,
    value: { id: "target-behavioral-1" },
  });
  mockListNonTerminal.mockResolvedValue([]);
  mockSubscribeOperations.mockReturnValue(() => {});
  mockSubscribeTargetConnection.mockReturnValue(() => {});
  mockClearOperationBacklog.mockReturnValue(undefined);
  mockHeartbeat.mockResolvedValue(undefined);
  mockSetOnlineState.mockResolvedValue(true);
  mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
    status: "ineligible",
    reason: "missing_gateway",
  });
  mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(false);
}

function makeSocket() {
  return {
    id: "behavioral-test-socket-capability",
    connected: true,
    emit: vi.fn(),
    disconnect: vi.fn(),
    data: {},
  };
}

function makeAuthContext() {
  return {
    organizationId: "org-behavioral",
    userId: "user-behavioral",
    clerkUserId: "clerk-behavioral",
    apiKeySource: "DESKTOP_MANAGED" as any,
    apiKeyGatewayId: "gateway-behavioral",
    apiKeyBoundPublicKey: "public-key-behavioral",
  };
}

function makeHelloPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    machineName: "test-machine",
    platform: "linux",
    pluginVersion: "1.2.3",
    supportedOperations: [] as string[],
    maxInFlightCommands: 4,
    gatewayId: "gateway-behavioral",
    ...overrides,
  };
}

function getHelloAck(socket: ReturnType<typeof makeSocket>) {
  const ackCall = socket.emit.mock.calls.find(
    ([event]) => event === "desktop.hello.ack"
  );
  if (!ackCall) {
    throw new Error("desktop hello ack was not emitted");
  }
  return ackCall[1] as { serverCapabilities?: Record<string, unknown> };
}

describe("handleSocketHello — pending commands lookup timeout (behavioral)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    installSuccessfulHelloDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits nack with pending_commands_lookup_failed and disconnects when listNonTerminalDispatchCommands never resolves", async () => {
    // Mock listNonTerminalDispatchCommands to return a promise that never resolves
    mockListNonTerminal.mockReturnValue(new Promise<never>(() => {}));

    const mockSocket = {
      id: "behavioral-test-socket-1",
      connected: true,
      emit: vi.fn(),
      disconnect: vi.fn(),
      data: {},
    };

    const authContext = {
      organizationId: "org-behavioral",
      userId: "user-behavioral",
      clerkUserId: "clerk-behavioral",
      apiKeySource: "DESKTOP_MANAGED" as any,
      apiKeyGatewayId: "gateway-behavioral",
      apiKeyBoundPublicKey: "public-key-behavioral",
    };

    // No computeTargetId — goes to register path (targetCreated = true → onlineUpdatePromise = Promise.resolve(true))
    const payload = {
      machineName: "test-machine",
      platform: "linux",
      pluginVersion: "1.2.3",
      supportedOperations: [] as string[],
      maxInFlightCommands: 4,
    };

    const helloPromise = handleSocketHello(
      mockSocket as any,
      authContext,
      payload,
      { helloStartedAt: Date.now() }
    );

    // Advance fake timers past the 5s timeout used by withTimeout
    await vi.advanceTimersByTimeAsync(6000);

    // Await the handler to let all promise chains settle
    await helloPromise;

    // Assert nack was emitted with the pending_commands_lookup_failed reason
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.PendingCommandsLookupFailed,
      })
    );

    // Assert socket was disconnected
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it("invokes pendingCommands and setOnlineState in parallel (both started before either resolves)", async () => {
    // For setOnlineState to be called, targetCreated must be false — provide
    // an existing computeTargetId that resolves via updateOwned.
    const { computeTargetsService } = await import(
      "../../app/compute-targets/service"
    );
    vi.mocked(computeTargetsService.updateOwned).mockResolvedValue({
      ok: true,
      value: { id: "target-parallel-existing" },
    } as Awaited<ReturnType<typeof computeTargetsService.updateOwned>>);

    const invocations: string[] = [];
    let resolvePending: (value: unknown[]) => void = () => {};
    let resolveOnline: (value: boolean) => void = () => {};

    mockListNonTerminal.mockImplementation(() => {
      invocations.push("pendingCommands:start");
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    });
    mockSetOnlineState.mockImplementation(() => {
      invocations.push("setOnlineState:start");
      return new Promise((resolve) => {
        resolveOnline = resolve;
      });
    });

    const mockSocket = {
      id: "behavioral-test-socket-parallel",
      connected: true,
      emit: vi.fn(),
      disconnect: vi.fn(),
      data: {},
    };

    const authContext = {
      organizationId: "org-parallel",
      userId: "user-parallel",
      clerkUserId: "clerk-parallel",
      apiKeySource: "DESKTOP_MANAGED" as any,
      apiKeyGatewayId: "gateway-parallel",
      apiKeyBoundPublicKey: "public-key-parallel",
    };

    const payload = {
      machineName: "test-machine",
      platform: "linux",
      computeTargetId: "target-parallel-existing",
      pluginVersion: "1.2.3",
      supportedOperations: [] as string[],
      maxInFlightCommands: 4,
    };

    // Use real timers — fake timers prevent microtask flushes that
    // Promise.all needs to start the second leg before the first resolves.
    vi.useRealTimers();

    const helloPromise = handleSocketHello(
      mockSocket as unknown as Parameters<typeof handleSocketHello>[0],
      authContext,
      payload,
      { helloStartedAt: Date.now() }
    );

    // Wait one macrotask so both legs of Promise.all enter their executors.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invocations).toEqual([
      "pendingCommands:start",
      "setOnlineState:start",
    ]);

    // Resolve in the opposite order they were started to prove neither
    // gates the other.
    resolveOnline(true);
    resolvePending([]);

    await helloPromise;
  });
});

describe("handleSocketHello — command-signing capability behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    installSuccessfulHelloDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits computeTargetSigning for eligible direct desktop auth", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "eligible",
    });
    const socket = makeSocket();

    await handleSocketHello(
      socket as any,
      makeAuthContext(),
      makeHelloPayload(),
      {
        helloStartedAt: Date.now(),
      }
    );

    expect(mockIsDirectDesktopAuthSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-behavioral",
      userId: "user-behavioral",
      clerkUserId: "clerk-behavioral",
      apiKeySource: "DESKTOP_MANAGED",
      apiKeyGatewayId: "gateway-behavioral",
      apiKeyBoundPublicKey: "public-key-behavioral",
      targetGatewayId: "gateway-behavioral",
    });
    expect(getHelloAck(socket).serverCapabilities).toEqual({
      computeTargetSigning: true,
    });
  });

  it("falls back to the verified API-key gateway when hello omits gatewayId", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "eligible",
    });
    const socket = makeSocket();

    await handleSocketHello(
      socket as any,
      makeAuthContext(),
      makeHelloPayload({ gatewayId: undefined }),
      {
        helloStartedAt: Date.now(),
      }
    );

    expect(mockIsDirectDesktopAuthSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-behavioral",
      userId: "user-behavioral",
      clerkUserId: "clerk-behavioral",
      apiKeySource: "DESKTOP_MANAGED",
      apiKeyGatewayId: "gateway-behavioral",
      apiKeyBoundPublicKey: "public-key-behavioral",
      targetGatewayId: "gateway-behavioral",
    });
    expect(getHelloAck(socket).serverCapabilities).toEqual({
      computeTargetSigning: true,
    });
  });

  it.each([
    {
      name: "ineligible direct desktop auth",
      signingResult: { status: "ineligible", reason: "no_active_managed_key" },
      payload: makeHelloPayload(),
    },
    {
      name: "unknown eligibility",
      signingResult: {
        status: "unknown",
        reason: "command_signing_eligibility_unknown",
      },
      payload: makeHelloPayload(),
    },
    {
      name: "eligibility reports missing gateway",
      signingResult: { status: "ineligible", reason: "missing_gateway" },
      payload: makeHelloPayload({ gatewayId: undefined }),
    },
  ])("omits computeTargetSigning for $name", async ({
    signingResult,
    payload,
  }) => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue(signingResult);
    const socket = makeSocket();

    await handleSocketHello(socket as any, makeAuthContext(), payload as any, {
      helloStartedAt: Date.now(),
    });

    expect(getHelloAck(socket).serverCapabilities).toBeUndefined();
  });

  it("keeps agentSessionSync independent when signing is omitted", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "no_active_managed_key",
    });
    mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(true);
    const socket = makeSocket();

    await handleSocketHello(
      socket as any,
      makeAuthContext(),
      makeHelloPayload(),
      {
        helloStartedAt: Date.now(),
      }
    );

    expect(getHelloAck(socket).serverCapabilities).toEqual({
      agentSessionSync: true,
    });
  });
});
