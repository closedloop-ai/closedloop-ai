import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
  type MockResponse,
} from "./fixtures/mock-http.js";

/**
 * CORS handling lives in the `createHttpServer()` request listener inside
 * index.ts.  The env constants `CORS_ALLOWED_ORIGINS`, `MCP_SERVER_URL`,
 * `NODE_ENV`, and `WEBAPP_ENV` are read at module-init time, so each env
 * variant needs `vi.resetModules()` + a dynamic re-import (same pattern as
 * oauth-config.test.ts).
 */

const { logWarn, logInfo } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("../api-client.js", () => ({
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
  verifyApiKeyDetailed: vi.fn(),
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

const ORIGINAL_ENV = { ...process.env };

// Warm the Vite transform cache once before any per-test module reload.
// index.ts is ~3 600 lines; the cold transform takes ~4 s.  Paying that cost
// in beforeAll (which uses a separate hookTimeout budget) means every
// subsequent loadHandler() call only re-evaluates an already-transformed
// module (~100-200 ms) and never risks the per-test 5 s timeout.
beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-secret";
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";
  await import("../index.js");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void>;

async function loadHandler(
  envOverrides: Record<string, string | undefined> = {}
): Promise<RequestHandler> {
  process.env.INTERNAL_API_SECRET = "test-secret";
  // Suppress MCP_OAUTH_REDIRECT_URIS warning in non-local env tests
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
  const mod = await import("../index.js");
  const server = mod.createHttpServer();
  return server.listeners("request")[0] as RequestHandler;
}

async function drive(
  handler: RequestHandler,
  method: string,
  url: string,
  headers: Record<string, string> = {}
): Promise<MockResponse> {
  const req = createMockRequest({ method, url, headers });
  const res = createMockResponse();
  await handler(req, asServerResponse(res));
  return res;
}

describe.sequential("HTTP CORS handler", () => {
  it("always sets Vary:Origin even when the request carries no Origin header", async () => {
    const handler = await loadHandler({});
    const res = await drive(handler, "GET", "/health");

    expect(res.headers.Vary).toBe("Origin");
    expect(res.headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(res.statusCode).toBe(200);
  });

  it("allows same-origin requests whose Origin equals MCP_SERVER_URL", async () => {
    const handler = await loadHandler({
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    const res = await drive(handler, "GET", "/health", {
      origin: "https://mcp.example.com",
    });

    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://mcp.example.com"
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows any origin when * appears in MCP_CORS_ORIGINS", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "*",
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    const res = await drive(handler, "GET", "/health", {
      origin: "https://any-tool.dev",
    });

    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://any-tool.dev"
    );
  });

  it("allows an origin that exactly matches an entry in MCP_CORS_ORIGINS", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com,https://also-trusted.com",
      MCP_SERVER_URL: "https://mcp.example.com",
      WEBAPP_ENV: "stage",
    });
    const res = await drive(handler, "GET", "/health", {
      origin: "https://trusted.com",
    });

    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://trusted.com"
    );
  });

  it("allows any origin when allowlist is empty in a local environment", async () => {
    // NODE_ENV="test" in Vitest → isLocalOauthEnvironment() returns true
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "",
      WEBAPP_ENV: undefined, // delete so local default applies
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    const res = await drive(handler, "GET", "/health", {
      origin: "https://dev-tool.localhost",
    });

    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://dev-tool.localhost"
    );
  });

  it("refuses any origin when allowlist is empty in a non-local environment", async () => {
    // WEBAPP_ENV="stage" triggers the early-false branch in isLocalOauthEnvironment()
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "",
      WEBAPP_ENV: "stage",
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    const res = await drive(handler, "OPTIONS", "/mcp", {
      origin: "https://untrusted.example.com",
    });

    expect(res.statusCode).toBe(403);
    expect(res.headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("responds 204 to OPTIONS preflight from an allowed origin", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com",
      MCP_SERVER_URL: "https://mcp.example.com",
      WEBAPP_ENV: "stage",
    });
    const res = await drive(handler, "OPTIONS", "/mcp", {
      origin: "https://trusted.com",
    });

    expect(res.statusCode).toBe(204);
  });

  it("responds 403 to OPTIONS preflight from a disallowed origin", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com",
      MCP_SERVER_URL: "https://mcp.example.com",
      WEBAPP_ENV: "stage",
    });
    const res = await drive(handler, "OPTIONS", "/mcp", {
      origin: "https://evil.example.com",
    });

    expect(res.statusCode).toBe(403);
  });

  it("blocks non-OPTIONS requests from disallowed origins with 403", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com",
      WEBAPP_ENV: "stage",
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    const res = await drive(handler, "GET", "/health", {
      origin: "https://evil.example.com",
      host: "mcp.example.com",
    });

    expect(res.statusCode).toBe(403);
  });

  it("logs cors-blocked with requestOrigin key not origin to avoid logger-meta collision", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com",
      WEBAPP_ENV: "stage",
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    logWarn.mockClear();
    await drive(handler, "GET", "/health", {
      origin: "https://evil.example.com",
      host: "mcp.example.com",
    });

    expect(logWarn).toHaveBeenCalledWith(
      "[mcp] cors-blocked",
      expect.objectContaining({ requestOrigin: "https://evil.example.com" })
    );
    const meta = logWarn.mock.calls[0]?.[1] as Record<string, unknown>;
    // `origin` is a reserved logger meta key — the code uses `requestOrigin` instead
    expect(meta).not.toHaveProperty("origin");
  });

  it("cors-blocked log falls back to empty strings for absent host, method, and url", async () => {
    const handler = await loadHandler({
      MCP_CORS_ORIGINS: "https://trusted.com",
      WEBAPP_ENV: "stage",
      MCP_SERVER_URL: "https://mcp.example.com",
    });
    // Construct a request where method and url are undefined at runtime
    const req = {
      method: undefined,
      url: undefined,
      headers: { origin: "https://evil.example.com" },
      socket: { remoteAddress: "127.0.0.1" },
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    } as unknown as IncomingMessage;
    const res = createMockResponse();
    logWarn.mockClear();
    await handler(req, asServerResponse(res));

    const meta = logWarn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(meta).toMatchObject({ host: "", method: "", path: "" });
  });

  it("returns 404 for unrouted paths", async () => {
    const handler = await loadHandler({});
    const res = await drive(handler, "GET", "/no-such-route-xyz-abc");

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("catches unhandled errors and writes 500 when headers not yet sent", async () => {
    const handler = await loadHandler({
      WEBAPP_ENV: "stage",
      MCP_CORS_ORIGINS: "https://trusted.com",
    });
    // Trigger an unhandled throw: log.info is called inside dispatchHttpRequest
    // for /oauth/* paths before any route handler runs, so making it throw is
    // the cheapest way to reach the outer catch in createHttpServer.
    logInfo.mockImplementationOnce(() => {
      throw new Error("unexpected internal error");
    });
    const res = await drive(handler, "GET", "/oauth/authorize");

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Internal server error",
    });
  });

  it("skips the 500 write when headers were already sent before the error", async () => {
    const handler = await loadHandler({
      WEBAPP_ENV: "stage",
      MCP_CORS_ORIGINS: "https://trusted.com",
    });
    logInfo.mockImplementationOnce(() => {
      throw new Error("unexpected internal error");
    });
    const req = createMockRequest({ method: "GET", url: "/oauth/authorize" });
    const res = createMockResponse();
    // Simulate a partial response already committed
    res.headersSent = true;
    await handler(req, asServerResponse(res));

    // The catch block checks !res.headersSent; since it is true, sendJson must
    // not be called, leaving body empty.
    expect(res.body).toBe("");
  });
});
