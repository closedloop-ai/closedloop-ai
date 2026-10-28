import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import {
  ApiKeyVerificationStatus,
  type VerifiedApiKeyContext,
} from "../api-key-contract.js";
import { UNRESOLVABLE_KEY_SCOPES_DESCRIPTION } from "../oauth-scopes.js";
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
  type MockRequestOptions,
  type MockResponse,
} from "./fixtures/mock-http.js";

// Drives the authorize, authorization_code, client_credentials, introspect,
// revoke, and token-endpoint parsing branches through `dispatchHttpRequest`
// against an in-memory Prisma double.

type CodeRow = {
  id: string;
  codeFingerprint: string;
  encryptedApiKey: string;
  keyId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

const state = vi.hoisted(() => ({
  codes: new Map<string, CodeRow>(),
  revoked: new Map<string, Date>(),
  refresh: new Map<string, { familyId: string; revokedAt: Date | null }>(),
  inTx: false,
  txCodeLookupHook: undefined as (() => void) | undefined,
  consumeConflict: false,
  rateLimitExhausted: false,
  rateLimitBuckets: [] as string[],
}));

const verifyApiKeyDetailedMock = vi.hoisted(() => vi.fn());
const apiKeyFindFirstMock = vi.hoisted(() => vi.fn());

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
      findUnique: vi.fn(
        ({ where }: { where: { bucket_subject: { bucket: string } } }) => {
          state.rateLimitBuckets.push(where.bucket_subject.bucket);
          return state.rateLimitExhausted
            ? { id: "rl", windowExpiresAt: new Date(Date.now() + 30_000) }
            : null;
        }
      ),
      upsert: vi.fn(() => ({ id: "rl" })),
      updateMany: vi.fn(() => ({ count: 0 })),
    },
    oAuthAuthorizationCode: {
      deleteMany,
      create: vi.fn(({ data }: { data: CodeRow }) => {
        state.codes.set(data.codeFingerprint, { ...data, consumedAt: null });
        return data;
      }),
      findUnique: vi.fn(({ where }: { where: { codeFingerprint: string } }) => {
        if (state.inTx && state.txCodeLookupHook) {
          const hook = state.txCodeLookupHook;
          state.txCodeLookupHook = undefined;
          hook();
        }
        return state.codes.get(where.codeFingerprint) ?? null;
      }),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { consumedAt: Date };
        }) => {
          if (state.consumeConflict) {
            return { count: 0 };
          }
          const row = [...state.codes.values()].find((r) => r.id === where.id);
          if (row) {
            row.consumedAt = data.consumedAt;
          }
          return { count: row ? 1 : 0 };
        }
      ),
    },
    oAuthRefreshToken: {
      deleteMany,
      create: vi.fn(
        ({
          data,
        }: {
          data: { tokenFingerprint: string; familyId: string };
        }) => {
          state.refresh.set(data.tokenFingerprint, {
            familyId: data.familyId,
            revokedAt: null,
          });
          return { id: data.tokenFingerprint };
        }
      ),
      findUnique: vi.fn(
        ({ where }: { where: { tokenFingerprint: string } }) => {
          const row = state.refresh.get(where.tokenFingerprint);
          return row ? { ...row } : null;
        }
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { familyId: string };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const row of state.refresh.values()) {
            if (row.familyId === where.familyId && row.revokedAt === null) {
              row.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }
      ),
    },
    apiKey: {
      findFirst: apiKeyFindFirstMock,
      update: vi.fn(() => ({})),
    },
  };
  const withDb = Object.assign(
    async <T>(fn: (db: typeof dbMock) => Promise<T> | T): Promise<T> =>
      fn(dbMock),
    {
      tx: async <T>(fn: (db: typeof dbMock) => Promise<T>): Promise<T> => {
        state.inTx = true;
        try {
          return await fn(dbMock);
        } finally {
          state.inTx = false;
        }
      },
    }
  );
  return { withDb };
});

const ENV_KEYS = [
  "INTERNAL_API_SECRET",
  "MCP_OAUTH_CLIENT_ID",
  "MCP_MAX_REQUEST_BODY_BYTES",
  "MCP_OAUTH_REDIRECT_URIS",
] as const;
const SECRET = "grants-branches-secret";
const CLIENT_ID = "closedloop-mcp";
const REDIRECT_URI = "http://localhost:7777/callback";
const VALID_KEY = "sk_live_valid";
const FULL_CONTEXT: VerifiedApiKeyContext = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"],
};
const INTERNAL_HEADERS = {
  "content-type": "application/json",
  "x-internal-secret": SECRET,
};
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const OVERSIZED_BODY = JSON.stringify({ token: "x".repeat(4096) });
const INVALID_API_KEY_FORM_MESSAGE = "Invalid API key. Please try again.";
const REJECTED_API_KEY_FORM_MESSAGE =
  "Invalid API key. Please check and try again.";
const UNAVAILABLE_FORM_MESSAGE =
  "Unable to verify API key right now. Please try again.";
const METHOD_NOT_ALLOWED = { error: "Method not allowed" };
const PAYLOAD_TOO_LARGE = {
  error: "payload_too_large",
  error_description: "Request body exceeds 2048 bytes",
};
const BODY_READ_FAILURE = new Error("socket reset while reading body");
const AUTH_CODE_PATTERN = /^mcp_ac_/;
const ACCESS_TOKEN_PATTERN = /^mcp_at_/;

let savedEnv: ReadonlyArray<readonly [string, string | undefined]>;
let dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let resetState: () => void;

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

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

async function send(options: MockRequestOptions): Promise<MockResponse> {
  const res = createMockResponse();
  await dispatch(createMockRequest(options), asServerResponse(res));
  return res;
}

function sendWithBrokenBody(
  method: string,
  url: string,
  headers: Record<string, string>
): Promise<boolean> {
  const req = Object.assign(createMockRequest({ method, url, headers }), {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(BODY_READ_FAILURE),
    }),
  });
  return dispatch(req, asServerResponse(createMockResponse()));
}

function postToken(params: Record<string, string>): Promise<MockResponse> {
  return send({
    method: "POST",
    url: "/oauth/token",
    headers: FORM,
    body: new URLSearchParams(params).toString(),
  });
}

function postInternal(path: string, body: unknown): Promise<MockResponse> {
  return send({
    method: "POST",
    url: path,
    headers: INTERNAL_HEADERS,
    body: JSON.stringify(body),
  });
}

function authorizeUrl(overrides: Record<string, string | null> = {}): string {
  const url = new URL("http://localhost/oauth/authorize");
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challengeFor("verifier"),
    code_challenge_method: "S256",
    state: "st-1",
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}`;
}

function authorizeGet(
  overrides: Record<string, string | null> = {}
): Promise<MockResponse> {
  return send({
    method: "GET",
    url: authorizeUrl(overrides),
    headers: { authorization: `Bearer ${VALID_KEY}` },
  });
}

function redirectParams(res: MockResponse): URLSearchParams {
  return new URL(res.headers.Location).searchParams;
}

async function issueCode(scope = "read write"): Promise<string> {
  const res = await authorizeGet({ scope });
  return redirectParams(res).get("code") ?? "";
}

function exchangeCode(
  code: string,
  extra: Record<string, string> = {}
): Promise<MockResponse> {
  return postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: "verifier",
    ...extra,
  });
}

async function issueAccessToken(): Promise<string> {
  const res = await postToken({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: VALID_KEY,
  });
  return (JSON.parse(res.body) as { access_token: string }).access_token;
}

function codeRow(code: string): CodeRow {
  const row = state.codes.get(fingerprint(code));
  if (!row) {
    throw new Error("code row missing");
  }
  return row;
}

function jsonOf(res: MockResponse): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

beforeAll(async () => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.MCP_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "2048";
  Reflect.deleteProperty(process.env, "MCP_OAUTH_REDIRECT_URIS");
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
  state.codes.clear();
  state.revoked.clear();
  state.refresh.clear();
  state.txCodeLookupHook = undefined;
  state.consumeConflict = false;
  state.rateLimitExhausted = false;
  state.rateLimitBuckets = [];
  apiKeyFindFirstMock.mockReset();
  apiKeyFindFirstMock.mockResolvedValue(null);
  verifyApiKeyDetailedMock.mockReset();
  verifyApiKeyDetailedMock.mockImplementation(async (key: string) =>
    key === VALID_KEY
      ? { status: ApiKeyVerificationStatus.Ok, context: FULL_CONTEXT }
      : { status: ApiKeyVerificationStatus.Invalid }
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET/POST /oauth/authorize", () => {
  it("rejects methods other than GET and POST with 405", async () => {
    const res = await send({ method: "PUT", url: authorizeUrl() });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
  });

  it("answers 429 with Retry-After when the authorize bucket is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    state.rateLimitExhausted = true;
    const res = await authorizeGet();
    expect(res.statusCode).toBe(429);
    expect(jsonOf(res).error).toBe("rate_limited");
    expect(res.headers["Retry-After"]).toBe("30");
  });

  it("accepts a sk_live_ api_key posted in the form body", async () => {
    const res = await send({
      method: "POST",
      url: authorizeUrl({ scope: "read" }),
      headers: FORM,
      body: new URLSearchParams({ api_key: VALID_KEY }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(redirectParams(res).get("code")).toMatch(AUTH_CODE_PATTERN);
  });

  it("re-renders the form when the posted api_key lacks the sk_live_ prefix", async () => {
    const res = await send({
      method: "POST",
      url: authorizeUrl(),
      headers: FORM,
      body: new URLSearchParams({ api_key: "pk_nope" }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(INVALID_API_KEY_FORM_MESSAGE);
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("answers 401 JSON on GET and re-renders the form on POST for a rejected key", async () => {
    const getRes = await send({
      method: "GET",
      url: authorizeUrl(),
      headers: { authorization: "Bearer sk_live_rejected" },
    });
    expect(getRes.statusCode).toBe(401);
    expect(jsonOf(getRes)).toEqual({
      error: "invalid_client",
      error_description: "Invalid API key",
    });

    const postRes = await send({
      method: "POST",
      url: authorizeUrl(),
      headers: FORM,
      body: new URLSearchParams({ api_key: "sk_live_rejected" }).toString(),
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.body).toContain(REJECTED_API_KEY_FORM_MESSAGE);
  });

  it("answers 503 on GET and re-renders the form on POST when verification cannot run", async () => {
    verifyApiKeyDetailedMock.mockRejectedValue(new Error("api down"));
    apiKeyFindFirstMock.mockRejectedValue(new Error("db down"));
    const getRes = await authorizeGet();
    expect(getRes.statusCode).toBe(503);
    expect(jsonOf(getRes).error).toBe("temporarily_unavailable");

    const postRes = await send({
      method: "POST",
      url: authorizeUrl(),
      headers: FORM,
      body: new URLSearchParams({ api_key: VALID_KEY }).toString(),
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.body).toContain(UNAVAILABLE_FORM_MESSAGE);
  });

  it("allows a non-loopback redirect_uri when no allowlist is configured in a local env", async () => {
    const redirect = "https://client.example.com/cb";
    const res = await authorizeGet({ redirect_uri: redirect });
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location.startsWith(redirect)).toBe(true);
    expect(redirectParams(res).get("code")).toMatch(AUTH_CODE_PATTERN);
  });

  it.each([
    [
      { response_type: "token" },
      "unsupported_response_type",
      "Only response_type=code is supported",
    ],
    [{ client_id: "rogue" }, "unauthorized_client", "Invalid client_id"],
    [
      { code_challenge: null },
      "invalid_request",
      "code_challenge and code_challenge_method=S256 are required",
    ],
    [
      { scope: "admin" },
      "invalid_scope",
      "None of the requested scopes are granted for this key",
    ],
  ])("redirects %o back with %s", async (overrides, error, description) => {
    const res = await authorizeGet(overrides);
    expect(res.statusCode).toBe(302);
    const params = redirectParams(res);
    expect(params.get("error")).toBe(error);
    expect(params.get("error_description")).toBe(description);
    expect(params.get("state")).toBe("st-1");
    expect(state.codes.size).toBe(0);
  });

  it("redirects invalid_scope with the reissue remedy when the key's scopes are unresolvable", async () => {
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Ok,
      context: { ...FULL_CONTEXT, scopes: [] },
    });
    const res = await authorizeGet();
    expect(redirectParams(res).get("error_description")).toBe(
      UNRESOLVABLE_KEY_SCOPES_DESCRIPTION
    );
  });
});

describe("client_credentials grant", () => {
  it("answers invalid_client for an unrecognised client_id", async () => {
    const res = await postToken({
      grant_type: "client_credentials",
      client_id: "rogue",
      client_secret: VALID_KEY,
    });
    expect(res.statusCode).toBe(401);
    expect(jsonOf(res).error).toBe("invalid_client");
  });

  it("answers invalid_client when the secret is not an sk_live_ key", async () => {
    const res = await postToken({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: "pk_nope",
    });
    expect(res.statusCode).toBe(401);
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });
});

describe("authorization_code grant", () => {
  it("requires both code and code_verifier", async () => {
    const res = await postToken({
      grant_type: "authorization_code",
      code: "x",
    });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res).error_description).toBe(
      "code and code_verifier are required"
    );
  });

  it("defaults client_id and redirect_uri to the stored code values", async () => {
    const code = await issueCode();
    const res = await exchangeCode(code);
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res).scope).toBe("read write");
    expect(codeRow(code).consumedAt).not.toBeNull();
  });

  it("rejects a valid dyn_ client that the code was not issued to", async () => {
    const code = await issueCode();
    const res = await exchangeCode(code, { client_id: "dyn_other" });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res).error_description).toBe(
      "Authorization code was not issued to this client"
    );
  });

  it("rejects a code whose stored key id is unknown", async () => {
    const code = await issueCode();
    codeRow(code).keyId = "unknown-kid";
    const res = await exchangeCode(code);
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res).error_description).toBe(
      "Authorization code is no longer valid"
    );
  });

  it("rejects a code whose ciphertext is not three segments", async () => {
    const code = await issueCode();
    codeRow(code).encryptedApiKey = "only.two";
    const res = await exchangeCode(code);
    expect(jsonOf(res).error_description).toBe(
      "Authorization code is no longer valid"
    );
  });

  it("rejects the code when its key has since been revoked upstream", async () => {
    const code = await issueCode();
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Invalid,
    });
    const res = await exchangeCode(code);
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res)).toEqual({
      error: "invalid_grant",
      error_description: "Authorization code is no longer valid",
    });
    expect(codeRow(code).consumedAt).toBeNull();
  });

  it("rejects the code when it was consumed between pre-check and the transaction", async () => {
    const code = await issueCode();
    state.txCodeLookupHook = () => {
      codeRow(code).consumedAt = new Date();
    };
    const res = await exchangeCode(code);
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res).error_description).toBe(
      "Invalid or expired authorization code"
    );
    expect(state.refresh.size).toBe(0);
  });

  it("rejects the code when the consume update loses the race", async () => {
    const code = await issueCode();
    state.consumeConflict = true;
    const res = await exchangeCode(code);
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res).error_description).toBe(
      "Invalid or expired authorization code"
    );
    expect(state.refresh.size).toBe(0);
  });
});

describe("POST /oauth/token request parsing", () => {
  it.each([
    "/oauth/token",
    "/internal/oauth/introspect",
    "/internal/oauth/revoke",
  ])("rejects GET %s with 405 and Allow: POST", async (url) => {
    const res = await send({ method: "GET", url });
    expect(res.statusCode).toBe(405);
    expect(jsonOf(res)).toEqual(METHOD_NOT_ALLOWED);
    expect(res.headers.Allow).toBe("POST");
  });

  it("answers 429 on the token bucket when it is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    state.rateLimitExhausted = true;
    const res = await postToken({ grant_type: "password" });
    expect(res.statusCode).toBe(429);
    expect(jsonOf(res)).toEqual({
      error: "rate_limited",
      error_description: "Too many token requests",
    });
    expect(res.headers["Retry-After"]).toBe("30");
    expect(state.rateLimitBuckets).toEqual(["token"]);
  });

  it("rejects a request without a content-type with 415", async () => {
    const res = await send({ method: "POST", url: "/oauth/token" });
    expect(res.statusCode).toBe(415);
    expect(jsonOf(res)).toEqual({
      error:
        "Unsupported Media Type. Expected: application/x-www-form-urlencoded or application/json",
    });
  });

  it("answers 413 for an oversized form body", async () => {
    const res = await send({
      method: "POST",
      url: "/oauth/token",
      headers: FORM,
      body: `grant_type=${"x".repeat(4096)}`,
    });
    expect(res.statusCode).toBe(413);
    expect(jsonOf(res)).toEqual(PAYLOAD_TOO_LARGE);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await send({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res)).toEqual({
      error: "invalid_request",
      error_description: "Malformed JSON request body",
    });
  });

  it("accepts a JSON body for client_credentials", async () => {
    const res = await send({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: VALID_KEY,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(String(jsonOf(res).access_token)).toMatch(ACCESS_TOKEN_PATTERN);
  });

  it("answers unsupported_grant_type for an unknown grant", async () => {
    const res = await postToken({ grant_type: "password" });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res)).toEqual({
      error: "unsupported_grant_type",
      error_description:
        "Supported grant types are client_credentials, authorization_code, and refresh_token",
    });
  });

  it("propagates a body read failure that is not a size violation", async () => {
    await expect(sendWithBrokenBody("POST", "/oauth/token", FORM)).rejects.toBe(
      BODY_READ_FAILURE
    );
  });
});

describe("POST /internal/oauth/introspect", () => {
  it("answers 413 for an oversized body and rethrows other read failures", async () => {
    const res = await send({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: INTERNAL_HEADERS,
      body: OVERSIZED_BODY,
    });
    expect(res.statusCode).toBe(413);
    expect(jsonOf(res)).toEqual(PAYLOAD_TOO_LARGE);
    await expect(
      sendWithBrokenBody("POST", "/internal/oauth/introspect", INTERNAL_HEADERS)
    ).rejects.toBe(BODY_READ_FAILURE);
  });

  it.each([
    ["an empty body", ""],
    ["a body without token", "{}"],
    ["a token without the mcp_at_ prefix", JSON.stringify({ token: "abc" })],
  ])("requires an mcp_at_ token, rejecting %s", async (_label, body) => {
    const res = await send({
      method: "POST",
      url: "/internal/oauth/introspect",
      headers: INTERNAL_HEADERS,
      body,
    });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res)).toEqual({
      error: "invalid_request",
      error_description: "JSON body with token is required",
    });
  });

  it("reports inactive for a token that is not payload.signature", async () => {
    const res = await postInternal("/internal/oauth/introspect", {
      token: "mcp_at_onlyonepart",
    });
    expect(jsonOf(res)).toEqual({ active: false });
  });

  it("reports inactive when the signed ciphertext does not decrypt", async () => {
    const payload = decodeAccessToken(await issueAccessToken());
    const token = signAccessToken({ ...payload, apiKeyCiphertext: "bad" });
    verifyApiKeyDetailedMock.mockClear();
    const res = await postInternal("/internal/oauth/introspect", { token });
    expect(jsonOf(res)).toEqual({ active: false });
    expect(verifyApiKeyDetailedMock).not.toHaveBeenCalled();
  });

  it("reports inactive when the backing key is now rejected", async () => {
    const token = await issueAccessToken();
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Invalid,
    });
    const res = await postInternal("/internal/oauth/introspect", { token });
    expect(jsonOf(res)).toEqual({ active: false });
  });

  it("resolves a token without kid or iat to the matching key and the current time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const {
      kid: _kid,
      iat: _iat,
      ...rest
    } = decodeAccessToken(await issueAccessToken());
    vi.setSystemTime(new Date("2026-09-01T00:00:30Z"));
    const res = await postInternal("/internal/oauth/introspect", {
      token: signAccessToken(rest),
    });
    expect(jsonOf(res)).toEqual({
      active: true,
      token_type: "Bearer",
      scope: "read write",
      exp: rest.exp,
      iat: Math.floor(Date.parse("2026-09-01T00:00:30Z") / 1000),
      user_id: FULL_CONTEXT.userId,
      organization_id: FULL_CONTEXT.organizationId,
    });
  });
});

describe("POST /internal/oauth/revoke", () => {
  it("answers 413 for an oversized body and rethrows other read failures", async () => {
    const res = await send({
      method: "POST",
      url: "/internal/oauth/revoke",
      headers: INTERNAL_HEADERS,
      body: OVERSIZED_BODY,
    });
    expect(res.statusCode).toBe(413);
    expect(jsonOf(res)).toEqual(PAYLOAD_TOO_LARGE);
    await expect(
      sendWithBrokenBody("POST", "/internal/oauth/revoke", INTERNAL_HEADERS)
    ).rejects.toBe(BODY_READ_FAILURE);
  });

  it.each([
    ["an empty body", ""],
    ["an unprefixed token", JSON.stringify({ token: "abc" })],
  ])(
    "requires an access or refresh token, rejecting %s",
    async (_label, body) => {
      const res = await send({
        method: "POST",
        url: "/internal/oauth/revoke",
        headers: INTERNAL_HEADERS,
        body,
      });
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res)).toEqual({
        error: "invalid_request",
        error_description: "JSON body with access or refresh token is required",
      });
    }
  );

  it("rejects an access token whose signature does not verify", async () => {
    const res = await postInternal("/internal/oauth/revoke", {
      token: "mcp_at_payload.badsignature",
    });
    expect(res.statusCode).toBe(400);
    expect(jsonOf(res)).toEqual({
      error: "invalid_request",
      error_description: "Invalid token",
    });
    expect(state.revoked.size).toBe(0);
  });

  it("answers 200 for an unknown refresh token without touching any family", async () => {
    state.refresh.set("unrelated-fp", {
      familyId: "unrelated-family",
      revokedAt: null,
    });
    const res = await postInternal("/internal/oauth/revoke", {
      token: "mcp_rt_unknown",
    });
    expect(jsonOf(res)).toEqual({ revoked: true, token_type: "refresh_token" });
    expect(state.refresh.get("unrelated-fp")).toEqual({
      familyId: "unrelated-family",
      revokedAt: null,
    });
  });
});
