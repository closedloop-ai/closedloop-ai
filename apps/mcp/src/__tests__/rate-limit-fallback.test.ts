import type { IncomingMessage } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client.js", () => ({
  verifyApiKey: vi.fn(),
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(fn: (db: Record<string, never>) => Promise<T> | T): Promise<T> =>
      fn({}),
    {
      tx: async <T>(
        fn: (db: Record<string, never>) => Promise<T>
      ): Promise<T> => fn({}),
    }
  );
  return { withDb };
});

function createMockRequest(remoteAddress = "10.0.0.1"): IncomingMessage {
  return {
    method: "POST",
    url: "/oauth/authorize",
    headers: {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

let consumeInMemoryRateLimit: (
  req: IncomingMessage,
  bucket: "authorize" | "token"
) => { limited: boolean; retryAfterSeconds: number };
let inMemoryRateLimits: Map<string, { count: number; windowStartMs: number }>;
let resetInMemorySecurityState: () => void;

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  process.env.MCP_OAUTH_RATE_LIMIT_AUTHORIZE_MAX = "3";
  process.env.MCP_OAUTH_RATE_LIMIT_TOKEN_MAX = "2";
  process.env.MCP_OAUTH_RATE_LIMIT_WINDOW_MS = "60000";

  const mod = await import("../index.js");
  consumeInMemoryRateLimit = mod.__testables.consumeInMemoryRateLimit;
  inMemoryRateLimits = mod.__testables.inMemoryRateLimits;
  resetInMemorySecurityState = mod.__testables.resetInMemorySecurityState;
});

beforeEach(() => {
  resetInMemorySecurityState();
});

describe("in-memory rate limiter", () => {
  it("allows requests under the limit", () => {
    const req = createMockRequest();
    expect(consumeInMemoryRateLimit(req, "authorize")).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
    expect(consumeInMemoryRateLimit(req, "authorize")).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
    expect(consumeInMemoryRateLimit(req, "authorize")).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("blocks requests exceeding the authorize limit", () => {
    const req = createMockRequest();
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    const result = consumeInMemoryRateLimit(req, "authorize");
    expect(result.limited).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("blocks requests exceeding the token limit", () => {
    const req = createMockRequest();
    consumeInMemoryRateLimit(req, "token");
    consumeInMemoryRateLimit(req, "token");
    const result = consumeInMemoryRateLimit(req, "token");
    expect(result.limited).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks different IPs independently", () => {
    const req1 = createMockRequest("10.0.0.1");
    const req2 = createMockRequest("10.0.0.2");
    consumeInMemoryRateLimit(req1, "authorize");
    consumeInMemoryRateLimit(req1, "authorize");
    consumeInMemoryRateLimit(req1, "authorize");
    expect(consumeInMemoryRateLimit(req1, "authorize").limited).toBe(true);
    expect(consumeInMemoryRateLimit(req2, "authorize").limited).toBe(false);
  });

  it("tracks different buckets independently", () => {
    const req = createMockRequest();
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    expect(consumeInMemoryRateLimit(req, "authorize").limited).toBe(true);
    expect(consumeInMemoryRateLimit(req, "token").limited).toBe(false);
  });

  it("resets after window expires", () => {
    const req = createMockRequest();
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    expect(consumeInMemoryRateLimit(req, "authorize").limited).toBe(true);

    // Simulate window expiry by backdating the entry
    const entry = inMemoryRateLimits.get("authorize:10.0.0.1");
    expect(entry).toBeDefined();
    entry!.windowStartMs -= 61_000;

    expect(consumeInMemoryRateLimit(req, "authorize").limited).toBe(false);
  });

  it("evicts stale entries for other addresses during fallback checks", () => {
    const staleReq = createMockRequest("10.0.0.1");
    consumeInMemoryRateLimit(staleReq, "authorize");

    const staleEntry = inMemoryRateLimits.get("authorize:10.0.0.1");
    expect(staleEntry).toBeDefined();
    staleEntry!.windowStartMs -= 61_000;

    const freshReq = createMockRequest("10.0.0.2");
    expect(consumeInMemoryRateLimit(freshReq, "authorize").limited).toBe(false);
    expect(inMemoryRateLimits.has("authorize:10.0.0.1")).toBe(false);
  });

  it("is cleared by resetInMemorySecurityState", () => {
    const req = createMockRequest();
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    consumeInMemoryRateLimit(req, "authorize");
    expect(consumeInMemoryRateLimit(req, "authorize").limited).toBe(true);

    resetInMemorySecurityState();

    expect(consumeInMemoryRateLimit(req, "authorize").limited).toBe(false);
  });
});
