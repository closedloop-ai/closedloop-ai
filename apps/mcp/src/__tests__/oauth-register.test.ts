/**
 * Registration-refusal tests for POST /oauth/register (handleOAuthRegister)
 * and the buildAuthorizeHtml error branch (L2222) via POST /oauth/authorize.
 *
 * SCOPE: validation/refusal arms only (HTTP 400/405) plus the two success
 * paths required to reach uncovered ternary arms (L2163 client_name default,
 * L2179 omitted grant_types default).  The 201 registration contract
 * (client_id, grant_types array, token_endpoint_auth_method, response_types)
 * is owned by oauth-endpoints.test.ts L2505-2535 and MUST NOT be re-asserted
 * here.
 */

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
  // Stub DB used by maybeCleanupOAuthSecurityTablesSafe (cleanup path) and
  // consumeOAuthRateLimit (rate-limit path).  All methods resolve so that
  // runOAuthCleanupQueries can build a fully-settled Promise.allSettled array
  // without any synchronous throw escaping before the array is constructed.
  const noop = (): Promise<{ count: number }> => Promise.resolve({ count: 0 });
  const stubDb = {
    oAuthAuthorizationCode: { deleteMany: noop },
    oAuthRevokedToken: { deleteMany: noop },
    oAuthRefreshToken: { deleteMany: noop },
    oAuthRateLimit: {
      deleteMany: noop,
      findUnique: (): Promise<null> => Promise.resolve(null),
      upsert: noop,
      updateMany: noop,
    },
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

let dispatchHttpRequest: (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => Promise<boolean>;

const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  // Non-local environment: loopbacks are always accepted; non-loopback URIs
  // must appear in the allowlist below.
  process.env.INTERNAL_API_SECRET = "test-reg-secret";
  process.env.WEBAPP_ENV = "stage";
  process.env.MCP_OAUTH_REDIRECT_URIS = "https://allowed.example.com/callback";
  // Small body limit to exercise the overflow branch without a giant fixture.
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "200";

  const mod = await import("../index.js");
  dispatchHttpRequest = mod.__testables.dispatchHttpRequest;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegisterRequest(options: {
  method?: string;
  body?: string;
  contentType?: string;
}): [
  import("node:http").IncomingMessage,
  ReturnType<typeof createMockResponse>,
] {
  const {
    method = "POST",
    body = "",
    contentType = "application/json",
  } = options;
  const req = createMockRequest({
    method,
    url: "/oauth/register",
    headers: contentType ? { "content-type": contentType } : {},
    body,
  });
  const res = createMockResponse();
  return [req, res];
}

function parseBody(res: ReturnType<typeof createMockResponse>): unknown {
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------
// POST /oauth/register — refusal arms
// ---------------------------------------------------------------------------

describe("POST /oauth/register refusals", () => {
  it("returns 405 with Allow: POST when method is not POST", async () => {
    const [req, res] = makeRegisterRequest({ method: "GET" });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("returns 400 invalid_client_metadata when Content-Type is not application/json", async () => {
    const [req, res] = makeRegisterRequest({
      contentType: "text/plain",
      body: '{"redirect_uris":["http://localhost"]}',
    });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 400 invalid_client_metadata when body is whitespace", async () => {
    const [req, res] = makeRegisterRequest({ body: "   " });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 400 invalid_client_metadata when body is malformed JSON", async () => {
    const [req, res] = makeRegisterRequest({ body: "{bad json" });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 400 invalid_client_metadata when body is a JSON array", async () => {
    const [req, res] = makeRegisterRequest({ body: "[]" });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 400 invalid_client_metadata when body exceeds MAX_REQUEST_BODY_BYTES", async () => {
    // Body is 210 chars of valid JSON, exceeding the 200-byte limit set in beforeAll.
    const padding = "x".repeat(180);
    const oversized = JSON.stringify({
      redirect_uris: ["http://localhost"],
      _pad: padding,
    });
    const [req, res] = makeRegisterRequest({ body: oversized });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 400 with redirect_uris error when redirect_uris key is missing", async () => {
    const [req, res] = makeRegisterRequest({ body: "{}" });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toContain("redirect_uris is required");
  });

  it("returns 400 with redirect_uris error when redirect_uris is a string not an array", async () => {
    const payload = JSON.stringify({ redirect_uris: "http://localhost" });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain("redirect_uris is required");
  });

  it("returns 400 with redirect_uris error when redirect_uris is empty array", async () => {
    const payload = JSON.stringify({ redirect_uris: [] });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain("redirect_uris is required");
  });

  it("returns 400 invalid_redirect_uri when redirect_uris contains a non-string entry", async () => {
    const payload = JSON.stringify({ redirect_uris: [42] });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("returns 400 invalid_redirect_uri when redirect_uri uses a non-http(s) scheme", async () => {
    const payload = JSON.stringify({ redirect_uris: ["ftp://example.com/cb"] });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("returns 400 invalid_redirect_uri when non-loopback URI is absent from the allowlist", async () => {
    // allowlist = "https://allowed.example.com/callback"; this URI is not in it.
    const payload = JSON.stringify({
      redirect_uris: ["https://evil.example.com/cb"],
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("returns 400 invalid_client_metadata when grant_types is a non-empty string (not an array)", async () => {
    const payload = JSON.stringify({
      redirect_uris: ["http://localhost"],
      grant_types: "authorization_code",
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain(
      "grant_types must be a non-empty array"
    );
  });

  it("returns 400 invalid_client_metadata when grant_types is an empty array", async () => {
    const payload = JSON.stringify({
      redirect_uris: ["http://localhost"],
      grant_types: [],
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain(
      "grant_types must be a non-empty array"
    );
  });

  it("returns 400 invalid_client_metadata when grant_types contains non-string members", async () => {
    const payload = JSON.stringify({
      redirect_uris: ["http://localhost"],
      grant_types: [1, "authorization_code"],
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain(
      "grant_types values must be strings"
    );
  });

  it("returns 400 invalid_client_metadata when grant_types contains an unsupported value", async () => {
    const payload = JSON.stringify({
      redirect_uris: ["http://localhost"],
      grant_types: ["authorization_code", "client_credentials"],
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain(
      "Only authorization_code and refresh_token"
    );
  });

  it("returns 400 invalid_client_metadata when grant_types omits authorization_code", async () => {
    const payload = JSON.stringify({
      redirect_uris: ["http://localhost"],
      grant_types: ["refresh_token"],
    });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(400);
    const body = parseBody(res) as Record<string, string>;
    expect(body.error_description).toContain(
      "authorization_code grant_type is required"
    );
  });

  // Success path: exercises L2163 (client_name absent → "MCP Client" default)
  it("uses MCP Client as default client_name when field is absent", async () => {
    const payload = JSON.stringify({ redirect_uris: ["http://localhost"] });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.client_name).toBe("MCP Client");
  });

  // Success path: exercises L2179 (grant_types omitted → default grant types)
  it("uses default grant types when grant_types field is omitted", async () => {
    const payload = JSON.stringify({ redirect_uris: ["http://localhost"] });
    const [req, res] = makeRegisterRequest({ body: payload });
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as Record<string, unknown>;
    expect(Array.isArray(body.grant_types)).toBe(true);
    expect(body.grant_types).toContain("authorization_code");
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeHtml error branch via POST /oauth/authorize (L2222)
// ---------------------------------------------------------------------------

describe("buildAuthorizeHtml error branch", () => {
  it("renders an error div when a form POST to /oauth/authorize has no API key", async () => {
    // No api_key in the form body → extractApiKeyFromRequest returns null →
    // resolveAuthorizeContext calls sendAuthorizeHtmlForm with an error string →
    // buildAuthorizeHtml renders the error <div> (L2222 error ternary arm).
    const req = createMockRequest({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const res = createMockResponse();
    await dispatchHttpRequest(req, asServerResponse(res));

    expect(res.statusCode).toBe(200);
    // The error div has a distinctive inline style that only appears on the error path.
    expect(res.body).toContain("background:#fee");
  });
});
