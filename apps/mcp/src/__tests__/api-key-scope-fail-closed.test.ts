/**
 * ISS-4905 regression suite: an API key whose stored scope array is empty,
 * absent, or entirely unrecognized must resolve to the LEAST privilege, not the
 * most.
 *
 * Before the fix, `effectiveKeyScopes` returned the full scope set whenever the
 * stored array was empty (`scopes.length > 0 ? scopes : [...API_KEY_SCOPES]`),
 * so each of these cases minted a full-access credential. Every assertion here
 * drives a real MCP entrypoint (`dispatchHttpRequest` → `resolveMcpAuth`, and
 * `handleOAuthToken` → the client-credentials grant) rather than calling the
 * resolver helper directly, so a regression in the wiring fails too.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { API_KEY_SCOPES_UNRESOLVABLE_EVENT } from "@repo/api/src/utils/api-key-scope-resolution.js";
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
import { UNRESOLVABLE_KEY_SCOPES_DESCRIPTION } from "../oauth-scopes.js";
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
  type MockResponse,
} from "./fixtures/mock-http.js";

type StoredApiKey = {
  id: string;
  keyHash: string;
  userId: string;
  organizationId: string;
  scopes: string[] | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

type HandlerFn = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const verifyApiKeyMock = vi.fn();
const checkApiReachableMock = vi.fn();
const apiKeyStore: StoredApiKey[] = [];

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("../api-client.js", () => ({
  verifyApiKey: verifyApiKeyMock,
  // Mirror the real module: `verifyApiKeyDetailed` is the source of truth and
  // `verifyApiKey` collapses it, so deriving one from the other keeps the
  // mock from producing a pair the production module never could. Throwing
  // still propagates, which is what drives the local-verification fallback.
  verifyApiKeyDetailed: async (plaintextKey: string) => {
    if (plaintextKey === REMOTE_UNRESOLVABLE_KEY) {
      return { status: ApiKeyVerificationStatus.UnresolvableScopes };
    }
    const context = await verifyApiKeyMock(plaintextKey);
    return context
      ? { status: ApiKeyVerificationStatus.Ok, context }
      : { status: ApiKeyVerificationStatus.Invalid };
  },
  checkApiReachable: checkApiReachableMock,
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    flush: vi.fn(),
  },
}));

vi.mock("@repo/database", () => {
  const emptyModel = {
    findFirst: () => Promise.resolve(null),
    findUnique: () => Promise.resolve(null),
    create: (args: { data: unknown }) => Promise.resolve(args.data),
    update: (args: { data: unknown }) => Promise.resolve(args.data),
    updateMany: () => Promise.resolve({ count: 0 }),
    deleteMany: () => Promise.resolve({ count: 0 }),
    count: () => Promise.resolve(0),
  };

  const dbMock = {
    $queryRaw: () => Promise.resolve([{ "?column?": 1 }]),
    $queryRawUnsafe: () => Promise.resolve([{ locked: false }]),
    apiKey: {
      ...emptyModel,
      findFirst: ({ where }: { where: { keyHash: string } }) => {
        const record =
          apiKeyStore.find(
            (candidate) =>
              candidate.keyHash === where.keyHash &&
              candidate.revokedAt === null
          ) ?? null;
        return Promise.resolve(record);
      },
      update: ({ data }: { data: unknown }) => Promise.resolve(data),
    },
    oAuthAuthorizationCode: { ...emptyModel },
    oAuthRefreshToken: { ...emptyModel },
    oAuthRevokedToken: { ...emptyModel },
    oAuthRateLimit: { ...emptyModel },
  };

  const withDb = Object.assign(
    <T>(fn: (db: typeof dbMock) => Promise<T> | T) =>
      Promise.resolve(fn(dbMock)),
    {
      tx: <T>(fn: (db: typeof dbMock) => Promise<T> | T) =>
        Promise.resolve(fn(dbMock)),
    }
  );

  return { withDb };
});

let handleOAuthToken: HandlerFn;
let dispatchHttpRequest: (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;
let resetInMemorySecurityState: () => void;

const FULL_ACCESS_KEY = "sk_live_full";
const EMPTY_SCOPE_KEY = "sk_live_empty_scopes";
const READ_ONLY_KEY = "sk_live_read_only";
const NULL_COLUMN_KEY = "sk_live_null_scopes";
const UNRECOGNIZED_SCOPE_KEY = "sk_live_unrecognized_scopes";
// A key the API itself refuses for an unresolvable scope row. This server
// never sees its context, so the reason can only reach it as the response
// code the internal verification endpoint carries (ISS-4905).
const REMOTE_UNRESOLVABLE_KEY = "sk_live_remote_unresolvable";

function contextFor(
  scopes: VerifiedApiKeyContext["scopes"]
): VerifiedApiKeyContext {
  return { userId: "user_1", organizationId: "org_1", scopes };
}

async function postClientCredentials(
  clientSecret: string,
  scope?: string
): Promise<MockResponse> {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: "closedloop-mcp",
    client_secret: clientSecret,
  });
  if (scope) {
    params.set("scope", scope);
  }
  const body = params.toString();
  const req = createMockRequest({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const res = createMockResponse();
  await handleOAuthToken(req, asServerResponse(res));
  return res;
}

async function postMcpInitialize(bearerKey: string): Promise<MockResponse> {
  const req = createMockRequest({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerKey}`,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
  const res = createMockResponse();
  await dispatchHttpRequest(req, asServerResponse(res));
  return res;
}

function unresolvableScopeLogReasons(): string[] {
  return logError.mock.calls
    .filter(([event]) => event === API_KEY_SCOPES_UNRESOLVABLE_EVENT)
    .map(([, meta]) => (meta as { reason: string }).reason);
}

const TEST_ENV: Record<string, string> = {
  INTERNAL_API_SECRET: "test-internal-secret",
  MCP_OAUTH_CLIENT_ID: "closedloop-mcp",
  MCP_OAUTH_TOKEN_TTL_SECONDS: "3600",
  MCP_OAUTH_REDIRECT_URIS: "http://localhost:7777/callback",
  MCP_MAX_REQUEST_BODY_BYTES: "8192",
};
const previousEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  // `pool: threads` shares process.env across suites in a worker, so every
  // mutation is restored in afterAll rather than leaked to the next file.
  for (const [key, value] of Object.entries(TEST_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const mod = await import("../index.js");
  handleOAuthToken = mod.__testables.handleOAuthToken as HandlerFn;
  dispatchHttpRequest = mod.__testables.dispatchHttpRequest as (
    req: IncomingMessage,
    res: ServerResponse
  ) => Promise<boolean>;
  resetInMemorySecurityState = mod.__testables
    .resetInMemorySecurityState as () => void;
});

afterAll(() => {
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
  resetInMemorySecurityState();
  apiKeyStore.length = 0;
  logError.mockReset();
  checkApiReachableMock.mockReset();
  checkApiReachableMock.mockResolvedValue(true);
  verifyApiKeyMock.mockReset();
  verifyApiKeyMock.mockImplementation((apiKey: string) => {
    if (apiKey === FULL_ACCESS_KEY) {
      return contextFor(["read", "write", "delete"]);
    }
    if (apiKey === READ_ONLY_KEY) {
      return contextFor(["read"]);
    }
    if (apiKey === EMPTY_SCOPE_KEY) {
      return contextFor([]);
    }
    if (apiKey === UNRECOGNIZED_SCOPE_KEY) {
      // A version-skewed peer wrote scopes this server does not recognize; the
      // sanitizer drops them all, leaving an empty set.
      return contextFor([
        "superuser",
        "org:admin",
      ] as unknown as VerifiedApiKeyContext["scopes"]);
    }
    return null;
  });
});

describe("ISS-4905 API key scopes fail closed", () => {
  it("keeps granting the scopes a well-formed key actually carries", async () => {
    const res = await postClientCredentials(READ_ONLY_KEY);

    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { scope: string }).scope).toBe("read");
    expect(unresolvableScopeLogReasons()).toEqual([]);
  });

  it("refuses an MCP request from a key with an empty stored scope array", async () => {
    const res = await postMcpInitialize(EMPTY_SCOPE_KEY);

    expect(res.statusCode).toBe(401);
    expect(unresolvableScopeLogReasons()).toContain("empty");
  });

  it("admits an MCP request from a key with real scopes", async () => {
    const res = await postMcpInitialize(FULL_ACCESS_KEY);

    // The mocked transport answers protocol-level handshakes with 400; the point
    // is that auth resolution accepted the credential, unlike the cases above.
    expect(res.statusCode).not.toBe(401);
    expect(unresolvableScopeLogReasons()).toEqual([]);
  });

  it("refuses a client-credentials grant for an empty stored scope array", async () => {
    const res = await postClientCredentials(EMPTY_SCOPE_KEY);

    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "invalid_scope"
    );
    expect(res.body).not.toContain("access_token");
    expect(unresolvableScopeLogReasons()).toContain("empty");
  });

  it("refuses a key whose stored scopes are all unrecognized by this server", async () => {
    const res = await postClientCredentials(UNRECOGNIZED_SCOPE_KEY);

    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "invalid_scope"
    );
    expect(res.body).not.toContain("access_token");
    expect(unresolvableScopeLogReasons()).toContain("all_unrecognized");
  });

  // ISS-4905 (wongk review): an access token outlives the scope set it was
  // minted from. Narrowing the key must invalidate the token, not silently
  // downgrade it to a zero-scope grant that still authenticates.
  it("refuses an OAuth token whose grant no longer overlaps the key scopes", async () => {
    const minted = await postClientCredentials(FULL_ACCESS_KEY, "write");
    expect(minted.statusCode).toBe(200);
    const { access_token: accessToken } = JSON.parse(minted.body) as {
      access_token: string;
    };

    // The key is narrowed to read-only after the token was issued.
    verifyApiKeyMock.mockImplementation((apiKey: string) =>
      apiKey === FULL_ACCESS_KEY ? contextFor(["read"]) : null
    );

    const res = await postMcpInitialize(accessToken);

    expect(res.statusCode).toBe(401);
    // The key itself resolves fine — this is an empty grant, not a corrupt row.
    expect(unresolvableScopeLogReasons()).toEqual([]);
  });

  // ISS-4905: before the verification response carried a reason, this arrived
  // as a bare 401 and the grant answered `invalid_client` — telling the caller
  // its credentials were wrong when the fix is to reissue the key.
  it("answers the reissue remedy when the API reports an unresolvable scope row", async () => {
    const res = await postClientCredentials(REMOTE_UNRESOLVABLE_KEY);

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body) as {
      error: string;
      error_description: string;
    };
    expect(json.error).toBe("invalid_scope");
    expect(json.error_description).toBe(UNRESOLVABLE_KEY_SCOPES_DESCRIPTION);
    expect(res.body).not.toContain("access_token");
  });

  // The local-verify fallback resolves from the RAW stored column, so the
  // monitor distinguishes a missing column from a version-skew artifact rather
  // than collapsing both to "empty" (ISS-4905).
  it.each<[string, string[] | null, string, number]>([
    ["null", null, "absent", 0],
    ["an empty array", [], "empty", 0],
    [
      "only unrecognized scopes",
      ["superuser", "org:admin"],
      "all_unrecognized",
      2,
    ],
  ])("refuses a key whose scopes column is %s on the local-verify fallback", async (_label, scopes, expectedReason, expectedRawCount) => {
    verifyApiKeyMock.mockImplementation(() => {
      throw new Error("upstream verification unavailable");
    });
    apiKeyStore.push({
      id: "key_unresolvable_scopes",
      keyHash: createHash("sha256")
        .update(NULL_COLUMN_KEY, "utf8")
        .digest("hex"),
      userId: "user_1",
      organizationId: "org_1",
      scopes,
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    });

    const res = await postMcpInitialize(NULL_COLUMN_KEY);

    expect(res.statusCode).toBe(401);
    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({
        surface: "mcp_local_key_verification",
        reason: expectedReason,
        rawScopeCount: expectedRawCount,
        apiKeyId: "key_unresolvable_scopes",
      })
    );
  });
});
