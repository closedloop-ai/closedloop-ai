/**
 * gateway-event-handlers.test.ts
 *
 * Covers the six socket.on(...) handlers registered inside the
 * namespace.on("connection") block in index.ts:
 *
 *  • Pre-registration buffering — events pushed to pendingBuffer before desktop.hello
 *  • pushPendingBuffer at MAX_PENDING_BUFFER_SIZE (100) cap — 101st dropped, ack refused
 *  • drainPendingBuffer — buffered acks refused when hello returns disconnect or no targetId
 *  • Ack mappers — toDesktopAnalyticsAck and toDesktopAgentSessionsAck all arms
 *  • Forward rejection paths — .catch arms when fetch rejects for ack-bearing events
 *  • Payload ternaries — commandId/computeTargetId from non-object payload
 */

import {
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  type DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  type DesktopAnalyticsAck,
  DesktopAnalyticsAckReason,
} from "@repo/api/src/types/desktop-analytics";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createGatewayHarness,
  type MockRelaySocket,
} from "./gateway-harness.js";

// ─── hoisted socket.io namespace mock ────────────────────────────────────────

const socketIoMocks = vi.hoisted(() => ({
  namespace: { use: vi.fn(), on: vi.fn() },
}));

vi.mock("socket.io", () => ({
  Server: class {
    of(ns?: string) {
      if (ns === "/desktop-gateway") {
        return socketIoMocks.namespace;
      }
      return { use() {}, on() {} };
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  return { createServer: vi.fn(createMockHttpServerFactory()) };
});

// ─── env & module setup ──────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };
const TEST_API_URL = "http://127.0.0.1:19878";

const harness = createGatewayHarness(socketIoMocks.namespace);

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret-geh";
  process.env.RELAY_PORT = "20500";
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  await import("../index");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanupRegisteredSockets();
  vi.unstubAllGlobals();
});

// ─── fetch-mock helpers ───────────────────────────────────────────────────────

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    url: `${TEST_API_URL}/internal/relay/socket-event`,
    headers: { get: () => "application/json" },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeHelloResponse(targetId: string) {
  return makeOkResponse({
    emit: [],
    targetId,
    gatewaySessionId: `gw-${targetId}`,
  });
}

function makeEventResponse(ack?: unknown) {
  return makeOkResponse({ emit: [], ...(ack !== undefined && { ack }) });
}

/**
 * Sets fetch to handle hello (returns targetId) and all other events (returns ack).
 * Re-stubs after hello so the next event call picks up the event response.
 */
async function registerAndStub(
  socket: MockRelaySocket,
  targetId: string,
  eventAck?: unknown
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        event: string;
      };
      return Promise.resolve(
        body.event === "desktop.hello"
          ? makeHelloResponse(targetId)
          : makeEventResponse(eventAck)
      );
    })
  );
  await harness.registerSocketTarget(socket, targetId);
}

// ─── sample payloads ──────────────────────────────────────────────────────────

const SAMPLE_ANALYTICS_PAYLOAD = {
  event: "command_started",
  properties: {},
  occurredAt: "2026-01-01T00:00:00.000Z",
};

const SAMPLE_AGENT_SESSIONS_PAYLOAD = {
  schemaVersion: 3,
  sessions: [],
};

// ─── ack mapper: toDesktopAnalyticsAck ───────────────────────────────────────

describe("toDesktopAnalyticsAck mapper (via DESKTOP_ANALYTICS_SOCKET_EVENT handler)", () => {
  async function triggerAnalyticsAck(
    ackFromApi: unknown
  ): Promise<DesktopAnalyticsAck> {
    const tid = `target-ack-analytics-${String(ackFromApi)}`.slice(0, 50);
    const socket = harness.createMockRelaySocket(
      `sock-ack-an-${String(ackFromApi)}`.slice(0, 40)
    );
    await registerAndStub(socket, tid, ackFromApi);

    return new Promise<DesktopAnalyticsAck>((resolve) => {
      socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
        SAMPLE_ANALYTICS_PAYLOAD,
        resolve
      );
    });
  }

  it("returns {accepted:false, reason:ValidationFailed} for a null (non-object) ack", async () => {
    const ack = await triggerAnalyticsAck(null);
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });

  it("returns {accepted:false, reason:ValidationFailed} for a string (non-object) ack", async () => {
    const ack = await triggerAnalyticsAck("accepted");
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });

  it("returns {accepted:true} for {accepted:true} ack", async () => {
    const ack = await triggerAnalyticsAck({ accepted: true });
    expect(ack).toEqual({ accepted: true });
  });

  it("preserves a known DesktopAnalyticsAckReason verbatim", async () => {
    const ack = await triggerAnalyticsAck({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
  });

  it("collapses an unknown/future reason string to ValidationFailed", async () => {
    const ack = await triggerAnalyticsAck({
      accepted: false,
      reason: "future_unknown_reason_v99",
    });
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });
});

// ─── ack mapper: toDesktopAgentSessionsAck ───────────────────────────────────

describe("toDesktopAgentSessionsAck mapper (via DESKTOP_AGENT_SESSIONS_SOCKET_EVENT handler)", () => {
  async function triggerAgentSessionsAck(
    ackFromApi: unknown
  ): Promise<DesktopAgentSessionsAck> {
    const tid = `target-ack-as-${String(ackFromApi)}`.slice(0, 50);
    const socket = harness.createMockRelaySocket(
      `sock-ack-as-${String(ackFromApi)}`.slice(0, 40)
    );
    await registerAndStub(socket, tid, ackFromApi);

    return new Promise<DesktopAgentSessionsAck>((resolve) => {
      socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
        SAMPLE_AGENT_SESSIONS_PAYLOAD,
        resolve
      );
    });
  }

  it("returns {accepted:false, reason:IngestionFailed} for a non-object ack", async () => {
    const ack = await triggerAgentSessionsAck(42);
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  });

  it("returns {accepted:true} for {accepted:true} ack", async () => {
    const ack = await triggerAgentSessionsAck({ accepted: true });
    expect(ack).toEqual({ accepted: true });
  });

  it("preserves a known DesktopAgentSessionsAckReason verbatim", async () => {
    const ack = await triggerAgentSessionsAck({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
  });

  it("collapses an unknown/future reason string to IngestionFailed", async () => {
    const ack = await triggerAgentSessionsAck({
      accepted: false,
      reason: "future_reason_not_in_enum",
    });
    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  });
});

// ─── pre-registration buffering ──────────────────────────────────────────────

describe("pre-registration buffering — events pushed to pendingBuffer before desktop.hello", () => {
  it("buffers desktop.command.event before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-cmd-event");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.command.event")?.({
      commandId: "c1",
      computeTargetId: "t1",
    });
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.command.event");
  });

  it("buffers desktop.command.ack before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-cmd-ack");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.command.ack")?.({ commandId: "c2" });
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.command.ack");
  });

  it("buffers desktop.telemetry before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-telemetry");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.telemetry")?.({
      category: "loop.perf.iteration",
    });
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.telemetry");
  });

  it("buffers DESKTOP_AGENT_SESSIONS_SOCKET_EVENT before hello and does not call ack", () => {
    const socket = harness.createMockRelaySocket("sock-pre-agent-sessions");
    harness.getConnectionHandler()(socket);
    const ackFn = vi.fn();
    socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      SAMPLE_AGENT_SESSIONS_PAYLOAD,
      ackFn
    );
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe(
      DESKTOP_AGENT_SESSIONS_SOCKET_EVENT
    );
    expect(ackFn).not.toHaveBeenCalled();
  });

  it("buffers DESKTOP_ANALYTICS_SOCKET_EVENT before hello and does not call ack", () => {
    const socket = harness.createMockRelaySocket("sock-pre-analytics");
    harness.getConnectionHandler()(socket);
    const ackFn = vi.fn();
    socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
      SAMPLE_ANALYTICS_PAYLOAD,
      ackFn
    );
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe(
      DESKTOP_ANALYTICS_SOCKET_EVENT
    );
    expect(ackFn).not.toHaveBeenCalled();
  });

  it("buffers desktop.presence before hello", () => {
    const socket = harness.createMockRelaySocket("sock-pre-presence");
    harness.getConnectionHandler()(socket);
    socket.handlers.get("desktop.presence")?.();
    expect(socket.data.pendingBuffer).toHaveLength(1);
    expect(socket.data.pendingBuffer?.[0]?.event).toBe("desktop.presence");
  });
});

// ─── pushPendingBuffer at MAX_PENDING_BUFFER_SIZE cap ────────────────────────

describe("pushPendingBuffer at MAX_PENDING_BUFFER_SIZE (100) cap", () => {
  it("drops the 101st agent-sessions event and acks it with ValidationFailed", () => {
    const socket = harness.createMockRelaySocket("sock-cap-agent-sessions");
    harness.getConnectionHandler()(socket);

    // Fill the buffer to capacity with command events (no ack)
    for (let i = 0; i < 100; i++) {
      socket.handlers.get("desktop.command.event")?.({ commandId: `c${i}` });
    }
    expect(socket.data.pendingBuffer).toHaveLength(100);

    const ackFn = vi.fn();
    socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      SAMPLE_AGENT_SESSIONS_PAYLOAD,
      ackFn
    );

    // Buffer must not grow past 100
    expect(socket.data.pendingBuffer).toHaveLength(100);
    expect(ackFn).toHaveBeenCalledOnce();
    expect(ackFn).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
  });

  it("drops the 101st analytics event and acks it with ValidationFailed", () => {
    const socket = harness.createMockRelaySocket("sock-cap-analytics");
    harness.getConnectionHandler()(socket);

    for (let i = 0; i < 100; i++) {
      socket.handlers.get("desktop.command.event")?.({ commandId: `c${i}` });
    }

    const ackFn = vi.fn();
    socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
      SAMPLE_ANALYTICS_PAYLOAD,
      ackFn
    );

    expect(socket.data.pendingBuffer).toHaveLength(100);
    expect(ackFn).toHaveBeenCalledOnce();
    expect(ackFn).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });

  it("drops a generic command event when buffer is full with no ack callback side-effect", () => {
    const socket = harness.createMockRelaySocket("sock-cap-generic");
    harness.getConnectionHandler()(socket);

    for (let i = 0; i < 100; i++) {
      socket.handlers.get("desktop.command.event")?.({ commandId: `c${i}` });
    }

    // 101st command event — no ack, just dropped
    socket.handlers.get("desktop.command.event")?.({ commandId: "overflow" });
    expect(socket.data.pendingBuffer).toHaveLength(100);
  });
});

// ─── drainPendingBuffer ───────────────────────────────────────────────────────

describe("drainPendingBuffer — buffered acks refused when hello returns disconnect or no targetId", () => {
  it("calls acks with ValidationFailed when hello API returns disconnect:true", async () => {
    const socket = harness.createMockRelaySocket("sock-drain-disconnect");
    harness.getConnectionHandler()(socket);

    const agentSessionsAck = vi.fn();
    socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      SAMPLE_AGENT_SESSIONS_PAYLOAD,
      agentSessionsAck
    );
    const analyticsAck = vi.fn();
    socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
      SAMPLE_ANALYTICS_PAYLOAD,
      analyticsAck
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [], disconnect: true }))
    );

    await socket.handlers.get("desktop.hello")?.({
      targetId: "drain-target-disconnect",
    });

    expect(agentSessionsAck).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(analyticsAck).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });

  it("calls acks with ValidationFailed when hello API returns no targetId", async () => {
    const socket = harness.createMockRelaySocket("sock-drain-notarget");
    harness.getConnectionHandler()(socket);

    const agentSessionsAck = vi.fn();
    socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
      SAMPLE_AGENT_SESSIONS_PAYLOAD,
      agentSessionsAck
    );
    const analyticsAck = vi.fn();
    socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
      SAMPLE_ANALYTICS_PAYLOAD,
      analyticsAck
    );

    // No targetId in response → drainPendingBuffer called, no registerWorker
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeOkResponse({ emit: [] }))
    );

    await socket.handlers.get("desktop.hello")?.({
      targetId: "drain-target-notarget",
    });

    expect(agentSessionsAck).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(analyticsAck).toHaveBeenCalledWith({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });
});

// ─── forward rejection paths ──────────────────────────────────────────────────

describe("forward rejection paths — .catch arms when fetch rejects for ack-bearing events", () => {
  it("calls ack with IngestionFailed when DESKTOP_AGENT_SESSIONS_SOCKET_EVENT forward rejects", async () => {
    const socket = harness.createMockRelaySocket("sock-reject-agent-sessions");
    await registerAndStub(socket, "target-reject-agent-sessions");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const ack = await new Promise<DesktopAgentSessionsAck>((resolve) => {
      socket.handlers.get(DESKTOP_AGENT_SESSIONS_SOCKET_EVENT)?.(
        SAMPLE_AGENT_SESSIONS_PAYLOAD,
        resolve
      );
    });

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  });

  it("calls ack with ValidationFailed when DESKTOP_ANALYTICS_SOCKET_EVENT forward rejects", async () => {
    const socket = harness.createMockRelaySocket("sock-reject-analytics");
    await registerAndStub(socket, "target-reject-analytics");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const ack = await new Promise<DesktopAnalyticsAck>((resolve) => {
      socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT)?.(
        SAMPLE_ANALYTICS_PAYLOAD,
        resolve
      );
    });

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });
  });

  it("completes without throwing when desktop.command.ack forward rejects (no ack callback)", async () => {
    const socket = harness.createMockRelaySocket("sock-reject-cmd-ack");
    await registerAndStub(socket, "target-reject-cmd-ack");

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    // Resolved via the Map directly (not `?.`) so that deleting the
    // desktop.command.ack registration fails this test instead of
    // short-circuiting into a vacuous pass.
    const ackHandler = socket.handlers.get("desktop.command.ack");
    expect(ackHandler).toBeDefined();

    let threw = false;
    try {
      await (ackHandler as (...args: unknown[]) => Promise<void> | void)({
        commandId: "c1",
      });
      // Need to wait for the async catch handler to run
      await Promise.resolve();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The forward was actually attempted and its rejection swallowed — without
    // this, a handler that never called fetch would also "not throw".
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ─── payload ternaries — commandId/computeTargetId from non-object payload ───

describe("payload ternaries — commandId/computeTargetId undefined for non-object payload", () => {
  it("forwards desktop.command.event with non-object payload without throwing", async () => {
    const socket = harness.createMockRelaySocket("sock-non-obj-cmd-event");
    await registerAndStub(socket, "target-non-obj-cmd-event");

    const fetchMock = vi.fn().mockResolvedValue(makeEventResponse());
    vi.stubGlobal("fetch", fetchMock);

    // Non-object payload → commandId and computeTargetId are undefined (log only)
    socket.handlers.get("desktop.command.event")?.(null);
    // Let the enqueue run
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    ) as { payload: unknown };
    expect(body.payload).toBeNull();
  });

  it("forwards desktop.command.ack with non-object payload without throwing", async () => {
    const socket = harness.createMockRelaySocket("sock-non-obj-cmd-ack");
    await registerAndStub(socket, "target-non-obj-cmd-ack");

    const fetchMock = vi.fn().mockResolvedValue(makeEventResponse());
    vi.stubGlobal("fetch", fetchMock);

    await socket.handlers.get("desktop.command.ack")?.(null);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    ) as { payload: unknown };
    expect(body.payload).toBeNull();
  });
});
