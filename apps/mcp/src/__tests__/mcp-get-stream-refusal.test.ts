import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ApiKeyVerificationStatus } from "../api-key-contract.js";
import { MCP_ALLOWED_METHODS } from "../mcp-method-contract.js";
import { mcpSessions } from "../mcp-session-store.js";

const { verifyApiKeyMock } = vi.hoisted(() => ({ verifyApiKeyMock: vi.fn() }));

vi.mock("../api-client.js", () => ({
  checkApiReachable: vi.fn(async () => true),
  createApiClient: vi.fn(() => ({})),
  verifyApiKeyDetailed: async (plaintextKey: string) => {
    const context = await verifyApiKeyMock(plaintextKey);
    return context
      ? { status: ApiKeyVerificationStatus.Ok, context }
      : { status: ApiKeyVerificationStatus.Invalid };
  },
}));

vi.mock("@repo/database", () => {
  const db = {
    organization: { findUnique: () => Promise.resolve({ slug: "test-org" }) },
  };
  const withDb = Object.assign(
    async <T>(fn: (client: typeof db) => Promise<T> | T): Promise<T> => fn(db),
    {
      tx: async <T>(fn: (client: typeof db) => Promise<T>): Promise<T> =>
        fn(db),
    }
  );
  return { withDb };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

// The suite-wide 30s in `vitest.config.ts` is sized for the COLD
// `import("../index.js")` transform, which happens once in `beforeAll` and is
// bounded by `hookTimeout`. No case here pays that: each is loopback HTTP
// against an already-listening server, measured at 135ms / 114ms / 1ms warm.
// 10s keeps ~70x headroom for a contended CI worker while landing under the SDK
// client's own 60s request timeout — the bound that would otherwise absorb a
// hang, because a regression that reopens the SSE stream strands `listTools()`
// on a response that never arrives.
const INTEGRATION_CASE_TIMEOUT_MS = 10_000;

const TEST_API_KEY = "sk_live_get_stream_refusal_test";
const TEST_ENV: Record<string, string> = {
  INTERNAL_API_SECRET: "test-internal-secret",
};

const previousEnv = new Map<string, string | undefined>();
let httpServer: Server;
let baseUrl: string;
let observedRequests: Array<{ method: string; url: string }> = [];
let openClient: Client | undefined;

function authHeaders(sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_API_KEY}`,
    accept: "text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  return headers;
}

async function connectRealSdkClient(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  transportErrors: unknown[];
}> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
  });
  const transportErrors: unknown[] = [];
  transport.onerror = (error) => {
    transportErrors.push(error);
  };
  const client = new Client({ name: "refusal-test", version: "1.0.0" });
  await client.connect(transport);
  openClient = client;
  return { client, transport, transportErrors };
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  const mod = await import("../index.js");
  httpServer = mod.createHttpServer();
  httpServer.on("request", (req) => {
    observedRequests.push({ method: req.method ?? "", url: req.url ?? "" });
  });
  // A bind failure (EADDRINUSE, a sandbox refusing the listen) emits `error`
  // rather than calling back, so without this the hook never settles and the
  // suite reports a hook timeout instead of the bind error that caused it. The
  // handler comes off once listening, so a later server error still surfaces as
  // itself rather than as a rejection nobody is awaiting.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  // Without this, a regression that reopens the SSE stream leaves a socket held
  // and the hook burns its full timeout, stacking a suite failure on top of the
  // assertion failure that actually names the bug.
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
});

beforeEach(() => {
  observedRequests = [];
  verifyApiKeyMock.mockReset();
  verifyApiKeyMock.mockImplementation((apiKey: string) =>
    apiKey === TEST_API_KEY
      ? { userId: "user_1", organizationId: "org_1", scopes: ["read", "write"] }
      : null
  );
});

afterEach(async () => {
  // A failed assertion skips the in-test close, which would leak the client,
  // its transport, and their sockets into the suite teardown.
  await openClient?.close();
  openClient = undefined;
});

describe("GET /mcp standalone SSE stream refusal (ISS-8272)", () => {
  it(
    "refuses a live session's GET stream with 405 while POST and DELETE keep working",
    async () => {
      const { client, transport, transportErrors } =
        await connectRealSdkClient();
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();

      // The SDK opens the standalone stream itself once `notifications/initialized`
      // is accepted, so waiting for that GET is what makes the refusal observable
      // to the real client rather than only to the raw request below.
      await vi.waitFor(() =>
        expect(
          observedRequests.some(
            (r) => r.method === "GET" && r.url.startsWith("/mcp")
          )
        ).toBe(true)
      );

      const refused = await fetch(baseUrl, {
        method: "GET",
        headers: authHeaders(sessionId),
      });
      expect(refused.status).toBe(405);
      expect(refused.headers.get("allow")).toBe(MCP_ALLOWED_METHODS);

      // A route that refused every method would satisfy the assertion above, so
      // the session has to still answer the two methods `Allow` advertises.
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      const terminated = await fetch(baseUrl, {
        method: "DELETE",
        headers: authHeaders(sessionId),
      });
      expect(terminated.status).toBe(200);

      // A 405 is not an error condition for the SDK client, so a clean handshake
      // must leave the transport's error channel empty.
      expect(transportErrors).toEqual([]);
    },
    INTEGRATION_CASE_TIMEOUT_MS
  );

  // The precondition the refusal rests on, stated as behavior: this server sends
  // nothing on that stream today, and if it ever does, this is what happens to
  // it. A notification vanishes; a server-to-client REQUEST would hang instead,
  // because its response can never arrive.
  it(
    "drops a server-initiated message, because refusing GET removes its only channel",
    async () => {
      const { client, transport } = await connectRealSdkClient();
      const session = mcpSessions.get(transport.sessionId as string);
      expect(session).toBeDefined();

      // Send only once the SDK's own standalone GET has been answered, so that a
      // server still serving the stream would have it established by now. Without
      // this the case races and passes for the wrong reason.
      await vi.waitFor(() =>
        expect(
          observedRequests.some(
            (r) => r.method === "GET" && r.url.startsWith("/mcp")
          )
        ).toBe(true)
      );
      await client.listTools();

      const delivered: unknown[] = [];
      client.fallbackNotificationHandler = (notification) => {
        delivered.push(notification);
        return Promise.resolve();
      };

      // No related request id, so the SDK routes this to the standalone GET
      // stream rather than to any POST response.
      await session?.transport.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "probe" },
      });
      // A round trip the notification would have been delivered on had the
      // stream been open, so the emptiness below is not just impatience.
      await client.listTools();

      expect(delivered).toEqual([]);
    },
    INTEGRATION_CASE_TIMEOUT_MS
  );

  it(
    "refuses an unrecognized session id with 405 rather than 404",
    async () => {
      const response = await fetch(baseUrl, {
        method: "GET",
        headers: authHeaders("0".repeat(32)),
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(MCP_ALLOWED_METHODS);
    },
    INTEGRATION_CASE_TIMEOUT_MS
  );

  // The boundary the documented method contract rests on. The OAuth challenge
  // runs before the refusal and fires only when NEITHER `Mcp-Session-Id` nor
  // `Authorization` is present, so a client holding a token but no session yet
  // is refused by method rather than sent back around auth discovery. The other
  // side — a bare GET with no headers answered 401 — is pinned by
  // `oauth-endpoints.test.ts`.
  it(
    "refuses a credentialed GET with no session using 405, not the auth challenge",
    async () => {
      const response = await fetch(baseUrl, {
        method: "GET",
        headers: authHeaders(),
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(MCP_ALLOWED_METHODS);
    },
    INTEGRATION_CASE_TIMEOUT_MS
  );
});
