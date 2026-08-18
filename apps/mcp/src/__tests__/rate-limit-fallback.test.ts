import type { IncomingMessage } from "node:http";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

// ---------------------------------------------------------------------------
// getClientAddress — via consumeInMemoryRateLimit (L1129/1130/1135/1139)
//
// MCP_TRUST_PROXY and INTERNAL_ENDPOINT_ALLOWLIST are module-level constants
// so each env variant needs vi.resetModules() + a fresh dynamic import.
// ---------------------------------------------------------------------------

describe.sequential("getClientAddress via consumeInMemoryRateLimit", () => {
  const ORIG_TRUST_PROXY = process.env.MCP_TRUST_PROXY;

  afterEach(() => {
    vi.resetModules();
    if (ORIG_TRUST_PROXY === undefined) {
      Reflect.deleteProperty(process.env, "MCP_TRUST_PROXY");
    } else {
      process.env.MCP_TRUST_PROXY = ORIG_TRUST_PROXY;
    }
  });

  it("ignores x-forwarded-for and uses socket.remoteAddress when TRUST_PROXY is not set", async () => {
    // MCP_TRUST_PROXY not set → TRUST_PROXY = false → x-forwarded-for is skipped.
    const mod = await import("../index.js");
    const { consumeInMemoryRateLimit: fn, inMemoryRateLimits: map } =
      mod.__testables;
    map.clear();

    const req = {
      method: "POST",
      url: "/",
      headers: { "x-forwarded-for": "9.9.9.9" },
      socket: { remoteAddress: "10.0.0.5" },
    } as unknown as import("node:http").IncomingMessage;

    fn(req, "token");
    // x-forwarded-for is NOT trusted → address is socket.remoteAddress.
    expect(map.has("token:10.0.0.5")).toBe(true);
    expect(map.has("token:9.9.9.9")).toBe(false);
  });

  it("honors x-forwarded-for when TRUST_PROXY=1", async () => {
    process.env.MCP_TRUST_PROXY = "1";
    const mod = await import("../index.js");
    const { consumeInMemoryRateLimit: fn, inMemoryRateLimits: map } =
      mod.__testables;
    map.clear();

    const req = {
      method: "POST",
      url: "/",
      headers: { "x-forwarded-for": "9.9.9.9" },
      socket: { remoteAddress: "10.0.0.5" },
    } as unknown as import("node:http").IncomingMessage;

    fn(req, "token");
    expect(map.has("token:9.9.9.9")).toBe(true);
    expect(map.has("token:10.0.0.5")).toBe(false);
  });

  it("falls back to socket.remoteAddress when x-forwarded-for is whitespace with TRUST_PROXY=1", async () => {
    // forwarded.trim().length === 0 → condition false → falls through to socket.
    process.env.MCP_TRUST_PROXY = "1";
    const mod = await import("../index.js");
    const { consumeInMemoryRateLimit: fn, inMemoryRateLimits: map } =
      mod.__testables;
    map.clear();

    const req = {
      method: "POST",
      url: "/",
      headers: { "x-forwarded-for": "   " },
      socket: { remoteAddress: "10.0.0.5" },
    } as unknown as import("node:http").IncomingMessage;

    fn(req, "token");
    expect(map.has("token:10.0.0.5")).toBe(true);
  });

  it("takes the first entry from a multi-hop x-forwarded-for with TRUST_PROXY=1", async () => {
    process.env.MCP_TRUST_PROXY = "1";
    const mod = await import("../index.js");
    const { consumeInMemoryRateLimit: fn, inMemoryRateLimits: map } =
      mod.__testables;
    map.clear();

    const req = {
      method: "POST",
      url: "/",
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" },
      socket: { remoteAddress: "10.0.0.5" },
    } as unknown as import("node:http").IncomingMessage;

    fn(req, "token");
    // Only the leftmost (client-supplied) IP is trusted.
    expect(map.has("token:1.2.3.4")).toBe(true);
  });

  it("uses 'unknown' when socket.remoteAddress is absent", async () => {
    // socket?.remoteAddress → undefined ?? "unknown" → L1139 branch.
    const mod = await import("../index.js");
    const { consumeInMemoryRateLimit: fn, inMemoryRateLimits: map } =
      mod.__testables;
    map.clear();

    const req = {
      method: "POST",
      url: "/",
      headers: {},
      socket: null,
    } as unknown as import("node:http").IncomingMessage;

    fn(req, "token");
    expect(map.has("token:unknown")).toBe(true);
  });
});
