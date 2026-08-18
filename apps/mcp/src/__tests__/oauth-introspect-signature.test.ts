/**
 * Signature-rejection security path for handleOAuthIntrospect (L1447/L1458).
 *
 * parseSignedOAuthAccessToken returns null when no key in OAUTH_SIGNING_KEYS
 * produces a signature that matches the token (keyCandidates.find() returns
 * undefined, the `?? null` coalesces to null at L1457, and `if (!matchedEntry)`
 * at L1458 causes an early return of null).  handleOAuthIntrospect then sends
 * { active: false } — the token is reported inactive and no key material is
 * exposed.
 *
 * This path was previously mis-classified as unreachable.  It is a real
 * security boundary: a tampered or cross-service token must never be reported
 * active.
 */

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
} from "./fixtures/mock-http.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("../api-client.js", () => ({
  verifyApiKeyDetailed: vi.fn(),
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  // Stub DB used by maybeCleanupOAuthSecurityTablesSafe (cleanup path).
  // All methods resolve so that runOAuthCleanupQueries can build a
  // fully-settled Promise.allSettled array without any synchronous throw
  // escaping before the array is constructed.
  const noop = (): Promise<{ count: number }> => Promise.resolve({ count: 0 });
  const stubDb = {
    oAuthAuthorizationCode: { deleteMany: noop },
    oAuthRevokedToken: { deleteMany: noop },
    oAuthRefreshToken: { deleteMany: noop },
    oAuthRateLimit: { deleteMany: noop },
  };
  const withDb = Object.assign(
    async <T>(fn: (db: typeof stubDb) => Promise<T> | T): Promise<T> =>
      fn(stubDb),
    {
      tx: async <T>(fn: (db: typeof stubDb) => Promise<T>): Promise<T> =>
        fn(stubDb),
    }
  );
  return { withDb };
});

// Regex literal at module level (Biome useTopLevelRegex).
const BASE64URL_CHARS_RE = /[+/=]/g;

/** Encode a string to base64url (mirrors the production b64urlEncode). */
function b64UrlChar(c: string): string {
  if (c === "+") {
    return "-";
  }
  if (c === "/") {
    return "_";
  }
  return "";
}

function toB64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(BASE64URL_CHARS_RE, b64UrlChar);
}

/**
 * Build a token whose signature was produced by a key that is NOT registered
 * in OAUTH_SIGNING_KEY_BY_KID.  The production signing key is derived from
 * INTERNAL_API_SECRET = "test-introspect-secret"; we sign with a different
 * secret so timingSafeEqual returns false for every candidate, causing
 * keyCandidates.find() to return undefined.
 */
function makeForeignSignedToken(payloadObj: object): string {
  const payloadB64 = toB64Url(JSON.stringify(payloadObj));
  // Deliberately use a secret that is never registered as a signing key.
  const foreignSecret = "foreign-key-never-in-signing-key-map";
  const sig = createHmac("sha256", foreignSecret)
    .update(payloadB64)
    .digest("base64")
    .replace(BASE64URL_CHARS_RE, b64UrlChar);
  return `mcp_at_${payloadB64}.${sig}`;
}

let handleOAuthIntrospect: (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => Promise<void>;

const INTERNAL_SECRET = "test-introspect-secret";

const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
  // Local environment (no WEBAPP_ENV set): 127.0.0.1 is always an allowed
  // internal address without configuring MCP_INTERNAL_ALLOWED_IPS.
  const mod = await import("../index.js");
  handleOAuthIntrospect = mod.__testables.handleOAuthIntrospect;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("handleOAuthIntrospect — signature rejection (L1447/L1458)", () => {
  it("reports token inactive when signed by an unregistered key", async () => {
    // Payload without a `kid` → keyCandidates = OAUTH_SIGNING_KEYS (all keys).
    // The foreign signature matches none of them → matchedEntry is null.
    const token = makeForeignSignedToken({ sub: "u1" });

    const req = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ token }),
    });
    const res = createMockResponse();
    await handleOAuthIntrospect(req, asServerResponse(res));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.active).toBe(false);
  });

  it("does not leak key material or sensitive fields in the inactive response", async () => {
    const token = makeForeignSignedToken({ sub: "u2" });

    const req = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ token }),
    });
    const res = createMockResponse();
    await handleOAuthIntrospect(req, asServerResponse(res));

    const body = JSON.parse(res.body) as Record<string, unknown>;
    // Only `active: false` — no token fields, no key IDs, no ciphertext.
    expect(Object.keys(body)).toEqual(["active"]);
    expect(body.active).toBe(false);
  });
});
