import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Types for captured namespace handlers
// ---------------------------------------------------------------------------

type NextFn = (err?: Error) => void;
type SocketMiddlewareFn = (socket: MockSocket, next: NextFn) => void;
type ConnectionHandlerFn = (socket: MockSocket) => void;
type SocketEventHandler = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// Mock socket shape matching what index.ts expects
// ---------------------------------------------------------------------------

type MockSocket = {
  id: string;
  connected: boolean;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, string>;
    headers: Record<string, string>;
  };
  conn: { transport: { name: string } };
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  // Internal helpers for test control
  _handlers: Map<string, SocketEventHandler>;
  _trigger: (event: string, ...args: unknown[]) => void;
};

function makeMockSocket(id: string, apiKey = "test-api-key"): MockSocket {
  const handlers = new Map<string, SocketEventHandler>();
  const socket: MockSocket = {
    id,
    connected: true,
    data: {},
    handshake: {
      auth: { apiKey },
      headers: {},
    },
    conn: { transport: { name: "websocket" } },
    on: vi.fn((event: string, handler: SocketEventHandler) => {
      handlers.set(event, handler);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    _handlers: handlers,
    _trigger: (event: string, ...args: unknown[]) => {
      const handler = handlers.get(event);
      if (handler) {
        handler(...args);
      }
    },
  };
  return socket;
}

// ---------------------------------------------------------------------------
// Captured namespace handlers (populated by the mock below)
// ---------------------------------------------------------------------------

let capturedMiddleware: SocketMiddlewareFn | null = null;
let capturedConnectionHandler: ConnectionHandlerFn | null = null;

vi.mock("socket.io", () => {
  const mockNamespace = {
    use: vi.fn((fn: SocketMiddlewareFn) => {
      capturedMiddleware = fn;
    }),
    on: vi.fn((event: string, fn: ConnectionHandlerFn) => {
      if (event === "connection") {
        capturedConnectionHandler = fn;
      }
    }),
  };
  return {
    Server: class MockServer {
      of() {
        return mockNamespace;
      }

      close() {
        return Promise.resolve();
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Setup environment and import the module under test
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-internal-secret-ce";
const TEST_ORG_ID = "org-abc";
const TEST_USER_ID = "user-xyz";
const TEST_TARGET_ID = "target-001";

beforeEach(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = "20500";
  process.env.CLOSEDLOOP_API_URL = "http://127.0.0.1:19878";
  process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "60000";

  // Re-import forces handlers to be captured on each test run.
  // We use vi.resetModules so the module is freshly evaluated.
  vi.resetModules();
  capturedMiddleware = null;
  capturedConnectionHandler = null;
  await import("../index");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: run a socket through auth middleware successfully
// ---------------------------------------------------------------------------

async function authenticateSocket(socket: MockSocket): Promise<void> {
  if (!capturedMiddleware) {
    throw new Error("Middleware not captured — module may not have loaded");
  }

  // The middleware calls forwardSocketEvent("_relay.validate", { apiKey }) which
  // internally calls validateApiKeyViaApi, which calls fetch. Mock fetch to return
  // a successful validate response.
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    url: "http://127.0.0.1:19878/internal/api-keys/verify",
    text: () =>
      Promise.resolve(
        JSON.stringify({
          success: true,
          data: {
            organizationId: TEST_ORG_ID,
            userId: TEST_USER_ID,
            scopes: ["write"],
          },
        })
      ),
    headers: { get: () => "application/json" },
  } as unknown as Response);

  await new Promise<void>((resolve, reject) => {
    (capturedMiddleware as SocketMiddlewareFn)(socket, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Test: auth middleware sets socket.data.auth on success
// ---------------------------------------------------------------------------

describe("auth middleware", () => {
  it("sets socket.data.auth with organizationId and userId on successful auth", async () => {
    const socket = makeMockSocket("socket-auth-1");

    await authenticateSocket(socket);

    expect(socket.data.auth).toEqual({
      organizationId: TEST_ORG_ID,
      userId: TEST_USER_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// Test: connection handler registers event listeners on socket
// ---------------------------------------------------------------------------

describe("connection handler", () => {
  it("registers event listeners on the socket when connection handler is invoked", () => {
    if (!capturedConnectionHandler) {
      throw new Error(
        "Connection handler not captured — module may not have loaded"
      );
    }

    const socket = makeMockSocket("socket-conn-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    capturedConnectionHandler(socket);

    expect(socket.on).toHaveBeenCalled();
    const registeredEvents = (
      socket.on as ReturnType<typeof vi.fn>
    ).mock.calls.map((call: unknown[]) => call[0]);
    expect(registeredEvents).toContain("disconnect");
  });

  it("registers a worker after desktop.hello", async () => {
    if (!capturedConnectionHandler) {
      throw new Error(
        "Connection handler not captured — module may not have loaded"
      );
    }

    const socket = makeMockSocket("socket-hello-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    capturedConnectionHandler(socket);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://127.0.0.1:19878/internal/relay/socket-event",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            emit: [],
            targetId: TEST_TARGET_ID,
            gatewaySessionId: "gw-session-001",
          })
        ),
      headers: { get: () => "application/json" },
    } as unknown as Response);

    socket._trigger("desktop.hello", { targetId: TEST_TARGET_ID });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Verify the fetch was called for the hello event
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
