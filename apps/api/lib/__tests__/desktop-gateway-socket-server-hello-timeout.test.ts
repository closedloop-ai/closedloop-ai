import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { ApiKeySource } from "@repo/database/generated/enums";
import type { Socket } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";

const {
  mockRegister,
  mockListNonTerminal,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
  mockClearOperationBacklog,
  mockHeartbeat,
  mockEmitCommand,
  mockIsDirectDesktopAuthSigningEligible,
  mockLogWarn,
  mockToWireCommandFromStore,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockEmitCommand: vi.fn(),
  mockIsDirectDesktopAuthSigningEligible: vi.fn(),
  mockLogWarn: vi.fn(),
  mockToWireCommandFromStore: vi.fn(),
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

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-gateway-wire", () => ({
  emitCommand: mockEmitCommand,
  handleRelayOperationForSocket: vi.fn(),
  parseCommandAckPayload: vi.fn(),
  parseCommandEventPayload: vi.fn(),
  parseHelloPayload: vi.fn(),
  toEnvelope: vi.fn((payload: Record<string, unknown>) => payload),
  toWireCommandFromRelayOperation: vi.fn(),
  toWireCommandFromStore: mockToWireCommandFromStore,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn().mockReturnValue({}),
}));

import { MACHINE_NAME_MAX_LENGTH } from "@/lib/compute-target-field-limits";
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
  mockToWireCommandFromStore.mockImplementation((command) => command);
}

function makeSocket(id = "behavioral-test-socket-capability") {
  const socket = mock<Socket>(
    { id, connected: true },
    { fallbackMockImplementation: failUnconfiguredSocketMember }
  );
  // Assigned rather than passed above: `mock()` would wrap a nested object in a
  // proxy that answers every unset key, and the handler reads its own state off
  // `socket.data`.
  socket.data = {};
  socket.emit.mockReturnValue(true);
  socket.disconnect.mockReturnValue(socket);
  return socket;
}

function makeAuthContext() {
  return {
    organizationId: "org-behavioral",
    userId: "user-behavioral",
    clerkUserId: "clerk-behavioral",
    apiKeySource: ApiKeySource.DESKTOP_MANAGED,
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

    const mockSocket = makeSocket("behavioral-test-socket-1");

    const authContext = {
      organizationId: "org-behavioral",
      userId: "user-behavioral",
      clerkUserId: "clerk-behavioral",
      apiKeySource: ApiKeySource.DESKTOP_MANAGED,
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

    const helloPromise = handleSocketHello(mockSocket, authContext, payload, {
      helloStartedAt: Date.now(),
    });

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

    const mockSocket = makeSocket("behavioral-test-socket-parallel");

    const authContext = {
      organizationId: "org-parallel",
      userId: "user-parallel",
      clerkUserId: "clerk-parallel",
      apiKeySource: ApiKeySource.DESKTOP_MANAGED,
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

    const helloPromise = handleSocketHello(mockSocket, authContext, payload, {
      helloStartedAt: Date.now(),
    });

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

    await handleSocketHello(socket, makeAuthContext(), makeHelloPayload(), {
      helloStartedAt: Date.now(),
    });

    expect(mockIsDirectDesktopAuthSigningEligible).toHaveBeenCalledWith({
      organizationId: "org-behavioral",
      userId: "user-behavioral",
      clerkUserId: "clerk-behavioral",
      apiKeySource: "DESKTOP_MANAGED",
      apiKeyGatewayId: "gateway-behavioral",
      apiKeyBoundPublicKey: "public-key-behavioral",
      targetGatewayId: "gateway-behavioral",
    });
    expect(getHelloAck(socket).serverCapabilities?.computeTargetSigning).toBe(
      true
    );
  });

  it("falls back to the verified API-key gateway when hello omits gatewayId", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "eligible",
    });
    const socket = makeSocket();

    await handleSocketHello(
      socket,
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
    expect(getHelloAck(socket).serverCapabilities?.computeTargetSigning).toBe(
      true
    );
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
  ])(
    "omits computeTargetSigning for $name",
    async ({ signingResult, payload }) => {
      mockIsDirectDesktopAuthSigningEligible.mockResolvedValue(signingResult);
      const socket = makeSocket();

      await handleSocketHello(socket, makeAuthContext(), payload, {
        helloStartedAt: Date.now(),
      });

      expect(
        getHelloAck(socket).serverCapabilities?.computeTargetSigning
      ).toBeUndefined();
    }
  );

  it("keeps agentSessionSync independent when signing is omitted", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "no_active_managed_key",
    });
    const socket = makeSocket();

    await handleSocketHello(socket, makeAuthContext(), makeHelloPayload(), {
      helloStartedAt: Date.now(),
    });

    expect(getHelloAck(socket).serverCapabilities).toEqual({
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

  it("soft-fails a rejected signing lookup without an InternalError nack", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockRejectedValue(
      new Error("signing lookup failed")
    );
    const socket = makeSocket();

    await handleSocketHello(socket, makeAuthContext(), makeHelloPayload(), {
      helloStartedAt: Date.now(),
    });

    expect(
      socket.emit.mock.calls.some(([event]) => event === "desktop.hello.nack")
    ).toBe(false);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(getHelloAck(socket).serverCapabilities).toEqual({
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      agentSessionSyncPrRefChunking: true,
      agentSessionSyncMonitoredActivity: true,
      agentSessionSyncSpanExtent: true,
      agentSessionSyncHumanTurnTimestamps: true,
      agentSessionSyncAgentTurnTimestamps: true,
      agentSessionSyncTokenEventOwner: true,
    });
  });

  it("soft-fails a timed-out signing lookup without an InternalError nack", async () => {
    mockIsDirectDesktopAuthSigningEligible.mockReturnValue(
      new Promise<never>(() => {})
    );
    const socket = makeSocket();

    const helloPromise = handleSocketHello(
      socket,
      makeAuthContext(),
      makeHelloPayload(),
      { helloStartedAt: Date.now() }
    );
    await vi.advanceTimersByTimeAsync(6000);
    await helloPromise;

    expect(
      socket.emit.mock.calls.some(([event]) => event === "desktop.hello.nack")
    ).toBe(false);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(getHelloAck(socket).serverCapabilities).toEqual({
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      agentSessionSyncPrRefChunking: true,
      agentSessionSyncMonitoredActivity: true,
      agentSessionSyncSpanExtent: true,
      agentSessionSyncHumanTurnTimestamps: true,
      agentSessionSyncAgentTurnTimestamps: true,
      agentSessionSyncTokenEventOwner: true,
    });
  });
});

describe("handleSocketHello — direct reconnect path partition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installSuccessfulHelloDefaults();
  });

  it("keeps all resume keys while emitting only gateway commands and warning for legacy rows", async () => {
    const valid = {
      commandId: "cmd-valid",
      computeTargetId: "target-behavioral-1",
      lastSequenceAcked: 4,
      path: "/api/gateway/symphony/loop",
    };
    const legacy = {
      commandId: "cmd-legacy",
      computeTargetId: "target-behavioral-1",
      lastSequenceAcked: 9,
      path: "/api/engineer/symphony/loop",
    };
    mockListNonTerminal.mockResolvedValue([valid, legacy]);
    const socket = makeSocket();

    await handleSocketHello(socket, makeAuthContext(), makeHelloPayload(), {
      helloStartedAt: Date.now(),
    });

    expect(getHelloAck(socket)).toMatchObject({
      resumeFromSequence: {
        "cmd-legacy": 9,
        "cmd-valid": 4,
      },
    });
    expect(mockToWireCommandFromStore).toHaveBeenCalledOnce();
    expect(mockToWireCommandFromStore).toHaveBeenCalledWith(valid);
    expect(mockEmitCommand).toHaveBeenCalledOnce();
    expect(mockEmitCommand).toHaveBeenCalledWith(socket, valid);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Pending command has non-gateway path — possible legacy command in store",
      {
        commandId: "cmd-legacy",
        computeTargetId: "target-behavioral-1",
        path: "/api/engineer/symphony/loop",
      }
    );
  });
});

// ---------------------------------------------------------------------------
// ISS-8880 §5 — the field bound is WIRED into handleSocketHello, not the schema
// ---------------------------------------------------------------------------

/**
 * The unit behaviour of the guard lives in
 * `desktop-gateway-hello-field-guard.test.ts`. What these two cases prove is
 * the production wiring: that `handleSocketHello` consults it BEFORE the
 * register/update call, so an over-bound name never reaches Postgres and the
 * desktop still gets a nack rather than a bare disconnect.
 *
 * Deleting the guard call from `handleSocketHello` leaves the guard's own unit
 * suite entirely green, which is why this pair exists here.
 */
describe("handleSocketHello — refuses an over-bound field before the DB call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installSuccessfulHelloDefaults();
  });

  it("nacks an over-bound machineName and never calls register", async () => {
    const socket = makeSocket();

    await handleSocketHello(
      socket,
      makeAuthContext(),
      makeHelloPayload({
        machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH + 1),
      }) as never,
      { helloStartedAt: Date.now() }
    );

    expect(mockRegister).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
      })
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("still registers a hello at the bound, so the guard is not over-rejecting", async () => {
    const socket = makeSocket();

    await handleSocketHello(
      socket,
      makeAuthContext(),
      makeHelloPayload({
        machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH),
      }) as never,
      { helloStartedAt: Date.now() }
    );

    expect(mockRegister).toHaveBeenCalledWith(
      "org-behavioral",
      "user-behavioral",
      expect.objectContaining({
        machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH),
      })
    );
  });
});

function failUnconfiguredSocketMember(): never {
  throw new Error(
    "handleSocketHello reached a socket member this test did not configure"
  );
}
