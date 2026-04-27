import { ConnectionState } from "@repo/observability/telemetry/metrics";
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

// Mock node:http's createServer so startRelayServer() does not bind a real
// HTTP listener to RELAY_PORT (20500) — the T-3.11 SIGTERM test must reload
// the module with NODE_ENV="development" to register the SIGTERM handler,
// which otherwise leaks a port-bound server across test runs (EADDRINUSE).
vi.mock("node:http", () => {
  type Listener = (...args: unknown[]) => void;
  return {
    createServer: vi.fn(() => {
      const listeners = new Map<string, Set<Listener>>();
      const addListener = (evt: string, fn: Listener) => {
        let set = listeners.get(evt);
        if (!set) {
          set = new Set();
          listeners.set(evt, set);
        }
        set.add(fn);
      };
      const mockServer = {
        listening: false,
        listen: vi.fn(function listen() {
          mockServer.listening = true;
          // Emit "listening" on next tick so the Promise in startRelayServer resolves.
          queueMicrotask(() => {
            for (const fn of listeners.get("listening") ?? []) {
              fn();
            }
          });
          return mockServer;
        }),
        close: vi.fn((cb?: () => void) => {
          mockServer.listening = false;
          cb?.();
          return mockServer;
        }),
        on: vi.fn((evt: string, fn: Listener) => {
          addListener(evt, fn);
          return mockServer;
        }),
        once: vi.fn((evt: string, fn: Listener) => {
          const wrapper: Listener = (...args) => {
            listeners.get(evt)?.delete(wrapper);
            fn(...args);
          };
          addListener(evt, wrapper);
          return mockServer;
        }),
        off: vi.fn((evt: string, fn: Listener) => {
          listeners.get(evt)?.delete(fn);
          return mockServer;
        }),
      };
      return mockServer;
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock emitProtocolMetric so we can assert on connection state emissions
// ---------------------------------------------------------------------------

const { mockEmitProtocolMetric, mockLogFlush, mockLogWarn } = vi.hoisted(
  () => ({
    mockEmitProtocolMetric: vi.fn(),
    mockLogFlush: vi.fn().mockResolvedValue(undefined),
    mockLogWarn: vi.fn(),
  })
);

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/observability/telemetry/metrics")
    >();
  return {
    ...actual,
    emitProtocolMetric: mockEmitProtocolMetric,
  };
});

// ---------------------------------------------------------------------------
// Mock @repo/observability/log so log.flush can be spied on across reloads
// ---------------------------------------------------------------------------

vi.mock("@repo/observability/log", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/observability/log")>();
  return {
    ...actual,
    log: {
      ...(actual.log as object),
      flush: mockLogFlush,
      warn: mockLogWarn,
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
  mockEmitProtocolMetric.mockReset();
  mockLogFlush.mockReset().mockResolvedValue(undefined);
  mockLogWarn.mockReset();
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
// Helper: register a worker via desktop.hello flow
// Returns the gatewaySessionId captured from the hello response.
// ---------------------------------------------------------------------------

async function registerWorkerViaHello(
  socket: MockSocket,
  targetId: string,
  gatewaySessionId = "gw-session-001"
): Promise<string> {
  if (!capturedConnectionHandler) {
    throw new Error(
      "Connection handler not captured — module may not have loaded"
    );
  }

  capturedConnectionHandler(socket);

  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    url: "http://127.0.0.1:19878/internal/relay/socket-event",
    text: () =>
      Promise.resolve(
        JSON.stringify({
          emit: [],
          targetId,
          gatewaySessionId,
        })
      ),
    headers: { get: () => "application/json" },
  } as unknown as Response);

  socket._trigger("desktop.hello", { targetId });

  // Wait for async hello processing to complete
  await vi.advanceTimersByTimeAsync(0);

  return gatewaySessionId;
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

  it("forwards desktop PoP handshake headers unchanged to API validation", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-auth-pop");
    socket.handshake.headers = {
      "x-desktop-gateway-id": "gateway-123",
      "x-desktop-timestamp": "1800000000",
      "x-desktop-signature": "signature_base64url",
    };
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

    const fetchCall = (
      globalThis.fetch as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers["X-Desktop-Gateway-Id"]).toBe("gateway-123");
    expect(headers["X-Desktop-Timestamp"]).toBe("1800000000");
    expect(headers["X-Desktop-Signature"]).toBe("signature_base64url");
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

// ---------------------------------------------------------------------------
// T-3.4: first registration emits online
// ---------------------------------------------------------------------------

describe("T-3.4: first registration emits online", () => {
  it("emits connection_state_count with state online when a worker registers for the first time", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t34-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    await registerWorkerViaHello(socket, "ct_first_reg");

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    expect(stateCountCalls).toHaveLength(1);
    expect(stateCountCalls[0][0]).toMatchObject({
      metric: "connection_state_count",
      state: ConnectionState.Online,
      count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// T-3.5: takeover emits disconnected + online pair
// ---------------------------------------------------------------------------

describe("T-3.5: takeover emits disconnected + online pair", () => {
  it("emits online for socket-1, then disconnected for socket-1, then online for socket-2", async () => {
    vi.useFakeTimers();

    const socket1 = makeMockSocket("socket-t35-1");
    socket1.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    // Register socket-1
    const gwSession1 = await registerWorkerViaHello(
      socket1,
      "ct_takeover",
      "gw-session-t35-1"
    );

    const socket2 = makeMockSocket("socket-t35-2");
    socket2.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    // Register socket-2 for same targetId — triggers takeover
    await registerWorkerViaHello(socket2, "ct_takeover", "gw-session-t35-2");

    // Get all connection_state_count calls in order
    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    // Should have: online (socket-1), disconnected (socket-1 displaced), online (socket-2)
    expect(stateCountCalls).toHaveLength(3);
    expect(stateCountCalls[0][0]).toMatchObject({
      metric: "connection_state_count",
      state: ConnectionState.Online,
      count: 1,
    });
    expect(stateCountCalls[1][0]).toMatchObject({
      metric: "connection_state_count",
      state: ConnectionState.Disconnected,
      count: 1,
      gatewaySessionId: gwSession1,
    });
    expect(stateCountCalls[2][0]).toMatchObject({
      metric: "connection_state_count",
      state: ConnectionState.Online,
      count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// T-3.6: degraded fires after timer
// ---------------------------------------------------------------------------

describe("T-3.6: degraded fires after timer", () => {
  it("emits degraded after heartbeat fails and degraded threshold elapses", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t36-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    // Register worker — hello response to get the worker registered
    if (!capturedConnectionHandler) {
      throw new Error("Connection handler not captured");
    }
    capturedConnectionHandler(socket);

    // Mock fetch: hello succeeds, then heartbeat fails
    globalThis.fetch = vi
      .fn()
      // First call: desktop.hello
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "http://127.0.0.1:19878/internal/relay/socket-event",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              emit: [],
              targetId: "ct_degraded",
              gatewaySessionId: "gw-session-t36",
            })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response)
      // Subsequent calls: heartbeat fails
      .mockRejectedValue(new Error("Heartbeat network error"));

    socket._trigger("desktop.hello", { targetId: "ct_degraded" });

    // Let hello async processing run
    await vi.advanceTimersByTimeAsync(0);

    // Advance past heartbeat interval (30000ms) — heartbeat fires and fails
    // Then advance past degraded threshold (60000ms) — degraded timer fires
    await vi.advanceTimersByTimeAsync(90_000);

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    const degradedCalls = stateCountCalls.filter(
      (call) =>
        (call[0] as { state: string }).state === ConnectionState.Degraded
    );

    expect(degradedCalls).toHaveLength(1);
    expect(degradedCalls[0][0]).toMatchObject({
      metric: "connection_state_count",
      state: ConnectionState.Degraded,
      count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// T-3.7: online recovery from degraded
// ---------------------------------------------------------------------------

describe("T-3.7: online recovery from degraded", () => {
  it("emits online, then degraded, then online recovery", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t37-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    if (!capturedConnectionHandler) {
      throw new Error("Connection handler not captured");
    }
    capturedConnectionHandler(socket);

    const heartbeatSuccessResponse = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "http://127.0.0.1:19878/internal/relay/socket-event",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              emit: [],
              targetId: "ct_recovery",
              gatewaySessionId: "gw-session-t37",
            })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    // hello succeeds, first heartbeat fails (to trigger degraded), second heartbeat succeeds (recovery)
    globalThis.fetch = vi
      .fn()
      // First call: desktop.hello
      .mockImplementationOnce(heartbeatSuccessResponse)
      // Second call: heartbeat at 30000ms — fails → schedules degraded timer (fires at 30000+60000=90000)
      .mockRejectedValueOnce(new Error("Heartbeat fail 1"))
      // Third call: heartbeat at 60000ms — also fails
      .mockRejectedValueOnce(new Error("Heartbeat fail 2"))
      // Fourth call: heartbeat at 90000ms — also fails (degraded fires this tick)
      .mockRejectedValueOnce(new Error("Heartbeat fail 3"))
      // Fifth call: heartbeat at 120000ms — succeeds, triggers recovery (wasDegraded=true by now)
      .mockImplementation(heartbeatSuccessResponse);

    socket._trigger("desktop.hello", { targetId: "ct_recovery" });
    await vi.advanceTimersByTimeAsync(0);

    // Advance 30000ms — first heartbeat fires and fails, schedules degraded timer (fires at t=90000)
    await vi.advanceTimersByTimeAsync(30_000);

    // Advance another 30000ms — second heartbeat fires and fails (t=60000)
    await vi.advanceTimersByTimeAsync(30_000);

    // Advance another 30000ms — both degrade timer AND third heartbeat fire at t=90000.
    // The interval fires first (created before setTimeout), its .then() runs (fails),
    // then the degraded timeout fires (sets wasDegraded=true, emits degraded).
    await vi.advanceTimersByTimeAsync(30_000);

    // Advance 30000ms — fourth heartbeat fires at t=120000 and succeeds (recovery)
    await vi.advanceTimersByTimeAsync(30_000);

    // Flush any remaining microtasks
    await vi.advanceTimersByTimeAsync(0);

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    const onlineCalls = stateCountCalls.filter(
      (call) => (call[0] as { state: string }).state === ConnectionState.Online
    );
    const degradedCalls = stateCountCalls.filter(
      (call) =>
        (call[0] as { state: string }).state === ConnectionState.Degraded
    );

    expect(onlineCalls).toHaveLength(2);
    expect(degradedCalls).toHaveLength(1);

    // Verify call order: online, degraded, online
    const allStateCalls = stateCountCalls.map(
      (call) => (call[0] as { state: string }).state
    );
    expect(allStateCalls).toEqual([
      ConnectionState.Online,
      ConnectionState.Degraded,
      ConnectionState.Online,
    ]);
  });
});

// ---------------------------------------------------------------------------
// T-3.8: no recovery online when wasDegraded was never set
// ---------------------------------------------------------------------------

describe("T-3.8: no recovery online when wasDegraded was never set", () => {
  it("does not emit a second online when heartbeat failure is below degraded threshold", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t38-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    if (!capturedConnectionHandler) {
      throw new Error("Connection handler not captured");
    }
    capturedConnectionHandler(socket);

    const heartbeatSuccessResponse = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "http://127.0.0.1:19878/internal/relay/socket-event",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              emit: [],
              targetId: "ct_no_recovery",
              gatewaySessionId: "gw-session-t38",
            })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    globalThis.fetch = vi
      .fn()
      // First call: desktop.hello
      .mockImplementationOnce(heartbeatSuccessResponse)
      // Second call: heartbeat at 30000ms — fails (but below 60000ms threshold)
      .mockRejectedValueOnce(new Error("Short heartbeat fail"))
      // Third call: heartbeat at 60000ms — succeeds, but wasDegraded = false
      .mockImplementation(heartbeatSuccessResponse);

    socket._trigger("desktop.hello", { targetId: "ct_no_recovery" });
    await vi.advanceTimersByTimeAsync(0);

    // Advance 30000ms — heartbeat fires and fails, degraded timer scheduled
    await vi.advanceTimersByTimeAsync(30_000);

    // Advance only 10000ms — degraded timer (at 60000ms) has NOT fired yet
    await vi.advanceTimersByTimeAsync(10_000);

    // Next heartbeat at 60000ms from start fires — succeeds, clears degraded timer
    // (wasDegraded is still false, so no recovery online emitted)
    await vi.advanceTimersByTimeAsync(20_000);

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    const onlineCalls = stateCountCalls.filter(
      (call) => (call[0] as { state: string }).state === ConnectionState.Online
    );

    // Only the initial registration online should have been emitted
    expect(onlineCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-3.9: disconnected on socket close
// ---------------------------------------------------------------------------

describe("T-3.9: disconnected on socket close", () => {
  it("(a) online → disconnected: emits exactly one disconnected when socket closes", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t39a-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    await registerWorkerViaHello(socket, "ct_disc_online");

    // Reset metric calls after registration
    mockEmitProtocolMetric.mockClear();

    // Trigger disconnect
    socket._trigger("disconnect", "transport close");

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    const disconnectedCalls = stateCountCalls.filter(
      (call) =>
        (call[0] as { state: string }).state === ConnectionState.Disconnected
    );

    expect(disconnectedCalls).toHaveLength(1);
  });

  it("(b) degraded → disconnected: emits exactly one disconnected when degraded socket closes", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t39b-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    if (!capturedConnectionHandler) {
      throw new Error("Connection handler not captured");
    }
    capturedConnectionHandler(socket);

    globalThis.fetch = vi
      .fn()
      // First call: desktop.hello
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: "http://127.0.0.1:19878/internal/relay/socket-event",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              emit: [],
              targetId: "ct_disc_degraded",
              gatewaySessionId: "gw-session-t39b",
            })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response)
      // All heartbeats fail
      .mockRejectedValue(new Error("Heartbeat fail"));

    socket._trigger("desktop.hello", { targetId: "ct_disc_degraded" });
    await vi.advanceTimersByTimeAsync(0);

    // Advance to trigger degraded state
    await vi.advanceTimersByTimeAsync(90_000);

    // Clear calls — now track from degraded state
    mockEmitProtocolMetric.mockClear();

    // Trigger disconnect
    socket._trigger("disconnect", "transport close");

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );

    const disconnectedCalls = stateCountCalls.filter(
      (call) =>
        (call[0] as { state: string }).state === ConnectionState.Disconnected
    );

    expect(disconnectedCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-3.10: reliability — emitter throws → handler doesn't reject
// ---------------------------------------------------------------------------

describe("T-3.10: reliability — emitter throws → handler doesn't reject", () => {
  it("handler completes without rejection when emitProtocolMetric throws", async () => {
    vi.useFakeTimers();

    // Override emitProtocolMetric to throw on connection_state_count calls
    mockEmitProtocolMetric.mockImplementation((metric: { metric: string }) => {
      if (metric.metric === "connection_state_count") {
        throw new Error("Metric emission failed");
      }
    });

    // Reset log.warn mock to track calls from this point
    mockLogWarn.mockClear();

    const socket = makeMockSocket("socket-t310-1");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    if (!capturedConnectionHandler) {
      throw new Error("Connection handler not captured");
    }
    capturedConnectionHandler(socket);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://127.0.0.1:19878/internal/relay/socket-event",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            emit: [],
            targetId: "ct_emitter_throws",
            gatewaySessionId: "gw-session-t310",
          })
        ),
      headers: { get: () => "application/json" },
    } as unknown as Response);

    // This should not throw even though emitProtocolMetric throws
    let threw = false;
    try {
      socket._trigger("desktop.hello", { targetId: "ct_emitter_throws" });
      await vi.advanceTimersByTimeAsync(0);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    // Verify log.warn was called with ConnectionStateCountEmitFailed
    expect(mockLogWarn).toHaveBeenCalledWith(
      "ConnectionStateCountEmitFailed",
      expect.objectContaining({
        state: ConnectionState.Online,
      })
    );
  });

  it("disconnect handler completes without rejection when emitProtocolMetric throws", async () => {
    vi.useFakeTimers();

    const socket = makeMockSocket("socket-t310-2");
    socket.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };

    // Register worker with normal metric emission first
    await registerWorkerViaHello(socket, "ct_emitter_throws_disc");

    // Now make emitProtocolMetric throw on connection_state_count
    mockEmitProtocolMetric.mockImplementation((metric: { metric: string }) => {
      if (metric.metric === "connection_state_count") {
        throw new Error("Metric emission failed on disconnect");
      }
    });

    mockLogWarn.mockClear();

    let threw = false;
    try {
      socket._trigger("disconnect", "transport close");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    expect(mockLogWarn).toHaveBeenCalledWith(
      "ConnectionStateCountEmitFailed",
      expect.objectContaining({
        state: ConnectionState.Disconnected,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// T-3.11: SIGTERM shutdown sweep
// ---------------------------------------------------------------------------

describe("T-3.11: SIGTERM shutdown sweep", () => {
  it("emits disconnected for all workers, flushes log, and exits on SIGTERM", async () => {
    vi.useFakeTimers();

    // handleShutdown is only registered when NODE_ENV !== "test".
    // beforeEach loaded the module with NODE_ENV="test" so the SIGTERM listener
    // was NOT registered there. Reload the module with NODE_ENV="development"
    // so the listener is installed, then register workers and emit SIGTERM.

    // Mock process.exit to prevent actual process termination
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    vi.resetModules();
    mockEmitProtocolMetric.mockReset();
    capturedMiddleware = null;
    capturedConnectionHandler = null;

    vi.stubEnv("NODE_ENV", "development");

    // Bind a reference so the finally block can stop the freshly-loaded
    // server even if the assertions throw.
    let freshModule: typeof import("../index") | undefined;

    try {
      freshModule = await import("../index");

      // Register two workers in the freshly-loaded module
      const s1 = makeMockSocket("socket-t311-s1");
      s1.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };
      await registerWorkerViaHello(s1, "ct_sigterm_fresh_1", "gw-sf311-1");

      const s2 = makeMockSocket("socket-t311-s2");
      s2.data.auth = { organizationId: TEST_ORG_ID, userId: TEST_USER_ID };
      await registerWorkerViaHello(s2, "ct_sigterm_fresh_2", "gw-sf311-2");

      // Clear metric calls after registration
      mockEmitProtocolMetric.mockClear();
      mockLogFlush.mockClear();

      // Verify SIGTERM listener was registered
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);

      // Emit SIGTERM — triggers handleShutdown
      process.emit("SIGTERM");

      // Let async shutdown logic run — advance past the 5000ms flush deadline
      await vi.advanceTimersByTimeAsync(5100);

      // Assert disconnected emitted for both workers
      const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
        (call) =>
          (call[0] as { metric: string }).metric === "connection_state_count"
      );
      const disconnectedCalls = stateCountCalls.filter(
        (call) =>
          (call[0] as { state: string }).state === ConnectionState.Disconnected
      );

      expect(disconnectedCalls.length).toBeGreaterThanOrEqual(2);

      // Assert log.flush called
      expect(mockLogFlush).toHaveBeenCalled();

      // Assert process.exit(0) called
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      // Stop the real HTTP server bound by startRelayServer() in the freshly
      // loaded module. Without this, the server remains bound to RELAY_PORT
      // across subsequent tests, leaking a listener and causing EADDRINUSE
      // on re-runs. socket.io's Server is mocked, but the underlying
      // node:http server is real.
      if (freshModule?.stopRelayServer) {
        try {
          // Restore real timers so stopRelayServer's internal promises can resolve.
          vi.useRealTimers();
          await freshModule.stopRelayServer();
        } catch {
          // best-effort cleanup; do not mask the test's primary failure
        }
      }
      vi.unstubAllEnvs();
      // Remove SIGTERM and SIGINT listeners to avoid leaks
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
    }
  });
});
