import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Types for captured namespace handlers
// ---------------------------------------------------------------------------

type NextFn = (err?: Error) => void;
type SocketMiddlewareFn = (socket: MockSocket, next: NextFn) => void;

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
};

function makeMockSocket(
  id: string,
  apiKey = "sk_live_supersecretkey12345"
): MockSocket {
  return {
    id,
    connected: true,
    data: {},
    handshake: {
      auth: { apiKey },
      headers: {},
    },
    conn: { transport: { name: "websocket" } },
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Captured namespace middleware (populated by mock below)
// ---------------------------------------------------------------------------

let capturedMiddleware: SocketMiddlewareFn | null = null;

vi.mock("socket.io", () => {
  const mockNamespace = {
    use: vi.fn((fn: SocketMiddlewareFn) => {
      capturedMiddleware = fn;
    }),
    on: vi.fn(),
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
// Mock @repo/observability/log — capture all log calls for assertion
// ---------------------------------------------------------------------------

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  ConnectionState: {
    Online: "online",
    Disconnected: "disconnected",
    Degraded: "degraded",
  },
  emitProtocolMetric: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Setup environment and import the module under test
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-internal-secret-logsec";
const RAW_API_KEY = "sk_live_supersecretkey12345";
// Common API key prefixes that should never appear in log output
const API_KEY_PREFIX_PATTERN = /sk_/i;

beforeEach(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = "20502";
  process.env.CLOSEDLOOP_API_URL = "http://127.0.0.1:19880";
  process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "60000";

  vi.resetModules();
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
  capturedMiddleware = null;

  await import("../index");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively serialize a log argument to a string for pattern matching.
 * This handles both string messages and object arguments.
 */
function serializeLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Collect all log calls across info/warn/error and return them as serialized strings.
 */
function collectAllLogOutput(): string[] {
  const allCalls = [
    ...mockLogInfo.mock.calls,
    ...mockLogWarn.mock.calls,
    ...mockLogError.mock.calls,
  ];
  return allCalls.flatMap((callArgs) =>
    (callArgs as unknown[]).map((arg) => serializeLogArg(arg))
  );
}

// ---------------------------------------------------------------------------
// T-6.3: Log security tests for auth validation
// ---------------------------------------------------------------------------

describe("T-6.3: auth validation log security — no key material or raw body in logs", () => {
  it("does not log API key prefix or raw key value on successful auth", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-1", RAW_API_KEY);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://127.0.0.1:19880/internal/api-keys/verify",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            data: {
              organizationId: "org-logsec",
              userId: "user-logsec",
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

    const allOutput = collectAllLogOutput();

    // No log argument should contain the raw API key value
    for (const output of allOutput) {
      expect(output).not.toContain(RAW_API_KEY);
    }

    // No log argument should contain API key prefix pattern (e.g. "sk_")
    for (const output of allOutput) {
      expect(API_KEY_PREFIX_PATTERN.test(output)).toBe(false);
    }
  });

  it("logs hasApiKey as a boolean (true) rather than the key value or a key prefix", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-2", RAW_API_KEY);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://127.0.0.1:19880/internal/api-keys/verify",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            data: {
              organizationId: "org-logsec2",
              userId: "user-logsec2",
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

    // Find the log.info call that includes "hasApiKey"
    const hasApiKeyInfoCall = mockLogInfo.mock.calls.find((callArgs) => {
      const serialized = (callArgs as unknown[])
        .map((a) => serializeLogArg(a))
        .join(" ");
      return serialized.includes("hasApiKey");
    });

    expect(hasApiKeyInfoCall).toBeDefined();

    // The object arg should have hasApiKey: true (boolean), not a string prefix
    const objArg = (hasApiKeyInfoCall as unknown[])[1];
    expect(typeof objArg).toBe("object");
    expect((objArg as Record<string, unknown>).hasApiKey).toBe(true);
    // Confirm no keyPrefix property is present
    expect((objArg as Record<string, unknown>).keyPrefix).toBeUndefined();
  });

  it("does not log rawBodyPreview or raw response body content on failed auth", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-3", RAW_API_KEY);
    const sensitiveResponseBody =
      '{"error":"invalid_key","detail":"sk_live_supersecretkey12345 rejected"}';

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      url: "http://127.0.0.1:19880/internal/api-keys/verify",
      text: () => Promise.resolve(sensitiveResponseBody),
      headers: { get: () => "application/json" },
    } as unknown as Response);

    await new Promise<void>((resolve) => {
      (capturedMiddleware as SocketMiddlewareFn)(socket, () => {
        resolve();
      });
    });

    const allOutput = collectAllLogOutput();

    // No log should contain the raw response body
    for (const output of allOutput) {
      expect(output).not.toContain(sensitiveResponseBody);
    }

    // No log should have a rawBodyPreview property
    for (const output of allOutput) {
      expect(output).not.toContain("rawBodyPreview");
    }

    // No log should contain raw body slices (partial content)
    for (const output of allOutput) {
      expect(output).not.toContain('"error":"invalid_key"');
    }
  });

  it("logs responseLength (number) instead of raw body content on failed auth", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-4", RAW_API_KEY);
    const errorBody = '{"success":false}';

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      url: "http://127.0.0.1:19880/internal/api-keys/verify",
      text: () => Promise.resolve(errorBody),
      headers: { get: () => "application/json" },
    } as unknown as Response);

    await new Promise<void>((resolve) => {
      (capturedMiddleware as SocketMiddlewareFn)(socket, () => {
        resolve();
      });
    });

    // Find the log.error call that should have responseLength
    const errorCallWithLength = mockLogError.mock.calls.find((callArgs) => {
      const serialized = (callArgs as unknown[])
        .map((a) => serializeLogArg(a))
        .join(" ");
      return serialized.includes("responseLength");
    });

    expect(errorCallWithLength).toBeDefined();

    // The object arg should have responseLength as a number
    const objArg = (errorCallWithLength as unknown[])[1];
    expect(typeof objArg).toBe("object");
    expect(typeof (objArg as Record<string, unknown>).responseLength).toBe(
      "number"
    );
    expect((objArg as Record<string, unknown>).responseLength).toBe(
      errorBody.length
    );

    // Confirm raw body is not present
    expect((objArg as Record<string, unknown>).rawBody).toBeUndefined();
    expect((objArg as Record<string, unknown>).rawBodyPreview).toBeUndefined();
    expect((objArg as Record<string, unknown>).response).toBeUndefined();
  });

  it("does not log API key material on auth rejection due to missing write scope", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-5", RAW_API_KEY);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://127.0.0.1:19880/internal/api-keys/verify",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            data: {
              organizationId: "org-logsec5",
              userId: "user-logsec5",
              scopes: ["read"], // no write scope
            },
          })
        ),
      headers: { get: () => "application/json" },
    } as unknown as Response);

    await new Promise<void>((resolve) => {
      (capturedMiddleware as SocketMiddlewareFn)(socket, () => {
        resolve();
      });
    });

    const allOutput = collectAllLogOutput();

    // No log argument should contain the raw API key
    for (const output of allOutput) {
      expect(output).not.toContain(RAW_API_KEY);
    }

    // No log argument should contain an API key prefix pattern
    for (const output of allOutput) {
      expect(API_KEY_PREFIX_PATTERN.test(output)).toBe(false);
    }
  });

  it("does not log API key material when fetch throws during auth", async () => {
    if (!capturedMiddleware) {
      throw new Error("Middleware not captured — module may not have loaded");
    }

    const socket = makeMockSocket("socket-logsec-6", RAW_API_KEY);

    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network timeout"));

    await new Promise<void>((resolve) => {
      (capturedMiddleware as SocketMiddlewareFn)(socket, () => {
        resolve();
      });
    });

    const allOutput = collectAllLogOutput();

    // No log argument should contain the raw API key
    for (const output of allOutput) {
      expect(output).not.toContain(RAW_API_KEY);
    }

    // No log argument should contain an API key prefix pattern
    for (const output of allOutput) {
      expect(API_KEY_PREFIX_PATTERN.test(output)).toBe(false);
    }
  });
});
