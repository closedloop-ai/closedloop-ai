import { createHash } from "node:crypto";
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
import type { VerifiedApiKeyContext } from "../api-key-contract.js";

const verifyApiKeyMock = vi.fn();
const checkApiReachableMock = vi.fn();
const DYNAMIC_CLIENT_ID_REGEX = /^dyn_[a-f0-9]{32}$/;
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
    keyId: string;
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
const refreshTokenStore = new Map<
  string,
  {
    id: string;
    tokenFingerprint: string;
    encryptedApiKey: string;
    keyId: string;
    userId: string;
    organizationId: string;
    clientId: string;
    scopes: string[];
    familyId: string;
    expiresAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    replacedByTokenId: string | null;
    createdAt: Date;
  }
>();
let forceNextRefreshRotateConflict = false;

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
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; requestCount: { lt: number } };
          data: { requestCount: { increment: number } };
        }) => {
          const record = [...rateLimitStore.values()].find(
            (row) => row.id === where.id
          );
          if (!record || record.requestCount >= where.requestCount.lt) {
            return { count: 0 };
          }
          record.requestCount += data.requestCount.increment;
          return { count: 1 };
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
            keyId: string;
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
            keyId: data.keyId,
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
    oAuthRefreshToken: {
      deleteMany: vi.fn(
        ({ where }: { where: { expiresAt: { lte: Date } } }) => {
          for (const [fingerprint, record] of refreshTokenStore.entries()) {
            if (record.expiresAt <= where.expiresAt.lte) {
              refreshTokenStore.delete(fingerprint);
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
            tokenFingerprint: string;
            encryptedApiKey: string;
            keyId: string;
            userId: string;
            organizationId: string;
            clientId: string;
            scopes: string[];
            familyId: string;
            expiresAt: Date;
          };
        }) => {
          const record = {
            id: `rt_${Math.random().toString(36).slice(2, 10)}`,
            tokenFingerprint: data.tokenFingerprint,
            encryptedApiKey: data.encryptedApiKey,
            keyId: data.keyId,
            userId: data.userId,
            organizationId: data.organizationId,
            clientId: data.clientId,
            scopes: data.scopes,
            familyId: data.familyId,
            expiresAt: data.expiresAt,
            lastUsedAt: null,
            revokedAt: null,
            replacedByTokenId: null,
            createdAt: new Date(),
          };
          refreshTokenStore.set(data.tokenFingerprint, record);
          return { id: record.id };
        }
      ),
      findUnique: vi.fn(
        ({ where }: { where: { tokenFingerprint: string } }) => {
          return refreshTokenStore.get(where.tokenFingerprint) ?? null;
        }
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id?: string; familyId?: string; revokedAt?: null };
          data: {
            lastUsedAt?: Date;
            revokedAt?: Date;
            replacedByTokenId?: string;
          };
        }) => {
          if (
            forceNextRefreshRotateConflict &&
            where.id &&
            where.revokedAt === null &&
            data.revokedAt !== undefined
          ) {
            forceNextRefreshRotateConflict = false;
            return { count: 0 };
          }

          let count = 0;
          for (const record of refreshTokenStore.values()) {
            const idMatch = where.id ? record.id === where.id : true;
            const familyMatch = where.familyId
              ? record.familyId === where.familyId
              : true;
            const revokedMatch =
              where.revokedAt === null ? record.revokedAt === null : true;
            if (!(idMatch && familyMatch && revokedMatch)) {
              continue;
            }

            if (data.lastUsedAt !== undefined) {
              record.lastUsedAt = data.lastUsedAt;
            }
            if (data.revokedAt !== undefined) {
              record.revokedAt = data.revokedAt;
            }
            if (data.replacedByTokenId !== undefined) {
              record.replacedByTokenId = data.replacedByTokenId;
            }
            count += 1;
          }
          return { count };
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
let dispatchHttpRequestFn: (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;

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
  process.env.MCP_OAUTH_TOKEN_TTL_SECONDS = "3600";
  process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS = "2592000";
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "2048";

  const mod = await import("../index.js");
  handleOAuthAuthorize = mod.__testables.handleOAuthAuthorize as HandlerFn;
  handleOAuthToken = mod.__testables.handleOAuthToken as HandlerFn;
  handleOAuthIntrospect = mod.__testables.handleOAuthIntrospect as HandlerFn;
  handleOAuthRevoke = mod.__testables.handleOAuthRevoke as HandlerFn;
  dispatchHttpRequestFn = mod.__testables.dispatchHttpRequest as (
    req: IncomingMessage,
    res: ServerResponse
  ) => Promise<boolean>;
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
  refreshTokenStore.clear();
  forceNextRefreshRotateConflict = false;
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
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
      scope: string;
    };
    expect(tokenJson.access_token.startsWith("mcp_at_")).toBe(true);
    expect(tokenJson.refresh_token.startsWith("mcp_rt_")).toBe(true);
    expect(tokenJson.expires_in).toBe(3600);
    expect(tokenJson.refresh_token_expires_in).toBeGreaterThanOrEqual(
      2_591_995
    );
    expect(tokenJson.refresh_token_expires_in).toBeLessThanOrEqual(2_592_000);
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

  it("rotates refresh token via grant_type=refresh_token", async () => {
    const verifier = "pkce-refresh-verifier";
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("scope", "read write");
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      headers: { authorization: "Bearer sk_live_valid" },
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));
    const code = new URL(authorizeRes.headers.Location).searchParams.get(
      "code"
    );
    expect(code).toBeTruthy();

    const codeExchangeBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
      scope: "read write",
    }).toString();
    const codeExchangeReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: codeExchangeBody,
    });
    const codeExchangeRes = createMockResponse();
    await handleOAuthToken(codeExchangeReq, asServerResponse(codeExchangeRes));
    expect(codeExchangeRes.statusCode).toBe(200);
    const codeExchangeJson = JSON.parse(codeExchangeRes.body) as {
      refresh_token: string;
    };

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "closedloop-mcp",
      refresh_token: codeExchangeJson.refresh_token,
      scope: "read",
    }).toString();
    const refreshReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    const refreshRes = createMockResponse();
    await handleOAuthToken(refreshReq, asServerResponse(refreshRes));
    expect(refreshRes.statusCode).toBe(200);
    const refreshJson = JSON.parse(refreshRes.body) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(refreshJson.access_token.startsWith("mcp_at_")).toBe(true);
    expect(refreshJson.refresh_token.startsWith("mcp_rt_")).toBe(true);
    expect(refreshJson.refresh_token).not.toBe(codeExchangeJson.refresh_token);
    expect(refreshJson.scope).toBe("read");
  });

  it("detects refresh token reuse and revokes the token family", async () => {
    const verifier = "pkce-reuse-verifier";
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
    const code = new URL(authorizeRes.headers.Location).searchParams.get(
      "code"
    );
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
      scope: "read",
    }).toString();
    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(200);
    const first = JSON.parse(tokenRes.body) as { refresh_token: string };

    const rotateBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "closedloop-mcp",
      refresh_token: first.refresh_token,
    }).toString();
    const rotateReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rotateBody,
    });
    const rotateRes = createMockResponse();
    await handleOAuthToken(rotateReq, asServerResponse(rotateRes));
    expect(rotateRes.statusCode).toBe(200);
    const second = JSON.parse(rotateRes.body) as { refresh_token: string };

    const replayReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rotateBody,
    });
    const replayRes = createMockResponse();
    await handleOAuthToken(replayReq, asServerResponse(replayRes));
    expect(replayRes.statusCode).toBe(400);
    const replayJson = JSON.parse(replayRes.body) as { error: string };
    expect(replayJson.error).toBe("invalid_grant");

    const afterReuseBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "closedloop-mcp",
      refresh_token: second.refresh_token,
    }).toString();
    const afterReuseReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: afterReuseBody,
    });
    const afterReuseRes = createMockResponse();
    await handleOAuthToken(afterReuseReq, asServerResponse(afterReuseRes));
    expect(afterReuseRes.statusCode).toBe(400);
    const afterReuseJson = JSON.parse(afterReuseRes.body) as { error: string };
    expect(afterReuseJson.error).toBe("invalid_grant");
  });

  it("returns invalid_grant on refresh rotate race without revoking the family", async () => {
    const verifier = "pkce-rotate-race";
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
    const code = new URL(authorizeRes.headers.Location).searchParams.get(
      "code"
    );
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
      scope: "read",
    }).toString();
    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(200);
    const issued = JSON.parse(tokenRes.body) as { refresh_token: string };

    const issuedFingerprint = createHash("sha256")
      .update(issued.refresh_token, "utf8")
      .digest("hex");
    const issuedRecord = refreshTokenStore.get(issuedFingerprint);
    expect(issuedRecord).toBeTruthy();

    const siblingToken = "mcp_rt_sibling_token_for_race_test";
    const siblingFingerprint = createHash("sha256")
      .update(siblingToken, "utf8")
      .digest("hex");
    refreshTokenStore.set(siblingFingerprint, {
      id: "rt_sibling",
      tokenFingerprint: siblingFingerprint,
      encryptedApiKey: issuedRecord?.encryptedApiKey ?? "",
      keyId: issuedRecord?.keyId ?? "",
      userId: issuedRecord?.userId ?? "",
      organizationId: issuedRecord?.organizationId ?? "",
      clientId: issuedRecord?.clientId ?? "closedloop-mcp",
      scopes: issuedRecord?.scopes ?? ["read"],
      familyId:
        issuedRecord?.familyId ?? "00000000-0000-0000-0000-000000000001",
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: null,
      revokedAt: null,
      replacedByTokenId: null,
      createdAt: new Date(),
    });

    forceNextRefreshRotateConflict = true;
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "closedloop-mcp",
      refresh_token: issued.refresh_token,
    }).toString();

    const refreshReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    const refreshRes = createMockResponse();
    await handleOAuthToken(refreshReq, asServerResponse(refreshRes));
    expect(refreshRes.statusCode).toBe(400);
    const refreshJson = JSON.parse(refreshRes.body) as { error: string };
    expect(refreshJson.error).toBe("invalid_grant");

    const siblingReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "closedloop-mcp",
        refresh_token: siblingToken,
      }).toString(),
    });
    const siblingRes = createMockResponse();
    await handleOAuthToken(siblingReq, asServerResponse(siblingRes));
    expect(siblingRes.statusCode).toBe(200);
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

    const storedRecord = authCodeStore.get(code ?? "");
    expect(storedRecord).toBeTruthy();
    if (storedRecord) {
      storedRecord.expiresAt = new Date(Date.now() - 1000);
    }
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
      "https://attacker.example/cb"
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

  it("renders authorize html form when api key is not provided", async () => {
    const authorizeUrl = new URL("http://localhost/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "closedloop-mcp");
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:7777/callback"
    );
    authorizeUrl.searchParams.set("code_challenge", codeChallengeFor("pkce"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeReq = createMockRequest({
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
    });
    const authorizeRes = createMockResponse();
    await handleOAuthAuthorize(authorizeReq, asServerResponse(authorizeRes));

    expect(authorizeRes.statusCode).toBe(200);
    expect(authorizeRes.headers["Content-Type"]).toContain("text/html");
    expect(authorizeRes.body).toContain("Authorize MCP Access");
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

  it("revokes refresh token family via internal revoke endpoint", async () => {
    const verifier = "pkce-refresh-revoke-verifier";
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
    const code = new URL(authorizeRes.headers.Location).searchParams.get(
      "code"
    );
    expect(code).toBeTruthy();

    const exchangeBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "closedloop-mcp",
      code: code ?? "",
      redirect_uri: "http://localhost:7777/callback",
      code_verifier: verifier,
    }).toString();
    const exchangeReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: exchangeBody,
    });
    const exchangeRes = createMockResponse();
    await handleOAuthToken(exchangeReq, asServerResponse(exchangeRes));
    expect(exchangeRes.statusCode).toBe(200);
    const issued = JSON.parse(exchangeRes.body) as { refresh_token: string };

    const revokeReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/revoke",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token: issued.refresh_token }),
    });
    const revokeRes = createMockResponse();
    await handleOAuthRevoke(revokeReq, asServerResponse(revokeRes));
    expect(revokeRes.statusCode).toBe(200);

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "closedloop-mcp",
      refresh_token: issued.refresh_token,
    }).toString();
    const refreshReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    const refreshRes = createMockResponse();
    await handleOAuthToken(refreshReq, asServerResponse(refreshRes));
    expect(refreshRes.statusCode).toBe(400);
    const refreshJson = JSON.parse(refreshRes.body) as { error: string };
    expect(refreshJson.error).toBe("invalid_grant");
  });

  it("returns key scopes when client_credentials omits scope", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_valid",
    }).toString();

    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));

    expect(tokenRes.statusCode).toBe(200);
    const tokenJson = JSON.parse(tokenRes.body) as { scope: string };
    expect(tokenJson.scope).toBe("read write");
  });

  it("returns inactive on introspection for malformed token payload", async () => {
    const introspectReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token: "mcp_at_not-a-valid-payload.signature" }),
    });
    const introspectRes = createMockResponse();
    await handleOAuthIntrospect(introspectReq, asServerResponse(introspectRes));

    expect(introspectRes.statusCode).toBe(200);
    const body = JSON.parse(introspectRes.body) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it("returns inactive on introspection for expired non-revoked token", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "closedloop-mcp",
      client_secret: "sk_live_valid",
      scope: "read",
    }).toString();
    const tokenReq = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    const tokenRes = createMockResponse();
    await handleOAuthToken(tokenReq, asServerResponse(tokenRes));
    expect(tokenRes.statusCode).toBe(200);
    const token = (JSON.parse(tokenRes.body) as { access_token: string })
      .access_token;

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 3_700_000);
    const introspectReq = createMockRequest({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret",
      },
      body: JSON.stringify({ token }),
    });
    const introspectRes = createMockResponse();
    await handleOAuthIntrospect(introspectReq, asServerResponse(introspectRes));
    nowSpy.mockRestore();

    expect(introspectRes.statusCode).toBe(200);
    const body = JSON.parse(introspectRes.body) as { active: boolean };
    expect(body.active).toBe(false);
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

  it("returns 413 when oauth token request body exceeds size limit", async () => {
    const oversizedBody = `grant_type=client_credentials&client_id=closedloop-mcp&client_secret=sk_live_valid&scope=${"x".repeat(5000)}`;
    const req = createMockRequest({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: oversizedBody,
    });
    const res = createMockResponse();
    await handleOAuthToken(req, asServerResponse(res));
    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("payload_too_large");
  });

  it("returns 413 when mcp request content-length exceeds size limit", async () => {
    const req = createMockRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "content-length": "5000",
      },
      body: "{}",
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("payload_too_large");
  });

  it("returns 413 when mcp request body exceeds size limit without content-length", async () => {
    const req = createMockRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk_live_valid",
      },
      body: `{"x":"${"y".repeat(5000)}"}`,
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("payload_too_large");
  });

  it("returns 400 when mcp request body is malformed json", async () => {
    const req = createMockRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk_live_valid",
      },
      body: "{not-json",
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("invalid_request");
  });

  it("accepts authenticated mcp initialize payload and reaches transport path", async () => {
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const req = createMockRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer sk_live_valid",
        "mcp-protocol-version": "2025-03-26",
      },
      body: initializeBody,
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    // In this mocked HTTP harness, MCP transport returns 400 for protocol-level
    // handshake semantics. This assertion verifies auth/body-limit checks pass and
    // request reaches transport handling.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(413);
  });

  it("returns oauth auth challenge for unauthenticated mcp request", async () => {
    const req = createMockRequest({
      method: "GET",
      url: "/mcp",
      headers: {},
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("resource_metadata=");
  });

  it("falls back to stateless handling when session id is unknown", async () => {
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const req = createMockRequest({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer sk_live_valid",
        "mcp-protocol-version": "2025-03-26",
        "mcp-session-id": "missing-session-id",
      },
      body: initializeBody,
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(413);
  });

  it("advertises only code response type in oauth metadata", async () => {
    const req = createMockRequest({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    const res = createMockResponse();
    const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { response_types_supported: string[] };
    expect(json.response_types_supported).toEqual(["code"]);
  });

  it("supports dynamic client registration for loopback redirect URIs", async () => {
    const registerReq = createMockRequest({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: ["http://127.0.0.1:40123/callback"],
      }),
    });
    const registerRes = createMockResponse();
    const registerHandled = await dispatchHttpRequestFn(
      registerReq,
      asServerResponse(registerRes)
    );
    expect(registerHandled).toBe(true);
    expect(registerRes.statusCode).toBe(201);

    const registerBody = JSON.parse(registerRes.body) as {
      client_id: string;
      token_endpoint_auth_method: string;
    };
    expect(registerBody.client_id).toMatch(DYNAMIC_CLIENT_ID_REGEX);
    expect(registerBody.token_endpoint_auth_method).toBe("none");
  });
});
