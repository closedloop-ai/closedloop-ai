import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ApiKeyVerificationStatus,
  type VerifiedApiKeyContext,
} from "../api-key-contract.js";
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
  type MockRequestOptions,
  type MockResponse,
} from "./fixtures/mock-http.js";

// Drives the /mcp authentication refusals, the request-target edge cases of
// `dispatchHttpRequest`, and the trusted-proxy client-address resolution.
// MCP_TRUST_PROXY is read at module load, so this file sets it before import.

const state = vi.hoisted(() => ({ revoked: new Map<string, Date>() }));
const verifyApiKeyDetailedMock = vi.hoisted(() => vi.fn());

vi.mock("../api-client.js", () => ({
  verifyApiKeyDetailed: verifyApiKeyDetailedMock,
  checkApiReachable: vi.fn(() => true),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("@repo/database", () => {
  const deleteMany = vi.fn(() => ({ count: 0 }));
  const dbMock = {
    oAuthRevokedToken: {
      deleteMany,
      findUnique: vi.fn(
        ({ where }: { where: { tokenFingerprint: string } }) => {
          const expiresAt = state.revoked.get(where.tokenFingerprint);
          return expiresAt ? { expiresAt } : null;
        }
      ),
      upsert: vi.fn(
        ({
          where,
          create,
        }: {
          where: { tokenFingerprint: string };
          create: { expiresAt: Date };
        }) => {
          state.revoked.set(where.tokenFingerprint, create.expiresAt);
          return {};
        }
      ),
    },
    oAuthRateLimit: {
      deleteMany,
      findUnique: vi.fn(() => null),
      upsert: vi.fn(() => ({ id: "rl" })),
      updateMany: vi.fn(() => ({ count: 1 })),
    },
    oAuthAuthorizationCode: { deleteMany },
    oAuthRefreshToken: { deleteMany },
    apiKey: {
      findFirst: vi.fn(() => null),
      update: vi.fn(() => ({})),
    },
  };
  const withDb = Object.assign(
    async <T>(fn: (db: typeof dbMock) => Promise<T> | T): Promise<T> =>
      fn(dbMock),
    {
      tx: <T>(fn: (db: typeof dbMock) => Promise<T>): Promise<T> => fn(dbMock),
    }
  );
  return { withDb };
});

const ENV_KEYS = [
  "INTERNAL_API_SECRET",
  "MCP_OAUTH_CLIENT_ID",
  "MCP_MAX_REQUEST_BODY_BYTES",
  "MCP_TRUST_PROXY",
] as const;
const SECRET = "mcp-auth-branches-secret";
const CLIENT_ID = "closedloop-mcp";
const VALID_KEY = "sk_live_valid";
const FULL_CONTEXT: VerifiedApiKeyContext = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"],
};
const JSON_HEADERS = { "content-type": "application/json" };
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
});
const MISSING_SESSION_ERROR = "Missing Mcp-Session-Id header";

let savedEnv: ReadonlyArray<readonly [string, string | undefined]>;
let dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let resetState: () => void;

function signAccessToken(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = createHmac("sha256", SECRET)
    .update(payloadB64)
    .digest("base64url");
  return `mcp_at_${payloadB64}.${signature}`;
}

function decodeAccessToken(token: string): Record<string, unknown> {
  const [payloadB64] = token.slice("mcp_at_".length).split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

async function sendRequest(req: IncomingMessage): Promise<{
  handled: boolean;
  res: MockResponse;
}> {
  const res = createMockResponse();
  const handled = await dispatch(req, asServerResponse(res));
  return { handled, res };
}

async function send(options: MockRequestOptions): Promise<MockResponse> {
  return (await sendRequest(createMockRequest(options))).res;
}

function postMcp(
  headers: Record<string, string>,
  body = INITIALIZE_BODY
): Promise<MockResponse> {
  return send({
    method: "POST",
    url: "/mcp",
    headers: { ...JSON_HEADERS, ...headers },
    body,
  });
}

function postMcpWithToken(token: string): Promise<MockResponse> {
  return postMcp({ authorization: `Bearer ${token}` });
}

async function issueAccessToken(): Promise<string> {
  const res = await send({
    method: "POST",
    url: "/oauth/token",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: VALID_KEY,
    }),
  });
  return (JSON.parse(res.body) as { access_token: string }).access_token;
}

function expectAuthChallenge(res: MockResponse): void {
  // biome-ignore lint/suspicious/noMisplacedAssertion: shared helper asserting the 401 challenge shape
  expect(res.statusCode).toBe(401);
  // biome-ignore lint/suspicious/noMisplacedAssertion: shared helper asserting the 401 challenge shape
  expect(res.headers["WWW-Authenticate"]).toContain(
    "/.well-known/oauth-protected-resource"
  );
}

function introspectFrom(
  remoteAddress: string,
  headers: Record<string, string> = {}
): Promise<MockResponse> {
  const req = Object.assign(
    createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: { ...JSON_HEADERS, "x-internal-secret": SECRET, ...headers },
      body: JSON.stringify({}),
    }),
    { socket: { remoteAddress } }
  );
  return sendRequest(req).then(({ res }) => res);
}

beforeAll(async () => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.MCP_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "2048";
  process.env.MCP_TRUST_PROXY = "true";
  const mod = await import("../index.js");
  dispatch = mod.__testables.dispatchHttpRequest;
  resetState = mod.__testables.resetInMemorySecurityState;
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

beforeEach(() => {
  resetState();
  state.revoked.clear();
  verifyApiKeyDetailedMock.mockReset();
  verifyApiKeyDetailedMock.mockImplementation(async (key: string) =>
    key === VALID_KEY
      ? { status: ApiKeyVerificationStatus.Ok, context: FULL_CONTEXT }
      : { status: ApiKeyVerificationStatus.Invalid }
  );
});

describe("/mcp OAuth access-token refusals", () => {
  it("challenges a bearer value that is neither an API key nor an access token", async () => {
    expectAuthChallenge(await postMcpWithToken("opaque-value"));
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("challenges an access token whose signature does not verify", async () => {
    expectAuthChallenge(await postMcpWithToken("mcp_at_payload.badsig"));
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("challenges an access token that has been revoked", async () => {
    const token = await issueAccessToken();
    const revoke = await send({
      method: "POST",
      url: "/internal/oauth/revoke",
      headers: { ...JSON_HEADERS, "x-internal-secret": SECRET },
      body: JSON.stringify({ token }),
    });
    expect(revoke.statusCode).toBe(200);
    verifyApiKeyDetailedMock.mockClear();
    expectAuthChallenge(await postMcpWithToken(token));
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("challenges a signed token whose key ciphertext does not decrypt", async () => {
    const payload = decodeAccessToken(await issueAccessToken());
    verifyApiKeyDetailedMock.mockClear();
    const forged = signAccessToken({ ...payload, apiKeyCiphertext: "x.y.z" });
    expectAuthChallenge(await postMcpWithToken(forged));
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("challenges a token whose backing key is now rejected", async () => {
    const token = await issueAccessToken();
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Invalid,
    });
    expectAuthChallenge(await postMcpWithToken(token));
    expect(verifyApiKeyDetailedMock).toHaveBeenLastCalledWith(VALID_KEY);
  });

  it("challenges a token whose backing key's scopes no longer resolve", async () => {
    const token = await issueAccessToken();
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Ok,
      context: { ...FULL_CONTEXT, scopes: [] },
    });
    expectAuthChallenge(await postMcpWithToken(token));
  });
});

describe("/mcp request shape refusals for authenticated callers", () => {
  const auth = { authorization: `Bearer ${VALID_KEY}` };

  it("answers 404 for DELETE on a session this task does not hold", async () => {
    const res = await send({
      method: "DELETE",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": "unknown-session" },
    });
    expect(res.statusCode).toBe(404);
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a non-POST without a session id", async () => {
    const res = await send({ method: "PUT", url: "/mcp", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: MISSING_SESSION_ERROR });
    expect(res.headers.Allow).toBe("POST");
  });

  it("answers 415 for a POST without a content-type", async () => {
    const res = await send({
      method: "POST",
      url: "/mcp",
      headers: auth,
      body: INITIALIZE_BODY,
    });
    expect(res.statusCode).toBe(415);
  });

  it("answers 413 when the declared content-length exceeds the ceiling", async () => {
    const res = await postMcp({ ...auth, "content-length": "999999" });
    expect(res.statusCode).toBe(413);
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("challenges a POST that names an unknown session but carries no credentials", async () => {
    expectAuthChallenge(await postMcp({ "mcp-session-id": "unknown-session" }));
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });
});

describe("dispatchHttpRequest request-target edge cases", () => {
  it("does not throw or reject on a missing url and leaves it unhandled", async () => {
    const req = Object.assign(createMockRequest({ method: "GET", url: "/" }), {
      url: undefined,
    });
    const { handled, res } = await sendRequest(req);
    expect(handled).toBe(false);
    expect(res.headersSent).toBe(false);
    expect(res.body).toBe("");
  });

  it("routes /oauth/token even when the method is missing, answering 405", async () => {
    const req = Object.assign(
      createMockRequest({ method: "POST", url: "/oauth/token" }),
      { method: undefined }
    );
    const { handled, res } = await sendRequest(req);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
  });

  it("leaves a POST to a GET-only route unhandled", async () => {
    const { handled } = await sendRequest(
      createMockRequest({ method: "POST", url: "/health" })
    );
    expect(handled).toBe(false);
  });
});

describe("client address resolution with MCP_TRUST_PROXY", () => {
  it("uses the first X-Forwarded-For hop, refusing a non-local caller", async () => {
    const res = await introspectFrom("127.0.0.1", {
      "x-forwarded-for": "203.0.113.9, 127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
  });

  it("falls back to the socket when the first forwarded hop is empty", async () => {
    const res = await introspectFrom("127.0.0.1", {
      "x-forwarded-for": " , 203.0.113.9",
    });
    // Authorized: reaches body validation, which rejects the empty body.
    expect(res.statusCode).toBe(400);
  });

  it("unwraps an IPv4-mapped IPv6 socket address", async () => {
    const res = await introspectFrom("::ffff:127.0.0.1");
    expect(res.statusCode).toBe(400);
  });
});
