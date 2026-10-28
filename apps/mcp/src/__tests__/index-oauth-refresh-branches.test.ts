import { createHash } from "node:crypto";
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
import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
  type MockResponse,
} from "./fixtures/mock-http.js";

// Drives the refresh_token grant through `dispatchHttpRequest` against an
// in-memory Prisma double. The `txRefreshLookupHook` lets a case change the
// stored row between the handler's non-transactional pre-check and the
// transactional re-read inside `rotateRefreshToken`, which is how the
// concurrent-rotation branches are reached in production.

type RefreshRow = {
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
};

type CodeRow = {
  id: string;
  codeFingerprint: string;
  encryptedApiKey: string;
  keyId: string;
  userId: string;
  organizationId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

const state = vi.hoisted(() => ({
  refresh: new Map<string, RefreshRow>(),
  codes: new Map<string, CodeRow>(),
  inTx: false,
  txRefreshLookupHook: undefined as (() => void) | undefined,
  casConflict: undefined as (() => void) | undefined,
  nextId: 0,
}));

const verifyApiKeyDetailedMock = vi.hoisted(() => vi.fn());
const apiKeyFindFirstMock = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

vi.mock("../api-client.js", () => ({
  verifyApiKeyDetailed: verifyApiKeyDetailedMock,
  checkApiReachable: vi.fn(() => true),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("@repo/database", () => {
  const nextId = (prefix: string) => {
    state.nextId += 1;
    return `${prefix}_${state.nextId}`;
  };
  const deleteMany = vi.fn(() => ({ count: 0 }));
  const dbMock = {
    oAuthRevokedToken: {
      deleteMany,
      findUnique: vi.fn(() => null),
      upsert: vi.fn(() => ({})),
    },
    oAuthRateLimit: {
      deleteMany,
      findUnique: vi.fn(() => null),
      upsert: vi.fn(() => ({ id: "rl" })),
      updateMany: vi.fn(() => ({ count: 1 })),
    },
    oAuthAuthorizationCode: {
      deleteMany,
      create: vi.fn(({ data }: { data: CodeRow }) => {
        const row = { ...data, consumedAt: null };
        state.codes.set(data.codeFingerprint, row);
        return row;
      }),
      findUnique: vi.fn(
        ({ where }: { where: { codeFingerprint: string } }) =>
          state.codes.get(where.codeFingerprint) ?? null
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { consumedAt: Date };
        }) => {
          const row = [...state.codes.values()].find((r) => r.id === where.id);
          if (!row || row.consumedAt !== null) {
            return { count: 0 };
          }
          row.consumedAt = data.consumedAt;
          return { count: 1 };
        }
      ),
    },
    oAuthRefreshToken: {
      deleteMany,
      create: vi.fn(
        ({
          data,
        }: {
          data: Omit<
            RefreshRow,
            | "id"
            | "lastUsedAt"
            | "revokedAt"
            | "replacedByTokenId"
            | "createdAt"
          >;
        }) => {
          const row: RefreshRow = {
            ...data,
            id: nextId("rt"),
            lastUsedAt: null,
            revokedAt: null,
            replacedByTokenId: null,
            createdAt: new Date(),
          };
          state.refresh.set(data.tokenFingerprint, row);
          return { id: row.id };
        }
      ),
      findUnique: vi.fn(
        ({ where }: { where: { tokenFingerprint?: string; id?: string } }) => {
          if (where.tokenFingerprint) {
            if (state.inTx && state.txRefreshLookupHook) {
              const hook = state.txRefreshLookupHook;
              state.txRefreshLookupHook = undefined;
              hook();
            }
            return state.refresh.get(where.tokenFingerprint) ?? null;
          }
          // Prisma rejects a null/undefined unique selector; mirror that so a
          // lookup that should have been skipped cannot pass silently.
          if (where.id === undefined || where.id === null) {
            throw new Error("findUnique requires a unique selector");
          }
          return (
            [...state.refresh.values()].find((r) => r.id === where.id) ?? null
          );
        }
      ),
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id?: string; familyId?: string; revokedAt?: null };
          data: Partial<RefreshRow>;
        }) => {
          if (
            state.casConflict &&
            where.id &&
            where.revokedAt === null &&
            data.revokedAt
          ) {
            const conflict = state.casConflict;
            state.casConflict = undefined;
            conflict();
            return { count: 0 };
          }
          let count = 0;
          for (const row of state.refresh.values()) {
            if (where.id && row.id !== where.id) {
              continue;
            }
            if (where.familyId && row.familyId !== where.familyId) {
              continue;
            }
            if (where.revokedAt === null && row.revokedAt !== null) {
              continue;
            }
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        }
      ),
      count: vi.fn(
        ({ where }: { where: { familyId: string } }) =>
          [...state.refresh.values()].filter(
            (r) => r.familyId === where.familyId && r.revokedAt === null
          ).length
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
  "MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
  "MCP_OAUTH_REFRESH_REUSE_GRACE_PERIOD_SECONDS",
] as const;
const CLIENT_ID = "closedloop-mcp";
const REDIRECT_URI = "http://localhost:7777/callback";
const FULL_CONTEXT: VerifiedApiKeyContext = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"],
};
const VALID_KEY = "sk_live_valid";
const REUSE_DETECTED = "Refresh token reuse detected";
const NO_LONGER_VALID = "Refresh token is no longer valid";
const INVALID_OR_EXPIRED = "Invalid or expired refresh token";
const DEFAULT_REFRESH_TTL_SECONDS = 2_592_000;
const GRACE_PERIOD_MS = 10_000;
const FROZEN_NOW = new Date("2026-09-01T12:00:00Z");

let savedEnv: ReadonlyArray<readonly [string, string | undefined]>;
let dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let resetState: () => void;

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function verifiedAs(scopes: string[]) {
  return {
    status: ApiKeyVerificationStatus.Ok,
    context: { ...FULL_CONTEXT, scopes },
  };
}

async function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<MockResponse> {
  const res = createMockResponse();
  await dispatch(
    createMockRequest({ method, url, headers, body }),
    asServerResponse(res)
  );
  return res;
}

function postToken(params: Record<string, string>): Promise<MockResponse> {
  return send(
    "POST",
    "/oauth/token",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams(params).toString()
  );
}

async function obtainRefreshToken(scope = "read write"): Promise<string> {
  const verifier = `verifier-${state.nextId}-${Math.random()}`;
  const url = new URL("http://localhost/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const authorize = await send("GET", `${url.pathname}${url.search}`, {
    authorization: `Bearer ${VALID_KEY}`,
  });
  const code = new URL(authorize.headers.Location).searchParams.get("code");
  const token = await postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: code ?? "",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  return (JSON.parse(token.body) as { refresh_token: string }).refresh_token;
}

function rowFor(token: string): RefreshRow {
  const row = state.refresh.get(fingerprint(token));
  if (!row) {
    throw new Error("refresh row missing");
  }
  return row;
}

function familyRows(familyId: string): RefreshRow[] {
  return [...state.refresh.values()].filter((r) => r.familyId === familyId);
}

function insertReplacement(
  source: RefreshRow,
  overrides: Partial<RefreshRow> = {}
): RefreshRow {
  state.nextId += 1;
  const row: RefreshRow = {
    ...source,
    id: `rt_replacement_${state.nextId}`,
    tokenFingerprint: `fp_replacement_${state.nextId}`,
    revokedAt: null,
    replacedByTokenId: null,
    ...overrides,
  };
  state.refresh.set(row.tokenFingerprint, row);
  return row;
}

function refresh(
  token: string,
  extra: Record<string, string> = {}
): Promise<MockResponse> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: token,
    ...extra,
  });
}

function errorOf(res: MockResponse): {
  error: string;
  error_description: string;
} {
  return JSON.parse(res.body) as { error: string; error_description: string };
}

beforeAll(async () => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.INTERNAL_API_SECRET = "refresh-branches-secret";
  process.env.MCP_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "2048";
  process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS = String(
    DEFAULT_REFRESH_TTL_SECONDS
  );
  process.env.MCP_OAUTH_REFRESH_REUSE_GRACE_PERIOD_SECONDS = String(
    GRACE_PERIOD_MS / 1000
  );
  const mod = await import("../index.js");
  dispatch = mod.__testables.dispatchHttpRequest;
  resetState = mod.__testables.resetInMemorySecurityState;
});

afterEach(() => {
  vi.useRealTimers();
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
  state.refresh.clear();
  state.codes.clear();
  state.txRefreshLookupHook = undefined;
  state.casConflict = undefined;
  logInfo.mockClear();
  apiKeyFindFirstMock.mockReset();
  apiKeyFindFirstMock.mockResolvedValue(null);
  verifyApiKeyDetailedMock.mockReset();
  verifyApiKeyDetailedMock.mockResolvedValue(verifiedAs(["read", "write"]));
});

describe("refresh_token grant pre-checks", () => {
  it("rejects a refresh_token without the mcp_rt_ prefix", async () => {
    const res = await refresh("not-a-refresh-token");
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_request",
      error_description: "refresh_token is required",
    });
  });

  it("rejects an unknown mcp_rt_ token as invalid_grant", async () => {
    const res = await refresh("mcp_rt_unknown");
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_grant",
      error_description: INVALID_OR_EXPIRED,
    });
  });

  it("uses the stored client when client_id is omitted and rotates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    const token = await obtainRefreshToken();
    const res = await refresh(token);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      refresh_token: string;
      refresh_token_expires_in: number;
      scope: string;
    };
    expect(json.refresh_token).not.toBe(token);
    expect(json.scope).toBe("read write");
    expect(json.refresh_token_expires_in).toBe(DEFAULT_REFRESH_TTL_SECONDS);
    expect(rowFor(token).revokedAt).not.toBeNull();
  });

  it("answers invalid_client for a client_id that is neither dyn_ nor the static id", async () => {
    const token = await obtainRefreshToken();
    const res = await refresh(token, { client_id: "rogue-client" });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toEqual({
      error: "invalid_client",
      error_description: "Invalid client_id",
    });
    expect(rowFor(token).revokedAt).toBeNull();
  });

  it("revokes the family when the stored ciphertext no longer decrypts", async () => {
    const token = await obtainRefreshToken();
    const row = rowFor(token);
    row.encryptedApiKey = "not.a.ciphertext";
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(NO_LONGER_VALID);
    expect(row.revokedAt).not.toBeNull();
  });

  it("refuses a scope the refresh grant does not cover without revoking", async () => {
    const token = await obtainRefreshToken("read");
    const res = await refresh(token, { scope: "write" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error).toBe("invalid_scope");
    expect(rowFor(token).revokedAt).toBeNull();
  });

  it("falls back to local verification when upstream throws a non-Error value", async () => {
    const token = await obtainRefreshToken();
    verifyApiKeyDetailedMock.mockRejectedValue("upstream-string-failure");
    apiKeyFindFirstMock.mockResolvedValue({
      id: "key_1",
      userId: FULL_CONTEXT.userId,
      organizationId: FULL_CONTEXT.organizationId,
      scopes: ["read", "write"],
    });
    const res = await refresh(token);
    expect(res.statusCode).toBe(200);
    expect(apiKeyFindFirstMock).toHaveBeenCalledTimes(1);
    const fallbackLog = logInfo.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("oauth-refresh-api-fallback"));
    expect(fallbackLog).toContain("error=upstream-string-failure");
  });
});

describe("refresh_token grant racing rotateRefreshToken", () => {
  it("answers invalid_grant when the row reaches its expiry instant before rotation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    const token = await obtainRefreshToken();
    state.txRefreshLookupHook = () => {
      rowFor(token).expiresAt = new Date(Date.now());
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_grant",
      error_description: INVALID_OR_EXPIRED,
    });
  });

  it("answers invalid_grant when the row's client changes before rotation", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        clientId: "dyn_someone_else",
      });
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token was not issued to this client",
    });
  });

  it("answers invalid_scope when the row's scopes narrow before rotation", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        scopes: ["read"],
      });
    };
    const res = await refresh(token, { scope: "read write" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_scope",
      error_description: "Requested scope exceeds the refresh token grant",
    });
  });

  it("detects reuse when the row is revoked in-grace with no replacement", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const unrelated = insertReplacement(original, { familyId: "other-family" });
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        revokedAt: new Date(),
        replacedByTokenId: null,
      });
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
    expect(unrelated.revokedAt).toBeNull();
  });

  it.each([
    [GRACE_PERIOD_MS, 200],
    [GRACE_PERIOD_MS + 1, 400],
  ])(
    "treats a rotation revoked %i ms earlier as concurrent only inside the grace window (status %i)",
    async (ageMs, expectedStatus) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      const token = await obtainRefreshToken();
      const original = rowFor(token);
      const replacement = insertReplacement(original);
      state.txRefreshLookupHook = () => {
        state.refresh.set(original.tokenFingerprint, {
          ...original,
          revokedAt: new Date(Date.now() - ageMs),
          replacedByTokenId: replacement.id,
        });
      };
      const res = await refresh(token);
      expect(res.statusCode).toBe(expectedStatus);
    }
  );

  it("detects reuse and revokes the family when the in-grace replacement is itself revoked", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const replacement = insertReplacement(original, { revokedAt: new Date() });
    const sibling = insertReplacement(original);
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        revokedAt: new Date(),
        replacedByTokenId: replacement.id,
      });
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
    expect(sibling.revokedAt).not.toBeNull();
  });

  it("issues a concurrent grant when another caller rotated in-grace to a live replacement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const replacement = insertReplacement(original, { scopes: ["read"] });
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        revokedAt: new Date(),
        replacedByTokenId: replacement.id,
      });
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      refresh_token: string;
      refresh_token_expires_in: number;
      scope: string;
    };
    // The concurrent grant carries the replacement's scopes, not the caller's.
    expect(json.scope).toBe("read");
    expect(json.refresh_token_expires_in).toBe(DEFAULT_REFRESH_TTL_SECONDS);
    expect(state.refresh.has(fingerprint(json.refresh_token))).toBe(true);
    expect(
      logInfo.mock.calls.some((call) =>
        String(call[0]).includes("oauth-refresh-concurrent")
      )
    ).toBe(true);
  });

  it("refuses the concurrent grant when the requested scope exceeds the replacement", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const replacement = insertReplacement(original, { scopes: ["read"] });
    state.txRefreshLookupHook = () => {
      state.refresh.set(original.tokenFingerprint, {
        ...original,
        revokedAt: new Date(),
        replacedByTokenId: replacement.id,
      });
    };
    const res = await refresh(token, { scope: "write" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      error: "invalid_grant",
      error_description: NO_LONGER_VALID,
    });
    expect(familyRows(original.familyId)).toHaveLength(2);
  });

  it("follows the CAS winner's replacement when the revoke update loses the race", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const replacement = insertReplacement(original);
    state.casConflict = () => {
      original.revokedAt = new Date();
      original.replacedByTokenId = replacement.id;
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { scope: string };
    expect(json.scope).toBe("read write");
  });

  it("detects reuse when the CAS loses and the re-read shows no revocation", async () => {
    const token = await obtainRefreshToken();
    const original = rowFor(token);
    const unrelated = insertReplacement(original, { familyId: "other-family" });
    state.casConflict = () => undefined;
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
    expect(original.revokedAt).not.toBeNull();
    expect(unrelated.revokedAt).toBeNull();
  });

  it("detects reuse when the CAS loses and the row is gone on re-read", async () => {
    const token = await obtainRefreshToken();
    state.casConflict = () => {
      state.refresh.delete(fingerprint(token));
    };
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });
});

describe("refresh_token grant reusing a rotated token inside the grace window", () => {
  async function rotateOnce(scope = "read write") {
    const token = await obtainRefreshToken(scope);
    const first = await refresh(token);
    const replacementToken = (
      JSON.parse(first.body) as { refresh_token: string }
    ).refresh_token;
    return {
      token,
      original: rowFor(token),
      replacement: rowFor(replacementToken),
    };
  }

  it("accepts a subset requested scope but grants the full replacement scope", async () => {
    const { token } = await rotateOnce();
    const res = await refresh(token, { scope: "read" });
    expect(res.statusCode).toBe(200);
    // pins current behavior; looks odd because issueConcurrentGrant only
    // validates the requested scope and never narrows the grant to it, while
    // the normal rotation path returns exactly the requested subset.
    expect((JSON.parse(res.body) as { scope: string }).scope).toBe(
      "read write"
    );
  });

  it("treats a whitespace-only requested scope as no request", async () => {
    const { token } = await rotateOnce();
    const res = await refresh(token, { scope: " " });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { scope: string }).scope).toBe(
      "read write"
    );
  });

  it("detects reuse when the requested scope exceeds the replacement grant", async () => {
    const { token } = await rotateOnce("read");
    const res = await refresh(token, { scope: "read write" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });

  it("detects reuse once the family already holds the maximum active tokens", async () => {
    const { token, original } = await rotateOnce();
    const second = await refresh(token);
    expect(second.statusCode).toBe(200);
    const third = await refresh(token);
    expect(third.statusCode).toBe(400);
    expect(errorOf(third).error_description).toBe(REUSE_DETECTED);
    expect(
      familyRows(original.familyId).every((row) => row.revokedAt !== null)
    ).toBe(true);
  });

  it("detects reuse for a token revoked in-grace that names no replacement", async () => {
    const token = await obtainRefreshToken();
    const row = rowFor(token);
    row.revokedAt = new Date();
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });

  it("detects reuse when the replacement has since been revoked", async () => {
    const { token, replacement } = await rotateOnce();
    replacement.revokedAt = new Date();
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });

  it("detects reuse and revokes the family when the rotated row no longer decrypts", async () => {
    const { token, original, replacement } = await rotateOnce();
    original.encryptedApiKey = "broken";
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
    expect(replacement.revokedAt).not.toBeNull();
  });

  it("detects reuse when the key is rejected upstream", async () => {
    const { token, replacement } = await rotateOnce();
    verifyApiKeyDetailedMock.mockResolvedValue({
      status: ApiKeyVerificationStatus.Invalid,
    });
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
    expect(replacement.revokedAt).not.toBeNull();
  });

  it("detects reuse when the key's stored scopes no longer resolve", async () => {
    const { token } = await rotateOnce();
    verifyApiKeyDetailedMock.mockResolvedValue(verifiedAs([]));
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });

  it("detects reuse when the key no longer overlaps the replacement grant", async () => {
    const { token } = await rotateOnce("write");
    verifyApiKeyDetailedMock.mockResolvedValue(verifiedAs(["read"]));
    const res = await refresh(token);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).error_description).toBe(REUSE_DETECTED);
  });
});
