import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  asServerResponse,
  createMockRequest,
  createMockResponse,
} from "./fixtures/mock-http.js";

const checkApiReachableMock = vi.fn();
const dbQueryRawMock = vi.fn();
const READY_DB_TIMEOUT_ENV_KEY = "MCP_READY_DB_TIMEOUT_MS";
const MCP_SETUP_ENV_KEYS = [
  "INTERNAL_API_SECRET",
  "MCP_OAUTH_CLIENT_ID",
  "MCP_OAUTH_TOKEN_TTL_SECONDS",
  "MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
  "MCP_OAUTH_REDIRECT_URIS",
  "MCP_MAX_REQUEST_BODY_BYTES",
  READY_DB_TIMEOUT_ENV_KEY,
] as const;
const BUILD_IDENTITY_ENV_KEYS = [
  "RELEASE_VERSION",
  "npm_package_version",
  "VERCEL_GIT_COMMIT_SHA",
  "GIT_SHA",
] as const;
const READY_DB_QUERY_STRINGS = ["SELECT 1"] as const;

let forceNextWithDbTxFailure: Error | undefined;
let lastWithDbTxOptions: { maxWait?: number; timeout?: number } | undefined;
let previousSetupEnvValues: ReadonlyArray<
  readonly [string, string | undefined]
>;
let dispatchHttpRequestFn: (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;

vi.mock("../api-client.js", () => ({
  checkApiReachable: checkApiReachableMock,
  createApiClient: vi.fn(() => ({})),
  verifyApiKeyDetailed: vi.fn(),
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
  const dbMock = { $queryRaw: dbQueryRawMock };
  const withDb = Object.assign(
    async <T>(fn: (db: typeof dbMock) => Promise<T> | T): Promise<T> =>
      fn(dbMock),
    {
      tx: async <T>(
        fn: (db: typeof dbMock) => Promise<T>,
        options?: { maxWait?: number; timeout?: number }
      ): Promise<T> => {
        lastWithDbTxOptions = options;
        if (forceNextWithDbTxFailure) {
          const error = forceNextWithDbTxFailure;
          forceNextWithDbTxFailure = undefined;
          throw error;
        }
        return await fn(dbMock);
      },
    }
  );
  return { withDb };
});

beforeEach(async () => {
  previousSetupEnvValues = MCP_SETUP_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const
  );
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  process.env.MCP_OAUTH_CLIENT_ID = "closedloop-mcp";
  process.env.MCP_OAUTH_TOKEN_TTL_SECONDS = "3600";
  process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS = "2592000";
  process.env.MCP_OAUTH_REDIRECT_URIS = "http://localhost:7777/callback";
  process.env.MCP_MAX_REQUEST_BODY_BYTES = "2048";
  Reflect.deleteProperty(process.env, READY_DB_TIMEOUT_ENV_KEY);
  forceNextWithDbTxFailure = undefined;
  lastWithDbTxOptions = undefined;
  dbQueryRawMock.mockReset();
  dbQueryRawMock.mockResolvedValue([{ "?column?": 1 }]);
  checkApiReachableMock.mockReset();
  checkApiReachableMock.mockResolvedValue(true);
  vi.resetModules();
  const mod = await import("../index.js");
  dispatchHttpRequestFn = mod.__testables.dispatchHttpRequest as (
    req: IncomingMessage,
    res: ServerResponse
  ) => Promise<boolean>;
});

afterEach(() => {
  for (const [key, value] of previousSetupEnvValues) {
    setOptionalEnvValue(key, value);
  }
});

describe("HTTP routes", () => {
  it("returns ready when api and db readiness checks pass", async () => {
    dbQueryRawMock.mockImplementation((query: TemplateStringsArray) => {
      if (!isReadyDbQuery(query)) {
        throw new Error("Unexpected readiness query");
      }
      return [{ "?column?": 1 }];
    });

    const { body, statusCode } = await dispatch("GET", "/ready");

    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      status: "ready",
      checks: { api: "reachable", db: "reachable" },
    });
    expect(dbQueryRawMock).toHaveBeenCalledTimes(1);
    expect(getReadyDbQuery()).toMatchObject(READY_DB_QUERY_STRINGS);
    expect(getReadyDbQuery()?.raw).toMatchObject(READY_DB_QUERY_STRINGS);
    expect(lastWithDbTxOptions).toEqual({ maxWait: 2000, timeout: 2000 });
  });

  it("uses ready db timeout defaults and override", async () => {
    expect(await readReadyDbTimeout(undefined)).toEqual({
      statusCode: 200,
      txOptions: { maxWait: 2000, timeout: 2000 },
    });
    expect(await readReadyDbTimeout("not-a-timeout")).toEqual({
      statusCode: 200,
      txOptions: { maxWait: 2000, timeout: 2000 },
    });
    expect(await readReadyDbTimeout("750")).toEqual({
      statusCode: 200,
      txOptions: { maxWait: 750, timeout: 750 },
    });
  });

  it("keeps health liveness-only with resolved build identity", async () => {
    await withBuildIdentityEnv(
      {
        RELEASE_VERSION: "2.3.4",
        VERCEL_GIT_COMMIT_SHA: "abc123def456",
      },
      async () => {
        const { body, statusCode } = await dispatch("GET", "/health");
        const parsedBody = JSON.parse(body);

        expect(statusCode).toBe(200);
        expect(parsedBody).toMatchObject({
          status: "ok",
          version: "2.3.4",
          gitSha: "abc123def456",
        });
        expect(typeof parsedBody.timestamp).toBe("string");
        expect(parsedBody).not.toHaveProperty("checks");
        expect(dbQueryRawMock).not.toHaveBeenCalled();
      }
    );
  });

  it("returns bounded health build identity fallbacks", async () => {
    const unsafeValue = "../secret value";
    const oversizedSemver = `1.2.3-${"a".repeat(500)}`;

    await withBuildIdentityEnv(
      {
        RELEASE_VERSION: oversizedSemver,
        npm_package_version: oversizedSemver,
        VERCEL_GIT_COMMIT_SHA: "a".repeat(41),
        GIT_SHA: unsafeValue,
      },
      async () => {
        const { body, statusCode } = await dispatch("GET", "/health");
        const parsedBody = JSON.parse(body);

        expect(statusCode).toBe(200);
        expect(parsedBody).toMatchObject({
          status: "ok",
          version: "unknown",
          gitSha: "unknown",
        });
        expect(parsedBody.version).not.toBe(oversizedSemver);
        expect(parsedBody.gitSha).not.toBe(unsafeValue);
        expect(dbQueryRawMock).not.toHaveBeenCalled();
      }
    );
  });

  it("returns health when build identity env vars are unset", async () => {
    await withBuildIdentityEnv({}, async () => {
      const { body, statusCode } = await dispatch("GET", "/health");
      const parsedBody = JSON.parse(body);

      expect(statusCode).toBe(200);
      expect(parsedBody).toMatchObject({
        status: "ok",
        version: "unknown",
        gitSha: "unknown",
      });
      expect(typeof parsedBody.timestamp).toBe("string");
      expect(dbQueryRawMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      apiReachable: false,
      dbReachable: true,
      checks: { api: "unreachable", db: "reachable" },
    },
    {
      apiReachable: false,
      dbReachable: false,
      checks: { api: "unreachable", db: "unreachable" },
    },
  ] as const)("keeps readiness separate from health when api=$apiReachable db=$dbReachable", async ({
    apiReachable,
    dbReachable,
    checks,
  }) => {
    checkApiReachableMock.mockResolvedValueOnce(apiReachable);
    if (!dbReachable) {
      dbQueryRawMock.mockRejectedValueOnce(new Error("db unavailable"));
    }

    const { body, statusCode } = await dispatch("GET", "/ready");

    expect(statusCode).toBe(503);
    expect(JSON.parse(body)).toMatchObject({
      status: "not_ready",
      checks,
    });
  });

  it("returns not ready when db readiness times out at transaction boundary", async () => {
    forceNextWithDbTxFailure = new Error("Transaction timed out");

    const { body, statusCode } = await dispatch("GET", "/ready");

    expect(statusCode).toBe(503);
    expect(dbQueryRawMock).not.toHaveBeenCalled();
    expect(lastWithDbTxOptions).toEqual({ maxWait: 2000, timeout: 2000 });
    expect(JSON.parse(body)).toMatchObject({
      status: "not_ready",
      checks: { api: "reachable", db: "unreachable" },
    });
  });
});

async function dispatch(method: string, url: string) {
  const req = createMockRequest({ method, url });
  const res = createMockResponse();
  const handled = await dispatchHttpRequestFn(req, asServerResponse(res));
  return { ...res, handled };
}

async function readReadyDbTimeout(value: string | undefined): Promise<{
  statusCode: number;
  txOptions: { maxWait?: number; timeout?: number } | undefined;
}> {
  const previousValue = process.env[READY_DB_TIMEOUT_ENV_KEY];
  setOptionalEnvValue(READY_DB_TIMEOUT_ENV_KEY, value);
  vi.resetModules();
  const mod = await import("../index.js");
  setOptionalEnvValue(READY_DB_TIMEOUT_ENV_KEY, previousValue);
  dispatchHttpRequestFn = mod.__testables.dispatchHttpRequest as (
    req: IncomingMessage,
    res: ServerResponse
  ) => Promise<boolean>;

  const { statusCode } = await dispatch("GET", "/ready");
  return { statusCode, txOptions: lastWithDbTxOptions };
}

function setOptionalEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function withBuildIdentityEnv<T>(
  values: Partial<Record<(typeof BUILD_IDENTITY_ENV_KEYS)[number], string>>,
  fn: () => Promise<T>
): Promise<T> {
  const previousValues = BUILD_IDENTITY_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const
  );
  try {
    for (const key of BUILD_IDENTITY_ENV_KEYS) {
      setOptionalEnvValue(key, values[key]);
    }
    vi.resetModules();
    const mod = await import("../index.js");
    dispatchHttpRequestFn = mod.__testables.dispatchHttpRequest as (
      req: IncomingMessage,
      res: ServerResponse
    ) => Promise<boolean>;
    return await fn();
  } finally {
    for (const [key, value] of previousValues) {
      setOptionalEnvValue(key, value);
    }
  }
}

function isReadyDbQuery(query: TemplateStringsArray): boolean {
  return (
    query.length === READY_DB_QUERY_STRINGS.length &&
    query[0] === READY_DB_QUERY_STRINGS[0] &&
    query.raw.length === READY_DB_QUERY_STRINGS.length &&
    query.raw[0] === READY_DB_QUERY_STRINGS[0]
  );
}

function getReadyDbQuery(): TemplateStringsArray | undefined {
  return dbQueryRawMock.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
}
