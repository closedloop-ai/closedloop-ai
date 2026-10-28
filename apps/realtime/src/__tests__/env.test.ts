import { generateKeyPairSync } from "node:crypto";
import { EnvValidationError } from "@repo/observability/boot-env";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DRAIN_WINDOW_MS,
  DEFAULT_MAX_CONNECTIONS_PER_ORG,
  DEFAULT_MAX_CONNECTIONS_PER_USER,
  DEFAULT_REALTIME_PORT,
  loadRealtimeEnvOrExit,
  parseRealtimeEnv,
  REALTIME_ENV_INVALID_EVENT,
} from "../env";
import {
  DEFAULT_REALTIME_PG_PORT,
  ListenerAuth,
} from "../signal/listener-config";

const KID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const PUBLIC_KEYS_JSON = JSON.stringify({
  [KID]: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "pem",
  }),
});

const OIDC = {
  REALTIME_INTERNAL_OIDC_ISSUER: "https://oidc.vercel.com/fixture-team",
  REALTIME_INTERNAL_OIDC_AUDIENCE: "realtime-internal-fixture",
  REALTIME_INTERNAL_OIDC_OWNER_ID: "team_fixture",
  REALTIME_INTERNAL_OIDC_PROJECT_ID: "prj_fixture_api",
  REALTIME_INTERNAL_OIDC_ENVIRONMENT: "production",
} as const;
const OIDC_KEYS = Object.keys(OIDC);

/** The minimum the service boots on. */
const REQUIRED = {
  REALTIME_TOKEN_PUBLIC_KEYS: PUBLIC_KEYS_JSON,
  REDIS_URL: "redis://localhost:6379",
  ...OIDC,
} as const;

/** The two retired shared secrets (ISS-11966), in the shape they were set. */
const RETIRED_SECRETS = {
  REALTIME_TOKEN_SECRETS: "realtime-test-secret-0123456789-abcdefgh",
  REALTIME_SERVICE_SECRET: "service-secret",
} as const;

const VALID = {
  ...REQUIRED,
  REALTIME_PG_AUTH: ListenerAuth.Password,
  REALTIME_PG_HOST: "localhost",
  REALTIME_PG_USER: "postgres",
  REALTIME_PG_PASSWORD: "password",
  REALTIME_PG_DATABASE: "closedloop_ai",
} as const;

function issueKeys(source: Record<string, string | undefined>): string[] {
  try {
    parseRealtimeEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.issues.map((issue) => issue.key);
    }
    throw error;
  }
  return [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRealtimeEnv", () => {
  it("parses a complete environment, with defaults for the optional keys", () => {
    const env = parseRealtimeEnv(VALID);

    expect({
      ...env,
      tokenPublicKeys: [...env.tokenPublicKeys.keys()],
    }).toEqual({
      port: DEFAULT_REALTIME_PORT,
      tokenPublicKeys: [KID],
      redisUrl: "redis://localhost:6379",
      allowedOrigins: [],
      pingTimeoutMs: undefined,
      drainWindowMs: DEFAULT_DRAIN_WINDOW_MS,
      ecsMetadataUri: undefined,
      connectionCaps: {
        perUser: DEFAULT_MAX_CONNECTIONS_PER_USER,
        perOrg: DEFAULT_MAX_CONNECTIONS_PER_ORG,
      },
      listener: {
        auth: ListenerAuth.Password,
        host: "localhost",
        port: DEFAULT_REALTIME_PG_PORT,
        user: "postgres",
        password: "password",
        database: "closedloop_ai",
      },
      internalOidc: {
        issuer: "https://oidc.vercel.com/fixture-team",
        audience: "realtime-internal-fixture",
        ownerId: "team_fixture",
        projectId: "prj_fixture_api",
        environment: "production",
      },
    });
  });

  it("reads the optional keys when set", () => {
    const env = parseRealtimeEnv({
      ...VALID,
      REALTIME_ALLOWED_ORIGINS:
        "https://app.example.test, http://localhost:3000",
      REALTIME_PING_TIMEOUT_MS: "90000",
      REALTIME_PORT: "4000",
      DRAIN_WINDOW_MS: "45000",
      ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/abc",
      REALTIME_MAX_CONNECTIONS_PER_USER: "5",
      REALTIME_MAX_CONNECTIONS_PER_ORG: "50",
    });

    expect(env.allowedOrigins).toEqual([
      "https://app.example.test",
      "http://localhost:3000",
    ]);
    expect(env.pingTimeoutMs).toBe(90_000);
    expect(env.port).toBe(4000);
    expect(env.drainWindowMs).toBe(45_000);
    expect(env.ecsMetadataUri).toBe("http://169.254.170.2/v4/abc");
    expect(env.connectionCaps).toEqual({ perUser: 5, perOrg: 50 });
  });

  it.each(Object.keys(REQUIRED))("refuses %s missing or blank", (key) => {
    expect(issueKeys({ ...VALID, [key]: undefined })).toEqual([key]);
    expect(issueKeys({ ...VALID, [key]: "  " })).toEqual([key]);
  });

  it("takes neither retired shared secret in place of the keys that replaced them (ISS-11966)", () => {
    expect(
      issueKeys({
        ...VALID,
        ...RETIRED_SECRETS,
        REALTIME_TOKEN_PUBLIC_KEYS: undefined,
        REALTIME_INTERNAL_OIDC_ISSUER: undefined,
        REALTIME_INTERNAL_OIDC_AUDIENCE: undefined,
        REALTIME_INTERNAL_OIDC_OWNER_ID: undefined,
        REALTIME_INTERNAL_OIDC_PROJECT_ID: undefined,
        REALTIME_INTERNAL_OIDC_ENVIRONMENT: undefined,
      })
    ).toEqual(["REALTIME_TOKEN_PUBLIC_KEYS", ...OIDC_KEYS]);
    expect(() =>
      parseRealtimeEnv({ ...VALID, ...RETIRED_SECRETS })
    ).not.toThrow();
  });

  it.each([
    "REALTIME_PG_AUTH",
    "REALTIME_PG_HOST",
    "REALTIME_PG_USER",
    "REALTIME_PG_DATABASE",
    "REALTIME_PG_PASSWORD",
  ] as const)(
    "refuses %s missing or blank once the listener is configured",
    (key) => {
      expect(issueKeys({ ...VALID, [key]: undefined })).toEqual([key]);
      expect(issueKeys({ ...VALID, [key]: " " })).toEqual([key]);
    }
  );

  it("leaves the listener unconfigured when no REALTIME_PG_* key is set, whatever AWS_REGION says", () => {
    const env = parseRealtimeEnv({ ...REQUIRED, AWS_REGION: "us-east-1" });

    expect(env.listener).toBeUndefined();
    expect(issueKeys({ ...REQUIRED, REALTIME_PG_PORT: "5433" })).toEqual([
      "REALTIME_PG_AUTH",
      "REALTIME_PG_HOST",
      "REALTIME_PG_USER",
      "REALTIME_PG_DATABASE",
      "REALTIME_PG_PASSWORD",
    ]);
  });

  it("reads an IAM listener, which needs AWS_REGION and no password", () => {
    const iam = {
      ...VALID,
      REALTIME_PG_AUTH: ListenerAuth.Iam,
      REALTIME_PG_PASSWORD: undefined,
      REALTIME_PG_PORT: "6543",
    };

    expect(issueKeys(iam)).toEqual(["AWS_REGION"]);
    expect(
      parseRealtimeEnv({ ...iam, AWS_REGION: "us-east-1" }).listener
    ).toEqual({
      auth: ListenerAuth.Iam,
      host: "localhost",
      port: 6543,
      user: "postgres",
      database: "closedloop_ai",
      region: "us-east-1",
    });
  });

  it("keeps the URL-only Redis connection when no REALTIME_REDIS_IAM_* key is set, whatever AWS_REGION says", () => {
    expect(
      parseRealtimeEnv({ ...VALID, AWS_REGION: "us-east-1" }).redisIam
    ).toBeUndefined();
  });

  it("reads Redis IAM auth, which needs both keys, AWS_REGION and a rediss:// REDIS_URL", () => {
    const iam = {
      ...VALID,
      REDIS_URL: "rediss://cache.example.test:6379",
      REALTIME_REDIS_IAM_CACHE_NAME: "example-stage-realtime-cache",
      REALTIME_REDIS_IAM_USER_ID: "example-stage-realtime",
      AWS_REGION: "us-east-1",
    };

    expect(parseRealtimeEnv(iam).redisIam).toEqual({
      cacheName: "example-stage-realtime-cache",
      userId: "example-stage-realtime",
      region: "us-east-1",
    });
    expect(
      issueKeys({ ...iam, REALTIME_REDIS_IAM_USER_ID: undefined })
    ).toEqual(["REALTIME_REDIS_IAM_USER_ID"]);
    expect(issueKeys({ ...iam, REALTIME_REDIS_IAM_CACHE_NAME: "  " })).toEqual([
      "REALTIME_REDIS_IAM_CACHE_NAME",
    ]);
    expect(issueKeys({ ...iam, AWS_REGION: undefined })).toEqual([
      "AWS_REGION",
    ]);
    expect(issueKeys({ ...iam, REDIS_URL: "redis://cache:6379" })).toEqual([
      "REDIS_URL",
    ]);
    expect(
      issueKeys({
        ...iam,
        REALTIME_REDIS_IAM_CACHE_NAME: "Example-Stage-Realtime-Cache",
      })
    ).toEqual(["REALTIME_REDIS_IAM_CACHE_NAME"]);
  });

  it("refuses to boot on a partial Redis IAM config, naming the missing key", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();

    await loadRealtimeEnvOrExit(
      {
        ...VALID,
        REALTIME_REDIS_IAM_CACHE_NAME: "example-stage-realtime-cache",
      },
      { exit, flushLogs: () => Promise.resolve() }
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: REALTIME_ENV_INVALID_EVENT,
        issues: [
          {
            key: "REALTIME_REDIS_IAM_USER_ID",
            message:
              "REALTIME_REDIS_IAM_USER_ID is required once REALTIME_REDIS_IAM_CACHE_NAME or REALTIME_REDIS_IAM_USER_ID is set",
          },
          {
            key: "AWS_REGION",
            message:
              "AWS_REGION is required once REALTIME_REDIS_IAM_CACHE_NAME or REALTIME_REDIS_IAM_USER_ID is set",
          },
          {
            key: "REDIS_URL",
            message:
              "REDIS_URL must be rediss:// when Redis IAM auth is configured",
          },
        ],
      })
    );
  });

  it("refuses a REALTIME_TOKEN_PUBLIC_KEYS value that is not RSA public keys", () => {
    expect(
      issueKeys({
        ...VALID,
        REALTIME_TOKEN_PUBLIC_KEYS: JSON.stringify({ [KID]: "not a pem" }),
      })
    ).toEqual(["REALTIME_TOKEN_PUBLIC_KEYS"]);
  });

  it.each([
    ["REALTIME_ALLOWED_ORIGINS", "https://app.example.test/path"],
    ["REALTIME_PING_TIMEOUT_MS", "soon"],
    ["REALTIME_PORT", "70000"],
    ["REDIS_URL", "not a url"],
    ["DRAIN_WINDOW_MS", "0"],
    ["DRAIN_WINDOW_MS", "2147483648"],
    ["ECS_CONTAINER_METADATA_URI_V4", "not a url"],
    ["REALTIME_MAX_CONNECTIONS_PER_USER", "0"],
    ["REALTIME_MAX_CONNECTIONS_PER_ORG", "1.5"],
    ["REALTIME_PG_AUTH", "trust"],
    ["REALTIME_PG_PORT", "0"],
  ])("refuses an invalid %s", (key, value) => {
    expect(issueKeys({ ...VALID, [key]: value })).toEqual([key]);
  });
});

describe("loadRealtimeEnvOrExit", () => {
  it("logs a structured fatal naming the bad keys, flushes, then exits 1", async () => {
    const order: string[] = [];
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      order.push("log");
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });
    const flushLogs = vi.fn(() => {
      order.push("flush");
      return Promise.resolve();
    });

    const env = await loadRealtimeEnvOrExit(
      { ...VALID, REDIS_URL: "" },
      { exit, flushLogs }
    );

    expect(env).toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual(["log", "flush", "exit"]);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: REALTIME_ENV_INVALID_EVENT,
        fatal: true,
        issues: [expect.objectContaining({ key: "REDIS_URL" })],
      })
    );
  });

  it("refuses to boot without RS256 public keys, though the retired HS256 secret is set", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();

    await loadRealtimeEnvOrExit(
      {
        ...VALID,
        REALTIME_TOKEN_SECRETS: RETIRED_SECRETS.REALTIME_TOKEN_SECRETS,
        REALTIME_TOKEN_PUBLIC_KEYS: undefined,
      },
      { exit, flushLogs: () => Promise.resolve() }
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: REALTIME_ENV_INVALID_EVENT,
        issues: [
          {
            key: "REALTIME_TOKEN_PUBLIC_KEYS",
            message:
              "REALTIME_TOKEN_PUBLIC_KEYS is required and must not be blank",
          },
        ],
      })
    );
  });

  it("returns the parsed environment without exiting when it is valid", async () => {
    const exit = vi.fn();

    const env = await loadRealtimeEnvOrExit(VALID, {
      exit,
      flushLogs: async () => undefined,
    });

    expect(env?.redisUrl).toBe(VALID.REDIS_URL);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("REALTIME_INTERNAL_OIDC_* (ISS-11966)", () => {
  const ON_ECS = {
    ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/abc",
  };

  it("refuses an issuer with a trailing slash, which no token's iss carries", () => {
    expect(
      issueKeys({
        ...VALID,
        REALTIME_INTERNAL_OIDC_ISSUER: "https://oidc.vercel.com/fixture-team/",
      })
    ).toEqual(["REALTIME_INTERNAL_OIDC_ISSUER"]);
  });

  it("refuses a development environment on ECS, and takes it off ECS", () => {
    const development = {
      ...VALID,
      REALTIME_INTERNAL_OIDC_ENVIRONMENT: "development",
    };

    expect(issueKeys({ ...development, ...ON_ECS })).toEqual([
      "REALTIME_INTERNAL_OIDC_ENVIRONMENT",
    ]);
    expect(
      parseRealtimeEnv({ ...VALID, ...ON_ECS }).internalOidc
    ).toBeDefined();
    expect(parseRealtimeEnv(development).internalOidc?.environment).toBe(
      "development"
    );
  });

  it("boots as prod does, on REALTIME_TOKEN_PUBLIC_KEYS, the five claims and Redis IAM auth", async () => {
    const prod = {
      ...VALID,
      ...ON_ECS,
      REDIS_URL: "rediss://cache.example.test:6379",
      REALTIME_REDIS_IAM_CACHE_NAME: "example-prod-realtime-cache",
      REALTIME_REDIS_IAM_USER_ID: "example-prod-realtime",
      AWS_REGION: "us-east-1",
    };
    const exit = vi.fn();

    const env = await loadRealtimeEnvOrExit(prod, {
      exit,
      flushLogs: () => Promise.resolve(),
    });

    expect(exit).not.toHaveBeenCalled();
    expect([...(env?.tokenPublicKeys.keys() ?? [])]).toEqual([KID]);
    expect(env?.internalOidc?.environment).toBe("production");
    expect(env?.redisIam).toEqual({
      cacheName: "example-prod-realtime-cache",
      userId: "example-prod-realtime",
      region: "us-east-1",
    });
    expect(
      issueKeys({ ...prod, REALTIME_TOKEN_PUBLIC_KEYS: undefined })
    ).toEqual(["REALTIME_TOKEN_PUBLIC_KEYS"]);
    expect(
      issueKeys({ ...prod, REALTIME_INTERNAL_OIDC_PROJECT_ID: undefined })
    ).toEqual(["REALTIME_INTERNAL_OIDC_PROJECT_ID"]);
    expect(
      issueKeys({ ...prod, REALTIME_REDIS_IAM_USER_ID: undefined })
    ).toEqual(["REALTIME_REDIS_IAM_USER_ID"]);
  });

  it("refuses to boot without the claims, though the retired service secret is set, naming each key", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();
    const withoutClaims: Record<string, string | undefined> = {
      ...VALID,
      REALTIME_SERVICE_SECRET: RETIRED_SECRETS.REALTIME_SERVICE_SECRET,
    };
    for (const key of OIDC_KEYS) {
      withoutClaims[key] = undefined;
    }

    await loadRealtimeEnvOrExit(withoutClaims, {
      exit,
      flushLogs: () => Promise.resolve(),
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: REALTIME_ENV_INVALID_EVENT,
        issues: OIDC_KEYS.map((key) => ({
          key,
          message: `${key} is required and must not be blank`,
        })),
      })
    );
  });

  it("refuses Vercel's default audience, which AWS STS trusts", () => {
    expect(
      issueKeys({
        ...VALID,
        REALTIME_INTERNAL_OIDC_AUDIENCE: "https://vercel.com/fixture-team",
      })
    ).toEqual(["REALTIME_INTERNAL_OIDC_AUDIENCE"]);
    expect(
      issueKeys({
        ...VALID,
        REALTIME_INTERNAL_OIDC_AUDIENCE: "HTTPS://Vercel.com/fixture-team",
      })
    ).toEqual(["REALTIME_INTERNAL_OIDC_AUDIENCE"]);
  });
});
