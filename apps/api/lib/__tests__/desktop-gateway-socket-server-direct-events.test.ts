/**
 * Direct Socket.IO wiring for the desktop agent-session and analytics events.
 *
 * FEA-4112 replaced two source-text guards here — they grepped
 * `desktop-gateway-socket-server.ts`, `apps/relay/src/index.ts` and the internal
 * relay socket-event service for substrings — with behavior. A substring match
 * could not tell whether the handler was actually reached, nor whether it was
 * handed the authenticated context, so it passed on wiring that would have been
 * broken in production.
 *
 * Scope is the DIRECT path only. The relay path the deleted assertions poked at
 * is already covered behaviorally by its owners:
 *   - `apps/relay/src/__tests__/index.test.ts` (event registration, forwarding)
 *   - `apps/relay/src/__tests__/desktop-analytics.test.ts` (socket id, ack map)
 *   - `apps/api/app/internal/relay/socket-event/service-agent-sessions.test.ts`
 *   - `apps/api/app/internal/relay/socket-event/service-desktop-analytics.test.ts`
 */
import {
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import { ApiKeySource } from "@repo/database/generated/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetCommandById,
  mockHandleDesktopAgentSessionsEvent,
  mockHandleDesktopAnalyticsEvent,
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
  mockGetCommandById: vi.fn(),
  mockHandleDesktopAgentSessionsEvent: vi.fn(),
  mockHandleDesktopAnalyticsEvent: vi.fn(),
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
    getCommandById: mockGetCommandById,
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

// Only the function is faked: the real `CommandSigningEligibilityStatus` is
// spread through so the mocked module cannot drift from the shape production
// actually produces.
vi.mock("../compute-target-signing-eligibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../compute-target-signing-eligibility")
  >()),
  isDirectDesktopAuthSigningEligible: mockIsDirectDesktopAuthSigningEligible,
}));

vi.mock("../agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: mockIsAgentSessionSyncSupportedForUser,
}));

vi.mock("../desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: mockHandleDesktopAgentSessionsEvent,
}));

vi.mock("../desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: mockHandleDesktopAnalyticsEvent,
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

import { CommandSigningEligibilityStatus } from "../compute-target-signing-eligibility";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  DesktopAnalyticsAckReason,
} from "../desktop-analytics-schema";
import { handleSocketConnection } from "../desktop-gateway-socket-server";

type SocketHandler = (...args: unknown[]) => unknown;

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const CLERK_USER_ID = "clerk-1";
const TARGET_ID = "target-direct-1";
const PLUGIN_VERSION = "1.2.3";

const AGENT_SESSIONS_PAYLOAD = { sessions: [] };
const ANALYTICS_PAYLOAD = { events: [] };

// The gateway keys its live-context map by socket id at module scope, so two
// sockets sharing an id would leak one test's hello context into the next and
// quietly turn the "no context" cases green for the wrong reason.
let nextSocketId = 0;

function makeSocket() {
  nextSocketId += 1;
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    id: `direct-socket-${nextSocketId}`,
    connected: true,
    data: {
      authContext: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        apiKeySource: ApiKeySource.DESKTOP_MANAGED,
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

/** Connect + complete the hello handshake, returning the live session id. */
async function connectAndSayHello(): Promise<{
  handlers: Map<string, SocketHandler>;
  socket: ReturnType<typeof makeSocket>["socket"];
  sessionId: string;
}> {
  const { handlers, socket } = makeSocket();
  handleSocketConnection(socket as never);

  await handlers.get("desktop.hello")?.({
    gatewayId: "gateway-1",
    machineName: "test-machine",
    maxInFlightCommands: 2,
    platform: "darwin",
    pluginVersion: PLUGIN_VERSION,
    supportedOperations: [],
  });

  // `vi.waitFor` retries while the callback throws, so this is the wait — the
  // assertions belong in the tests, not in a shared helper.
  const sessionId = await vi.waitFor(() => {
    const ack = socket.emit.mock.calls.find(
      ([event]) => event === "desktop.hello.ack"
    )?.[1] as { sessionId?: string } | undefined;
    if (typeof ack?.sessionId !== "string") {
      throw new Error("desktop.hello.ack was not emitted with a session id");
    }
    return ack.sessionId;
  });

  return { handlers, socket, sessionId };
}

describe("direct desktop agent-session socket wiring", () => {
  beforeEach(() => {
    resetGatewayMocks();
  });

  it("routes the raw payload and the authenticated session context to the shared handler, and acks its response", async () => {
    const response = { accepted: true, processed: 3 };
    mockHandleDesktopAgentSessionsEvent.mockResolvedValue(response);
    const { handlers, sessionId } = await connectAndSayHello();
    const ack = vi.fn();

    handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      AGENT_SESSIONS_PAYLOAD,
      ack
    );

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledWith(response);
    });
    expect(mockHandleDesktopAgentSessionsEvent).toHaveBeenCalledWith(
      AGENT_SESSIONS_PAYLOAD,
      {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        targetId: TARGET_ID,
        gatewaySessionId: sessionId,
      }
    );
  });

  it("acks validation_failed without calling the handler when no hello context exists", () => {
    const { handlers, socket } = makeSocket();
    handleSocketConnection(socket as never);
    const ack = vi.fn();

    handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      AGENT_SESSIONS_PAYLOAD,
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(mockHandleDesktopAgentSessionsEvent).not.toHaveBeenCalled();
  });

  it("acks validation_failed when the shared handler rejects", async () => {
    mockHandleDesktopAgentSessionsEvent.mockRejectedValue(new Error("boom"));
    const { handlers } = await connectAndSayHello();
    const ack = vi.fn();

    handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      AGENT_SESSIONS_PAYLOAD,
      ack
    );

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledWith({
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    });
  });
});

describe("direct desktop analytics socket wiring", () => {
  beforeEach(() => {
    resetGatewayMocks();
  });

  it("routes the raw payload, the authenticated context with pluginVersion, and a capture adapter to the shared handler", async () => {
    const response = { accepted: true };
    mockHandleDesktopAnalyticsEvent.mockResolvedValue(response);
    const { handlers, sessionId } = await connectAndSayHello();
    const ack = vi.fn();

    handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(ANALYTICS_PAYLOAD, ack);

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledWith(response);
    });
    expect(mockHandleDesktopAnalyticsEvent).toHaveBeenCalledWith(
      ANALYTICS_PAYLOAD,
      {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        targetId: TARGET_ID,
        gatewaySessionId: sessionId,
        pluginVersion: PLUGIN_VERSION,
      },
      { capture: expect.any(Function) }
    );
  });

  it("acks validation_failed without calling the handler when no hello context exists", () => {
    const { handlers, socket } = makeSocket();
    handleSocketConnection(socket as never);
    const ack = vi.fn();

    handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(ANALYTICS_PAYLOAD, ack);

    expect(ack).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
    expect(mockHandleDesktopAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("acks validation_failed when the shared handler rejects", async () => {
    mockHandleDesktopAnalyticsEvent.mockRejectedValue(new Error("boom"));
    const { handlers } = await connectAndSayHello();
    const ack = vi.fn();

    handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(ANALYTICS_PAYLOAD, ack);

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledWith({
        accepted: false,
        reason: DesktopAnalyticsAckReason.ValidationFailed,
      });
    });
  });
});

function resetGatewayMocks(): void {
  vi.clearAllMocks();
  mockRegister.mockResolvedValue({ ok: true, value: { id: TARGET_ID } });
  mockListNonTerminal.mockResolvedValue([]);
  mockSubscribeOperations.mockReturnValue(() => {
    // no-op unsubscribe
  });
  mockSubscribeTargetConnection.mockReturnValue(() => {
    // no-op unsubscribe
  });
  mockClearOperationBacklog.mockReturnValue(undefined);
  mockHeartbeat.mockResolvedValue(undefined);
  mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
    status: CommandSigningEligibilityStatus.Ineligible,
    reason: "missing_gateway",
  });
  mockIsAgentSessionSyncSupportedForUser.mockResolvedValue(false);
  mockGetCommandById.mockResolvedValue(null);
  mockHandleDesktopAgentSessionsEvent.mockResolvedValue({ accepted: true });
  mockHandleDesktopAnalyticsEvent.mockResolvedValue({ accepted: true });
}
