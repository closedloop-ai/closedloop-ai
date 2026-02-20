import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const verifyApiKeyMock = vi.fn();
const checkApiReachableMock = vi.fn();
const revokedTokenStore = new Map<string, Date>();
const rateLimitStore = new Map<
  string,
  {
    id: string;
    bucket: string;
    subject: string;
    requestCount: number;
    windowStartedAt: Date;
    windowExpiresAt: Date;
  }
>();
const authCodeStore = new Map<
  string,
  {
    id: string;
    code: string;
    encryptedApiKey: string;
    userId: string;
    organizationId: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge: string;
    codeChallengeMethod: "S256";
    expiresAt: Date;
    consumedAt: Date | null;
    createdAt: Date;
  }
>();

vi.mock("../api-client.js", () => {
  return {
    verifyApiKey: verifyApiKeyMock,
    checkApiReachable: checkApiReachableMock,
    createApiClient: vi.fn(() => ({})),
  };
});

vi.mock("@repo/database", () => {
  const dbMock = {
    oAuthRevokedToken: {
      deleteMany: vi.fn(
        ({ where }: { where: { expiresAt: { lte: Date } } }) => {
          for (const [fingerprint, expiresAt] of revokedTokenStore.entries()) {
            if (expiresAt <= where.expiresAt.lte) {
              revokedTokenStore.delete(fingerprint);
            }
          }
          return { count: 0 };
        }
      ),
      upsert: vi.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { tokenFingerprint: string };
          create: { expiresAt: Date };
          update: { expiresAt: Date };
        }) => {
          const expiresAt =
            revokedTokenStore.get(where.tokenFingerprint) === undefined
              ? create.expiresAt
              : update.expiresAt;
          revokedTokenStore.set(where.tokenFingerprint, expiresAt);
          return { tokenFingerprint: where.tokenFingerprint, expiresAt };
        }
      ),
      findUnique: vi.fn(
        ({ where }: { where: { tokenFingerprint: string } }) => {
          const expiresAt = revokedTokenStore.get(where.tokenFingerprint);
          if (!expiresAt) {
            return null;
          }
          return { expiresAt };
        }
      ),
    },
    oAuthRateLimit: {
      deleteMany: vi.fn(
        ({ where }: { where: { windowExpiresAt: { lte: Date } } }) => {
          for (const [key, record] of rateLimitStore.entries()) {
            if (record.windowExpiresAt <= where.windowExpiresAt.lte) {
              rateLimitStore.delete(key);
            }
          }
          return { count: 0 };
        }
      ),
      findUnique: vi.fn(
        ({
          where,
        }: {
          where: { bucket_subject: { bucket: string; subject: string } };
        }) => {
          const key = `${where.bucket_subject.bucket}:${where.bucket_subject.subject}`;
          return rateLimitStore.get(key) ?? null;
        }
      ),
      upsert: vi.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { bucket_subject: { bucket: string; subject: string } };
          create: {
            bucket: string;
            subject: string;
            requestCount: number;
            windowStartedAt: Date;
            windowExpiresAt: Date;
          };
          update: {
            requestCount: number;
            windowStartedAt: Date;
            windowExpiresAt: Date;
          };
        }) => {
          const key = `${where.bucket_subject.bucket}:${where.bucket_subject.subject}`;
          const current = rateLimitStore.get(key);
          const next = current
            ? {
                ...current,
                requestCount: update.requestCount,
                windowStartedAt: update.windowStartedAt,
                windowExpiresAt: update.windowExpiresAt,
              }
            : {
                id: `rate_${Math.random().toString(36).slice(2, 10)}`,
                bucket: create.bucket,
                subject: create.subject,
                requestCount: create.requestCount,
                windowStartedAt: create.windowStartedAt,
                windowExpiresAt: create.windowExpiresAt,
              };
          rateLimitStore.set(key, next);
          return next;
        }
      ),
      update: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { requestCount: { increment: number } };
        }) => {
          const record = [...rateLimitStore.values()].find(
            (row) => row.id === where.id
          );
          if (!record) {
            throw new Error("Rate limit record not found");
          }
          record.requestCount += data.requestCount.increment;
          return record;
        }
      ),
    },
    oAuthAuthorizationCode: {
      deleteMany: vi.fn(
        ({ where }: { where: { OR: Record<string, unknown>[] } }) => {
          const expiryClause = where.OR.find((entry) => "expiresAt" in entry) as
            | { expiresAt: { lte: Date } }
            | undefined;
          for (const [code, record] of authCodeStore.entries()) {
            const expired = expiryClause
              ? record.expiresAt <= expiryClause.expiresAt.lte
              : false;
            const consumed = record.consumedAt !== null;
            if (expired || consumed) {
              authCodeStore.delete(code);
            }
          }
          return { count: 0 };
        }
      ),
      create: vi.fn(
        ({
          data,
        }: {
          data: {
            code: string;
            encryptedApiKey: string;
            userId: string;
            organizationId: string;
            clientId: string;
            redirectUri: string;
            scopes: string[];
            codeChallenge: string;
            codeChallengeMethod: "S256";
            expiresAt: Date;
          };
        }) => {
          const record = {
            id: `ac_${Math.random().toString(36).slice(2, 10)}`,
            code: data.code,
            encryptedApiKey: data.encryptedApiKey,
            userId: data.userId,
            organizationId: data.organizationId,
            clientId: data.clientId,
            redirectUri: data.redirectUri,
            scopes: data.scopes,
            codeChallenge: data.codeChallenge,
            codeChallengeMethod: data.codeChallengeMethod,
            expiresAt: data.expiresAt,
            consumedAt: null,
            createdAt: new Date(),
          };
          authCodeStore.set(data.code, record);
          return record;
        }
      ),
      findUnique: vi.fn(({ where }: { where: { code: string } }) => {
        return authCodeStore.get(where.code) ?? null;
      }),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; consumedAt: null };
          data: { consumedAt: Date };
        }) => {
          const record = [...authCodeStore.values()].find(
            (value) => value.id === where.id
          );
          if (!record || record.consumedAt !== null) {
            return { count: 0 };
          }
          record.consumedAt = data.consumedAt;
          return { count: 1 };
        }
      ),
    },
  };

  const withDb = Object.assign(
    async <T>(fn: (db: typeof dbMock) => Promise<T> | T): Promise<T> =>
      fn(dbMock),
    {
      tx: async <T>(fn: (db: typeof dbMock) => Promise<T>): Promise<T> =>
        fn(dbMock),
    }
  );

  return { withDb };
});

const DEFAULT_CONTEXT: VerifiedApiKeyContext = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"],
};

function codeChallengeFor(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type HandlerFn = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type MockResponse = {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  headersSent: boolean;
  writeHead: (...args: unknown[]) => MockResponse;
  end: (...args: unknown[]) => MockResponse;
};

let handleOAuthAuthorize: HandlerFn;
let handleOAuthToken: HandlerFn;
let handleOAuthIntrospect: HandlerFn;
let handleOAuthRevoke: HandlerFn;
let resetInMemorySecurityState: () => void;

function createMockRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const body = options.body ?? "";
  const req = {
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: () => {
          if (sent || body.length === 0) {
            return Promise.resolve({ done: true, value: undefined });
          }
          sent = true;
          return Promise.resolve({
            done: false,
            value: Buffer.from(body, "utf8"),
          });
        },
      };
    },
  };

  return req as unknown as IncomingMessage;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    body: "",
    headers: {},
    statusCode: 200,
    headersSent: false,
    writeHead(...args: unknown[]) {
      const statusCode = args[0];
      const maybeHeaders = args[1];
      if (typeof statusCode === "number") {
        response.statusCode = statusCode;
      }
      if (
        maybeHeaders &&
        typeof maybeHeaders === "object" &&
        !Array.isArray(maybeHeaders)
      ) {
        response.headers = {
          ...response.headers,
          ...(maybeHeaders as Record<string, string>),
        };
      }
      response.headersSent = true;
      return response;
    },
    end(...args: unknown[]) {
      const chunk = args[0];
      if (chunk !== undefined) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
      }
      response.headersSent = true;
      return response;
    },
  };

  return response;
}

function asServerResponse(response: MockResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  process.env.MCP_OAUTH_CLIENT_ID = "closedloop-mcp";
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";

  const mod = await import("../index.js");
  handleOAuthAuthorize = mod.__testables.handleOAuthAuthorize as HandlerFn;
  handleOAuthToken = mod.__testables.handleOAuthToken as HandlerFn;
  handleOAuthIntrospect = mod.__testables.handleOAuthIntrospect as HandlerFn;
  handleOAuthRevoke = mod.__testables.handleOAuthRevoke as HandlerFn;
  resetInMemorySecurityState = mod.__testables
    .resetInMemorySecurityState as () => void;
});

afterAll(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  resetInMemorySecurityState();
  revokedTokenStore.clear();
  rateLimitStore.clear();
  authCodeStore.clear();
  verifyApiKeyMock.mockReset();
  checkApiReachableMock.mockReset();
  checkApiReachableMock.mockResolvedValue(true);
  verifyApiKeyMock.mockImplementation((apiKey: string) => {
    if (apiKey === "sk_live_valid") {
      return DEFAULT_CONTEXT;
    }
    if (apiKey === "sk_live_read_only") {
      return { ...DEFAULT_CONTEXT, scopes: ["read"] };
    }
    return null;
  });
});

describe("OAuth endpoints", () => {
  it("issues an auth code and exchanges it once with PKCE", async () => {
    const verifier = "pkce-verifier-1";
    const challenge = codeChallengeFor(verifier);
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("scope", "read");
    authorizeUrl.searchParams.set("state", "state-123");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));

    expect(authorizeRes.statusCode).toBe(302);
    const location = authorizeRes.headers.Location;
    expect(location).toBeTruthy();
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe("state-123");

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(200);
    const tokenJson = JSON.parse(tokenRes.body) as {
      access_token: string;
      scope: string;
    };
    expect(tokenJson.access_token.startsWith("mcp_at_")).toBe(true);
    expect(tokenJson.scope).toBe("read");

    const replayReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const replayRes = createMockResponse();
    await handleOAuthToken(replayReq, asServerResponse(replayRes));
    expect(replayRes.statusCode).toBe(400);
    const replayJson = JSON.parse(replayRes.body) as { error: string };
    expect(replayJson.error).toBe("invalid_grant");
  });

  it("rejects authorization_code exchange with an invalid PKCE verifier", async () => {
    const verifier = "pkce-verifier-2";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: "wrong-verifier",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects client_credentials when requested scope exceeds key scopes", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_read_only",
      scope: "write",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_scope");
  });

  it("rejects authorization_code scope escalation at token exchange", async () => {
    const verifier = "pkce-verifier-scope";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("scope", "read");
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
      scope: "write",
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_scope");
  });

  it("rejects authorization_code exchange for client mismatch", async () => {
    const verifier = "pkce-verifier-client";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "wrong-client",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(401);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_client");
  });

  it("rejects authorization_code exchange for redirect_uri mismatch", async () => {
    const verifier = "pkce-verifier-redirect";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:9999/other",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects authorization_code exchange for expired code", async () => {
    const verifier = "pkce-verifier-expired";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const location = authorizeRes.headers.Location;
    const redirect = new URL(location ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 700_000);
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    });

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    nowSpy.mockRestore();

    expect(tokenRes.statusCode).toBe(400);
    const tokenJson = JSON.parse(tokenRes.body) as { error: string };
    expect(tokenJson.error).toBe("invalid_grant");
  });

  it("rejects unauthorized redirect_uri at authorization step", async () => {
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:9999/not-allowed"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor("pkce"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));

    expect(authorizeRes.statusCode).toBe(400);
    const json = JSON.parse(authorizeRes.body) as { error: string };
    expect(json.error).toBe("invalid_request");
  });

  it("revokes a token and returns inactive on introspection", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_valid",
      scope: "read",
    });
    const issueReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const issueRes = createMockResponse();
    await handleOAuthToken(issueReq, asServerResponse(issueRes));
    const issued = JSON.parse(issueRes.body) as { access_token: string };
    expect(issued.access_token.startsWith("mcp_at_")).toBe(true);

    const introspectReqBefore = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token: issued.access_token }),
    });
    const introspectResBefore = createMockResponse();
    await handleOAuthIntrospect(
      introspectReqBefore,
      asServerResponse(introspectResBefore)
    );
    expect(introspectResBefore.statusCode).toBe(200);
    const activeBefore = JSON.parse(introspectResBefore.body) as {
      active: boolean;
    };
    expect(activeBefore.active).toBe(true);

    const revokeReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/revoke",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token: issued.access_token }),
    });
    const revokeRes = createMockResponse();
    await handleOAuthRevoke(revokeReq, asServerResponse(revokeRes));
    expect(revokeRes.statusCode).toBe(200);
    const revoked = JSON.parse(revokeRes.body) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);

    const introspectReqAfter = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token: issued.access_token }),
    });
    const introspectResAfter = createMockResponse();
    await handleOAuthIntrospect(
      introspectReqAfter,
      asServerResponse(introspectResAfter)
    );
    expect(introspectResAfter.statusCode).toBe(200);
    const activeAfter = JSON.parse(introspectResAfter.body) as {
      active: boolean;
    };
    expect(activeAfter.active).toBe(false);
  });

  it("rejects internal introspect/revoke without internal secret", async () => {
    const introspectReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "mcp_at_fake" }),
    });
    const introspectRes = createMockResponse();
    await handleOAuthIntrospect(introspectReq, asServerResponse(introspectRes));
    expect(introspectRes.statusCode).toBe(401);

    const revokeReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/revoke",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "mcp_at_fake" }),
    });
    const revokeRes = createMockResponse();
    await handleOAuthRevoke(revokeReq, asServerResponse(revokeRes));
    expect(revokeRes.statusCode).toBe(401);
  });

  it("rate limits excessive token requests", async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_valid",
      scope: "read",
    }).toString();

    let lastStatus = 0;
    for (let index = 0; index < 65; index += 1) {
      const req = createMockRequest({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const res = createMockResponse();
      await handleOAuthToken(req, asServerResponse(res));
      lastStatus = res.statusCode;
      if (lastStatus === 429) {
        break;
      }
    }

    expect(lastStatus).toBe(429);
  });
});
