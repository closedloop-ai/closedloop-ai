/**
 * Tests for the socket auth middleware registered on the /desktop-gateway
 * namespace: API key extraction, validateApiKeyViaApi refusal ladder,
 * clerkUserId handling, forwardSocketEvent non-validate fallback paths,
 * isAllowedSocketOrigin, emitConnectionState gatewaySessionId coercion,
 * safeEmitConnectionStateCount non-Error throw, and getHeaderValue edge cases.
 *
 * Uses the same mock pattern as connection-events.test.ts (vi.resetModules +
 * dynamic import, createMockHttpServerFactory for node:http).  No real port
 * is bound — never call reserveTestPort here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Types mirroring what index.ts registers on the namespace
// ---------------------------------------------------------------------------

type NextFn = (err?: Error) => void;
type SocketMiddlewareFn = (socket: MockSocket, next: NextFn) => void;
type ConnectionHandlerFn = (socket: MockSocket) => void;
type SocketEventHandler = (...args: unknown[]) => void;
type CorsOriginCb = (err: Error | null, allow: boolean) => void;
type CorsOriginFn = (origin: string | undefined, cb: CorsOriginCb) => void;

// ---------------------------------------------------------------------------
// Captured handler references (populated by mocked namespace)
// ---------------------------------------------------------------------------

let capturedMiddleware: SocketMiddlewareFn | null = null;
let capturedConnectionHandler: ConnectionHandlerFn | null = null;
let capturedCorsOriginFn: CorsOriginFn | null = null;

// ---------------------------------------------------------------------------
// Mock socket type — headers allow string | string[] for array-header tests
// ---------------------------------------------------------------------------

type MockSocket = {
  id: string;
  connected: boolean;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string | string[]>;
  };
  conn: { transport: { name: string } };
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  _handlers: Map<string, SocketEventHandler>;
  _trigger: (event: string, ...args: unknown[]) => void;
};

function makeMockSocket(id: string): MockSocket {
  const handlers = new Map<string, SocketEventHandler>();
  const socket: MockSocket = {
    id,
    connected: true,
    data: {},
    handshake: { auth: {}, headers: {} },
    conn: { transport: { name: "websocket" } },
    on: vi.fn((event: string, handler: SocketEventHandler) => {
      handlers.set(event, handler);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    _handlers: handlers,
    _trigger: (event: string, ...args: unknown[]) => {
      const h = handlers.get(event);
      if (h) {
        h(...args);
      }
    },
  };
  return socket;
}

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockEmitProtocolMetric, mockLogWarn, mockFlushLogsWithDeadline } =
  vi.hoisted(() => ({
    mockEmitProtocolMetric: vi.fn(),
    mockLogWarn: vi.fn(),
    mockFlushLogsWithDeadline: vi.fn().mockResolvedValue(undefined),
  }));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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
      constructor(_server: unknown, options: { cors?: { origin?: unknown } }) {
        if (typeof options?.cors?.origin === "function") {
          capturedCorsOriginFn = options.cors.origin as CorsOriginFn;
        }
      }
      of(ns?: string) {
        if (ns === "/desktop-gateway") {
          return mockNamespace;
        }
        return { use() {}, on() {} };
      }
      close() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  return { createServer: vi.fn(createMockHttpServerFactory()) };
});

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/observability/telemetry/metrics")
    >();
  return { ...actual, emitProtocolMetric: mockEmitProtocolMetric };
});

vi.mock("@repo/observability/log", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/observability/log")>();
  return {
    ...actual,
    log: { ...(actual.log as object), warn: mockLogWarn },
  };
});

vi.mock("@repo/observability/shutdown", () => ({
  flushLogsWithDeadline: mockFlushLogsWithDeadline,
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-sam";
const TEST_API_URL = "http://127.0.0.1:19879";
const TEST_ORG_ID = "org-sam-1";
const TEST_USER_ID = "user-sam-1";
const TEST_TARGET_ID = "target-sam-1";
const TEST_GW_SESSION = "gw-sam-001";

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = "20501";
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "60000";

  vi.resetModules();
  mockEmitProtocolMetric.mockReset();
  mockLogWarn.mockReset();
  mockFlushLogsWithDeadline.mockReset().mockResolvedValue(undefined);
  capturedMiddleware = null;
  capturedConnectionHandler = null;
  capturedCorsOriginFn = null;

  await import("../index");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // vi.restoreAllMocks() does not undo a direct `globalThis.fetch = ...`
  // assignment, so the real fetch is put back explicitly.
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessAuthResponse(
  overrides: { success?: boolean; data?: unknown; clerkUserId?: string } = {}
): Response {
  const dataPayload =
    overrides.data === undefined
      ? {
          organizationId: TEST_ORG_ID,
          userId: TEST_USER_ID,
          scopes: ["write"],
          ...(overrides.clerkUserId === undefined
            ? {}
            : { clerkUserId: overrides.clerkUserId }),
        }
      : overrides.data;
  return {
    ok: true,
    status: 200,
    url: `${TEST_API_URL}/internal/api-keys/verify`,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          success: overrides.success ?? true,
          data: dataPayload,
        })
      ),
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

/**
 * The verification call the middleware actually made. Asserting on the
 * forwarded `key` — rather than on "fetch was called" — is what proves the
 * extraction picked the right handshake field and did not mangle the token.
 */
function verifyCallFromFetch(): { url: string; key: unknown } {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const [url, init] = mock.mock.calls[0] as [string, { body: string }];
  return { url, key: (JSON.parse(init.body) as { key: unknown }).key };
}

function runMiddleware(socket: MockSocket): Promise<Error | undefined> {
  if (!capturedMiddleware) {
    throw new Error("Middleware not captured");
  }
  return new Promise<Error | undefined>((resolve) => {
    (capturedMiddleware as SocketMiddlewareFn)(socket, (err) => resolve(err));
  });
}

// ---------------------------------------------------------------------------
// 1. API key extraction
// ---------------------------------------------------------------------------

describe("socket auth middleware — API key extraction", () => {
  it("uses auth.token as the API key when present", async () => {
    const socket = makeMockSocket("sock-token-1");
    socket.handshake.auth.token = "sk_token_abc";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(verifyCallFromFetch().key).toBe("sk_token_abc");
  });

  it("verifies the key against the api-keys verify endpoint", async () => {
    const socket = makeMockSocket("sock-verify-url");
    socket.handshake.auth.token = "sk_token_url";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    await runMiddleware(socket);

    expect(verifyCallFromFetch().url).toBe(
      `${TEST_API_URL}/internal/api-keys/verify`
    );
  });

  it("uses auth.apiKey as the API key when token is absent", async () => {
    const socket = makeMockSocket("sock-apikey-1");
    socket.handshake.auth.apiKey = "sk_apikey_abc";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(verifyCallFromFetch().key).toBe("sk_apikey_abc");
  });

  it("prefers auth.token over auth.apiKey when both are present", async () => {
    const socket = makeMockSocket("sock-precedence-1");
    socket.handshake.auth.token = "sk_token_wins";
    socket.handshake.auth.apiKey = "sk_apikey_loses";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect(verifyCallFromFetch().key).toBe("sk_token_wins");
  });

  it("extracts key from Authorization: Bearer header when auth fields are absent", async () => {
    const socket = makeMockSocket("sock-bearer-1");
    socket.handshake.headers.authorization = "Bearer sk_bearer_abc";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    // Proves the "Bearer " prefix is stripped, not forwarded verbatim.
    expect(verifyCallFromFetch().key).toBe("sk_bearer_abc");
  });

  it("prefers an auth field over the Authorization header when both are present", async () => {
    const socket = makeMockSocket("sock-precedence-2");
    socket.handshake.auth.token = "sk_auth_wins";
    socket.handshake.headers.authorization = "Bearer sk_header_loses";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect(verifyCallFromFetch().key).toBe("sk_auth_wins");
  });

  it("calls next(Unauthorized) when Authorization header is not Bearer-prefixed", async () => {
    const socket = makeMockSocket("sock-basic-1");
    socket.handshake.headers.authorization = "Basic sk_basic_abc";
    globalThis.fetch = vi.fn();

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
    // Key extraction failed — API was never contacted
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("calls next(Unauthorized) when no API key exists in any field", async () => {
    const socket = makeMockSocket("sock-nokey-1");
    // No auth.token, auth.apiKey, or authorization header
    globalThis.fetch = vi.fn();

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. validateApiKeyViaApi refusal ladder
// ---------------------------------------------------------------------------

describe("socket auth middleware — validateApiKeyViaApi refusal ladder", () => {
  it("rejects when success=false with an object payload (covers object payloadKeys ternary arm)", async () => {
    const socket = makeMockSocket("sock-fail-success-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeSuccessAuthResponse({
        success: false,
        data: {
          organizationId: TEST_ORG_ID,
          userId: TEST_USER_ID,
          scopes: ["write"],
        },
      })
    );

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });

  it("rejects when data.data is null (covers non-object payloadKeys ternary arm)", async () => {
    const socket = makeMockSocket("sock-null-data-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessAuthResponse({ data: null }));

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });

  it("rejects when data.data is missing organizationId", async () => {
    const socket = makeMockSocket("sock-no-orgid-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeSuccessAuthResponse({
        data: { userId: TEST_USER_ID, scopes: ["write"] },
      })
    );

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });

  it("rejects when data.data is missing userId", async () => {
    const socket = makeMockSocket("sock-no-userid-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeSuccessAuthResponse({
        data: { organizationId: TEST_ORG_ID, scopes: ["write"] },
      })
    );

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });

  it("rejects when scopes is not an array", async () => {
    const socket = makeMockSocket("sock-scopes-notarray-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeSuccessAuthResponse({
        data: {
          organizationId: TEST_ORG_ID,
          userId: TEST_USER_ID,
          scopes: "write",
        },
      })
    );

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });

  it("rejects when scopes array does not contain 'write'", async () => {
    const socket = makeMockSocket("sock-scopes-nowrite-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeSuccessAuthResponse({
        data: {
          organizationId: TEST_ORG_ID,
          userId: TEST_USER_ID,
          scopes: ["read"],
        },
      })
    );

    const err = await runMiddleware(socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// 3. clerkUserId handling
// ---------------------------------------------------------------------------

describe("socket auth middleware — clerkUserId handling", () => {
  it("includes clerkUserId in socket.data.auth when the API response provides it", async () => {
    const socket = makeMockSocket("sock-clerk-present-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeSuccessAuthResponse({ clerkUserId: "user_clerk_xyz" })
      );

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    expect((socket.data.auth as Record<string, unknown>).clerkUserId).toBe(
      "user_clerk_xyz"
    );
  });

  it("does NOT include clerkUserId in socket.data.auth when absent from API response", async () => {
    const socket = makeMockSocket("sock-clerk-absent-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    const err = await runMiddleware(socket);

    expect(err).toBeUndefined();
    // Property must not exist — not merely undefined
    expect("clerkUserId" in (socket.data.auth as Record<string, unknown>)).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// 4. forwardSocketEvent — non-validate fallback paths (via desktop.hello)
// ---------------------------------------------------------------------------

describe("forwardSocketEvent — non-validate fallback", () => {
  it("returns emit=[] on non-2xx response so no events are forwarded", async () => {
    vi.useFakeTimers();
    const socket = makeMockSocket("sock-fwd-nok-1");
    socket.handshake.auth.apiKey = "sk_test";

    globalThis.fetch = vi
      .fn()
      // Auth validation → success
      .mockResolvedValueOnce(makeSuccessAuthResponse())
      // desktop.hello → non-2xx
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        url: `${TEST_API_URL}/internal/relay/socket-event`,
        text: () => Promise.resolve(JSON.stringify({ error: "bad" })),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    const authErr = await runMiddleware(socket);
    expect(authErr).toBeUndefined();

    capturedConnectionHandler!(socket);
    socket._trigger("desktop.hello", { targetId: TEST_TARGET_ID });
    await vi.advanceTimersByTimeAsync(0);

    // result.emit is [] — no events forwarded to socket
    expect(socket.emit).not.toHaveBeenCalled();
    // result.disconnect is undefined (falsy) — socket not disconnected
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("returns emit=[] when data.emit is not an array so no events are forwarded", async () => {
    vi.useFakeTimers();
    const socket = makeMockSocket("sock-fwd-emit-noarray-1");
    socket.handshake.auth.apiKey = "sk_test";

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: `${TEST_API_URL}/internal/relay/socket-event`,
        text: () =>
          Promise.resolve(
            JSON.stringify({ success: true, emit: "not-an-array" })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    const authErr = await runMiddleware(socket);
    expect(authErr).toBeUndefined();

    capturedConnectionHandler!(socket);
    socket._trigger("desktop.hello", { targetId: TEST_TARGET_ID });
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. isAllowedSocketOrigin (via captured cors.origin callback)
// ---------------------------------------------------------------------------

describe("isAllowedSocketOrigin — cors origin callback", () => {
  it("allows connections with no Origin header (Node.js desktop client)", () => {
    expect(capturedCorsOriginFn).not.toBeNull();
    const cb = vi.fn();
    capturedCorsOriginFn!(undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it("allows a localhost origin in non-production (local tooling)", () => {
    expect(capturedCorsOriginFn).not.toBeNull();
    const cb = vi.fn();
    capturedCorsOriginFn!("http://localhost:3000", cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it("rejects arbitrary browser origins", () => {
    expect(capturedCorsOriginFn).not.toBeNull();
    const cb = vi.fn();
    capturedCorsOriginFn!("https://evil.example.com", cb);
    expect(cb).toHaveBeenCalledWith(null, false);
  });
});

// ---------------------------------------------------------------------------
// 6. emitConnectionState — gatewaySessionId ?? undefined coercion
// ---------------------------------------------------------------------------

describe("emitConnectionState — gatewaySessionId coercion", () => {
  it("emits metric with gatewaySessionId=undefined (not null) when session id is absent from hello response", async () => {
    vi.useFakeTimers();
    const socket = makeMockSocket("sock-gw-absent-1");
    socket.handshake.auth.apiKey = "sk_test";

    // Hello response contains targetId but NO gatewaySessionId field
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: `${TEST_API_URL}/internal/relay/socket-event`,
        text: () =>
          Promise.resolve(
            JSON.stringify({ emit: [], targetId: TEST_TARGET_ID })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    const authErr = await runMiddleware(socket);
    expect(authErr).toBeUndefined();
    capturedConnectionHandler!(socket);
    socket._trigger("desktop.hello", { targetId: TEST_TARGET_ID });
    await vi.advanceTimersByTimeAsync(0);

    const stateCountCalls = mockEmitProtocolMetric.mock.calls.filter(
      (call) =>
        (call[0] as { metric: string }).metric === "connection_state_count"
    );
    expect(stateCountCalls.length).toBeGreaterThanOrEqual(1);
    // gatewaySessionId ?? undefined fires the ?? branch — value must not be null
    for (const call of stateCountCalls) {
      expect(
        (call[0] as { gatewaySessionId?: unknown }).gatewaySessionId
      ).not.toBe(null);
      expect(
        (call[0] as { gatewaySessionId?: unknown }).gatewaySessionId
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. safeEmitConnectionStateCount — non-Error exception swallowed
// ---------------------------------------------------------------------------

describe("safeEmitConnectionStateCount — non-Error exception handling", () => {
  it("swallows a thrown non-Error value and logs via String(error) not error.message", async () => {
    vi.useFakeTimers();
    // Throw a plain string to exercise the `String(error)` ternary arm
    mockEmitProtocolMetric.mockImplementation((metric: { metric: string }) => {
      if (metric.metric === "connection_state_count") {
        // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw to exercise String(error) ternary arm
        throw "non-error-sentinel-string";
      }
    });

    const socket = makeMockSocket("sock-nonErr-1");
    socket.handshake.auth.apiKey = "sk_test";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: `${TEST_API_URL}/internal/relay/socket-event`,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              emit: [],
              targetId: TEST_TARGET_ID,
              gatewaySessionId: TEST_GW_SESSION,
            })
          ),
        headers: { get: () => "application/json" },
      } as unknown as Response);

    const authErr = await runMiddleware(socket);
    expect(authErr).toBeUndefined();
    capturedConnectionHandler!(socket);

    mockLogWarn.mockClear();
    let threw = false;
    try {
      socket._trigger("desktop.hello", { targetId: TEST_TARGET_ID });
      await vi.advanceTimersByTimeAsync(0);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "ConnectionStateCountEmitFailed",
      expect.objectContaining({ error: "non-error-sentinel-string" })
    );
  });
});

// ---------------------------------------------------------------------------
// 8. getHeaderValue — array and whitespace extraction
// ---------------------------------------------------------------------------

describe("getHeaderValue — header value edge cases", () => {
  it("takes the first element when a desktop PoP header has an array value", async () => {
    const socket = makeMockSocket("sock-header-array-1");
    socket.handshake.auth.apiKey = "sk_test";
    // x-desktop-gateway-id is a recognized PoP header name (lowercase variant)
    socket.handshake.headers["x-desktop-gateway-id"] = [
      "first-gateway-id",
      "should-be-ignored",
    ];
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    await runMiddleware(socket);

    const fetchCall = (
      globalThis.fetch as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0];
    const reqHeaders = fetchCall[1].headers as Record<string, string>;
    // getHeaderValue takes headerValue[0] for array inputs
    expect(reqHeaders["X-Desktop-Gateway-Id"]).toBe("first-gateway-id");
  });

  it("omits a header entirely when its value is whitespace-only", async () => {
    const socket = makeMockSocket("sock-header-whitespace-1");
    socket.handshake.auth.apiKey = "sk_test";
    // Whitespace-only string → getHeaderValue returns undefined → not included
    socket.handshake.headers["x-desktop-gateway-id"] = "   ";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeSuccessAuthResponse());

    await runMiddleware(socket);

    const fetchCall = (
      globalThis.fetch as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0];
    const reqHeaders = fetchCall[1].headers as Record<string, string>;
    expect(reqHeaders["X-Desktop-Gateway-Id"]).toBeUndefined();
  });
});
