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

// Behavioral replacement for the old source-text guard: drive the real
// desktop.analytics relay handler through the mocked socket.io harness and assert
// its observable forwarding contract — it forwards to the internal API with the
// originating relay socket id, resolves the mapped DesktopAnalyticsAck, preserves
// newly added ack reasons (rather than collapsing them to validation_failed), and
// buffers events that arrive before the worker registers. Mirrors the socket
// harness in index.test.ts.

const socketIoMocks = vi.hoisted(() => ({
  namespace: {
    use: vi.fn(),
    on: vi.fn(),
  },
}));

const TEST_PORT = 20_000 + Math.floor(Math.random() * 10_000);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let stopRelay: (() => Promise<void>) | null = null;

// Mock socket.io to avoid starting a real Socket.IO server in tests.
vi.mock("socket.io", () => {
  return {
    Server: class MockServer {
      of(namespace?: string) {
        if (namespace === "/desktop-gateway") {
          return socketIoMocks.namespace;
        }
        return { use() {}, on() {} };
      }

      close() {
        return Promise.resolve();
      }
    },
  };
});

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
  process.env.HTTP_PROXY = "";
  process.env.HTTPS_PROXY = "";
  process.env.http_proxy = "";
  process.env.https_proxy = "";

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  for (const socket of registeredTestSockets) {
    await disconnectSocketTarget(socket);
  }
  registeredTestSockets.clear();
  vi.unstubAllGlobals();
});

type MockRelaySocket = {
  id: string;
  data: {
    auth: {
      organizationId: string;
      userId: string;
    };
    pendingBuffer?: Array<{ event: string; args: unknown[] }>;
  };
  conn: { transport: { name: string } };
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Map<string, (...args: unknown[]) => Promise<void> | void>;
};

const registeredTestSockets = new Set<MockRelaySocket>();

function createMockRelaySocket(id: string): MockRelaySocket {
  const handlers = new Map<
    string,
    (...args: unknown[]) => Promise<void> | void
  >();
  return {
    id,
    data: {
      auth: {
        organizationId: "org-1",
        userId: "user-1",
      },
    },
    conn: { transport: { name: "websocket" } },
    connected: true,
    on: vi.fn(
      (
        event: string,
        handler: (...args: unknown[]) => Promise<void> | void
      ) => {
        handlers.set(event, handler);
      }
    ),
    emit: vi.fn(),
    disconnect: vi.fn(),
    handlers,
  };
}

function getConnectionHandler() {
  const call = socketIoMocks.namespace.on.mock.calls.find(
    ([event]) => event === "connection"
  );
  if (!call) {
    throw new Error("Expected relay connection handler to be registered");
  }
  return call[1] as (socket: MockRelaySocket) => void;
}

async function registerSocketTarget(socket: MockRelaySocket, targetId: string) {
  getConnectionHandler()(socket);
  const helloHandler = socket.handlers.get("desktop.hello");
  if (!helloHandler) {
    throw new Error("Expected desktop.hello handler to be registered");
  }
  await helloHandler({ targetId, pluginVersion: "test" });
  registeredTestSockets.add(socket);
}

async function disconnectSocketTarget(socket: MockRelaySocket) {
  const disconnectHandler = socket.handlers.get("disconnect");
  if (!disconnectHandler) {
    return;
  }
  socket.connected = false;
  await disconnectHandler("test_cleanup");
}

function analyticsHandlerFor(socket: MockRelaySocket) {
  const handler = socket.handlers.get(DESKTOP_ANALYTICS_SOCKET_EVENT);
  if (!handler) {
    throw new Error("Expected desktop.analytics handler to be registered");
  }
  return handler;
}

// Stub the internal-API fetch (callVercel) so the analytics forward resolves with
// the given ack; other forwarded events (e.g. desktop.hello registration) get a
// benign response without an ack.
function stubForwardingFetch(analyticsAck: unknown) {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const requestBody = JSON.parse(String(init.body)) as {
      event?: string;
      payload?: { targetId?: string };
    };
    const base = {
      targetId: requestBody.payload?.targetId,
      gatewaySessionId: "gateway-analytics",
      emit: [],
    };
    const responseBody =
      requestBody.event === DESKTOP_ANALYTICS_SOCKET_EVENT
        ? { ...base, ack: analyticsAck }
        : base;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function forwardedAnalyticsBody(
  fetchMock: ReturnType<typeof stubForwardingFetch>
): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => {
    const body = JSON.parse(String((init as RequestInit).body)) as {
      event?: string;
    };
    return body.event === DESKTOP_ANALYTICS_SOCKET_EVENT;
  });
  if (!call) {
    throw new Error("Expected a forwarded desktop.analytics request");
  }
  return JSON.parse(String((call[1] as RequestInit).body));
}

const SAMPLE_ANALYTICS_PAYLOAD = {
  event: "command_started",
  properties: {},
  occurredAt: "2026-07-01T00:00:00.000Z",
};

describe("desktop.analytics relay forwarding", () => {
  it("forwards to the internal API with the relay socket id and resolves the mapped ack", async () => {
    const fetchMock = stubForwardingFetch({ accepted: true });
    const socket = createMockRelaySocket("socket-analytics");
    await registerSocketTarget(socket, "target-analytics");

    const ack = await new Promise<DesktopAnalyticsAck>((resolve) => {
      analyticsHandlerFor(socket)(SAMPLE_ANALYTICS_PAYLOAD, resolve);
    });

    expect(ack).toEqual({ accepted: true });
    const body = forwardedAnalyticsBody(fetchMock);
    expect(body.relaySocketId).toBe("socket-analytics");
    expect(body.targetId).toBe("target-analytics");
    expect((body.payload as { event?: string }).event).toBe("command_started");
  });

  it("preserves a known ack reason (capture_failed) instead of collapsing it to validation_failed", async () => {
    stubForwardingFetch({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
    const socket = createMockRelaySocket("socket-analytics-reason");
    await registerSocketTarget(socket, "target-analytics-reason");

    const ack = await new Promise<DesktopAnalyticsAck>((resolve) => {
      analyticsHandlerFor(socket)(SAMPLE_ANALYTICS_PAYLOAD, resolve);
    });

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
  });

  it("buffers analytics that arrives before the worker registers, without forwarding", () => {
    const fetchMock = stubForwardingFetch({ accepted: true });
    const socket = createMockRelaySocket("socket-analytics-early");
    // Connection established but no desktop.hello yet, so the socket has no
    // registered target.
    getConnectionHandler()(socket);
    const ack = vi.fn();

    analyticsHandlerFor(socket)(SAMPLE_ANALYTICS_PAYLOAD, ack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(socket.data.pendingBuffer?.length).toBe(1);
  });
});
