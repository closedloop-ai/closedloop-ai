import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockHeartbeat,
  mockIngestCommandEvent,
  mockIsAgentSessionSyncSupportedForUser,
  mockIsDirectDesktopAuthSigningEligible,
  mockListNonTerminal,
  mockRegister,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
  mockClearOperationBacklog,
} = vi.hoisted(() => ({
  mockHeartbeat: vi.fn(),
  mockIngestCommandEvent: vi.fn(),
  mockIsAgentSessionSyncSupportedForUser: vi.fn(),
  mockIsDirectDesktopAuthSigningEligible: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockRegister: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
}));

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: { capture: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: vi.fn(),
    ingestCommandEvent: mockIngestCommandEvent,
    listNonTerminalDispatchCommands: mockListNonTerminal,
  },
}));

vi.mock("../../app/compute-targets/service", () => ({
  computeTargetsService: {
    heartbeat: mockHeartbeat,
    register: mockRegister,
    setOnlineState: vi.fn(),
    updateOwned: vi.fn(),
  },
  isComputeTargetGatewayConflictResult: (result: { ok: boolean }) =>
    result.ok === false,
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: mockClearOperationBacklog,
    subscribeOperations: mockSubscribeOperations,
    subscribeTargetConnection: mockSubscribeTargetConnection,
  },
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

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn().mockReturnValue({ ok: true, emits: [] }),
}));

import { handleSocketConnection } from "../desktop-gateway-socket-server";

type SocketHandler = (...args: unknown[]) => unknown;

function makeSocket() {
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    id: "direct-socket-1",
    connected: true,
    data: {
      authContext: {
        organizationId: "org-1",
        userId: "user-1",
        clerkUserId: "clerk-1",
        apiKeySource: "DESKTOP_MANAGED",
        apiKeyGatewayId: "gateway-1",
        apiKeyBoundPublicKey: "public-key-1",
      },
    },
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  };
  return { handlers, socket };
}

describe("handleSocketConnection command telemetry context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({
      ok: true,
      value: { id: "target-direct-1" },
    });
    mockListNonTerminal.mockResolvedValue([]);
    mockSubscribeOperations.mockReturnValue(() => {});
    mockSubscribeTargetConnection.mockReturnValue(() => {});
    mockClearOperationBacklog.mockReturnValue(undefined);
    mockHeartbeat.mockResolvedValue(undefined);
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: "ineligible",
      reason: "missing_gateway",
    });
    mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(false);
    mockIngestCommandEvent.mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
  });

  it("passes direct socket session context to command event ingestion", async () => {
    const { handlers, socket } = makeSocket();
    handleSocketConnection(socket as never);

    await handlers.get("desktop.hello")?.({
      gatewayId: "gateway-1",
      machineName: "test-machine",
      maxInFlightCommands: 2,
      platform: "darwin",
      pluginVersion: "1.2.3",
      supportedOperations: [],
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.objectContaining({
          computeTargetId: "target-direct-1",
          sessionId: expect.any(String),
        })
      );
    });

    const helloAck = socket.emit.mock.calls.find(
      ([event]) => event === "desktop.hello.ack"
    )?.[1] as { sessionId: string };

    handlers.get("desktop.command.event")?.({
      commandId: "cmd-direct-1",
      data: { terminal: true },
      eventType: "done",
      sequence: 1,
    });

    await vi.waitFor(() => {
      expect(mockIngestCommandEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: "cmd-direct-1",
          computeTargetId: "target-direct-1",
          context: expect.objectContaining({
            commandId: "cmd-direct-1",
            computeTargetId: "target-direct-1",
            gatewaySessionId: helloAck.sessionId,
            schemaVersion: "1",
          }),
        })
      );
    });

    handlers.get("disconnect")?.();
  });
});
