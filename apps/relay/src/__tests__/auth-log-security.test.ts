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
      // Engine.IO stub: index.ts attaches a `connection_error` listener to
      // `io.engine` at module load, so a Server double without one crashes on import.
      engine = { on: vi.fn() };
      of() {
        return mockNamespace;
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
 *
 * Errors are expanded by `expandErrors` first. Without that the scanner below
 * cannot see inside one at all, which is the shape the auth path actually logs
 * (`index.ts` puts the rejection under `error`, after `vercel-client.ts` has
 * scrubbed any credential out of its message and stack).
 */
function serializeLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg, expandErrors);
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

    // The rejection carries the key it was sent with, which is the shape a
    // transport failure can actually take here — this is the one client that
    // posts a raw `sk_live_` key. An innocuous "Network timeout" would let the
    // production catch hand a secret-bearing rejection straight to the logger
    // with nothing here to notice.
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error(`verify failed for ${RAW_API_KEY}`));

    await new Promise<void>((resolve) => {
      (capturedMiddleware as SocketMiddlewareFn)(socket, () => {
        resolve();
      });
    });

    const allOutput = collectAllLogOutput();

    // The rejection has to REACH the scanner for the two loops below to say
    // anything: a catch that stops passing it under `error`, or any change that
    // keeps it away from the serializer, leaves a suite proving only that no log
    // was written. The message survives scrubbed, so this pins both halves.
    expect(allOutput.join("\n")).toContain("verify failed for");

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

describe("the leak scanner itself", () => {
  it("sees a secret an Error carries, which the scanner used to be blind to", () => {
    // `message` and `stack` are non-enumerable, so a bare `JSON.stringify` of
    // `{ error }` collapses to `{"error":{}}` and every case above passes over
    // a key-bearing rejection without seeing it.
    expect(
      serializeLogArg({ error: new Error(`verify failed for ${RAW_API_KEY}`) })
    ).toContain(RAW_API_KEY);
  });
});

/**
 * `JSON.stringify` replacer that turns an Error into its own enumerable shape.
 * Applies at every depth, so an Error nested under a log payload's `error` key
 * is expanded too.
 */
function expandErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
