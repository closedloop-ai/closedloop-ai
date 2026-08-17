import {
  DbHealthAuthMode,
  DbHealthCheckStatus,
  DbHealthHostType,
  DbHealthSource,
  DbHealthSslMode,
  DbHealthTransportError,
} from "@repo/api/src/types/db-health";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabaseTransportPosture, withDb } from "../index";
import {
  DB_POOL_ACQUIRE_TIMEOUT_MS,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
  DB_POOL_MAX_IAM,
} from "../pool-config";

const ENV_KEYS = [
  "ALLOW_INSECURE_SSL",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "DATABASE_URL",
  "PGDATABASE",
  "PGHOST",
  "PGPORT",
  "PGSCHEMA",
  "PGUSER",
] as const;

const mocks = vi.hoisted(() => {
  const poolConfigs: unknown[] = [];

  // Exposes `on`/`connect`/`options` because getPool() now instruments the pool
  // (FEA-3300): it binds acquire/release/remove listeners and wraps `connect`.
  // A plain class would throw "pool.on is not a function" and fail every case in
  // this file, including the TLS assertions below.
  class MockPool {
    options: { max: number };

    totalCount = 0;

    idleCount = 0;

    waitingCount = 0;

    constructor(config: unknown) {
      poolConfigs.push(config);
      // Mirrors pg-pool's own default resolution (`max || poolSize || 10`), so
      // the DATABASE_URL branch reports 10 and the IAM branch its explicit 20.
      const max = (config as { max?: number } | undefined)?.max;
      this.options = { max: max || 10 };
    }

    on() {
      return this;
    }

    connect(cb?: (err: unknown, client: unknown, done: () => void) => void) {
      const client = { release: () => undefined };
      if (typeof cb === "function") {
        cb(null, client, () => undefined);
        return;
      }
      return Promise.resolve(client);
    }
  }

  class MockPrismaPg {
    pool: unknown;

    options: unknown;

    constructor(pool: unknown, options?: unknown) {
      this.pool = pool;
      this.options = options;
    }
  }

  class MockPrismaClient {
    adapter: unknown;

    constructor(options: { adapter: unknown }) {
      this.adapter = options.adapter;
    }
  }

  return {
    getAuthToken: vi.fn(async () => "iam-token"),
    poolConfigs,
    MockPool,
    MockPrismaClient,
    MockPrismaPg,
  };
});

vi.mock("pg", () => ({
  default: {
    Pool: mocks.MockPool,
  },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: mocks.MockPrismaPg,
}));

vi.mock("../generated/client", () => ({
  PrismaClient: mocks.MockPrismaClient,
}));

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: vi.fn(() => ({
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
  })),
}));

vi.mock("@aws-sdk/rds-signer", () => ({
  Signer: class MockSigner {
    getAuthToken = mocks.getAuthToken;
  },
}));

describe("withDb runtime pool TLS policy", () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    mocks.poolConfigs.length = 0;
    mocks.getAuthToken.mockClear();
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]])
    );
    resetDatabaseGlobals();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    resetDatabaseGlobals();
    vi.clearAllMocks();
  });

  it("passes verified TLS with CA material to the IAM pool branch", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGDATABASE = "app";
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "app_user";

    let capturedDb: unknown;
    await withDb((db) => {
      capturedDb = db;
      return null;
    });

    expect(capturedDb).toBeInstanceOf(mocks.MockPrismaClient);
    expect(mocks.poolConfigs).toHaveLength(1);
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({
        ssl: expect.objectContaining({ rejectUnauthorized: true }),
      })
    );
    const config = mocks.poolConfigs[0] as {
      ssl: { rejectUnauthorized: boolean; ca?: string[] };
    };
    expect(config.ssl).toEqual(
      expect.objectContaining({ rejectUnauthorized: true })
    );
    const ca = config.ssl.ca;
    expect(Array.isArray(ca)).toBe(true);
    if (!Array.isArray(ca)) {
      throw new Error("expected IAM pool SSL CA list");
    }
    expect(ca.length).toBeGreaterThan(0);
  });

  it("reports DATABASE_URL RDS verified TLS posture", () => {
    process.env.DATABASE_URL =
      "postgresql://user:pass@stage-db.abc123.us-east-1.rds.amazonaws.com:5432/app";
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");

    expect(getDatabaseTransportPosture()).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Verified,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: true,
    });
  });

  it("reports unknown posture for invalid DATABASE_URL", () => {
    process.env.DATABASE_URL = "not a url";
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");

    expect(getDatabaseTransportPosture()).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Unknown,
      sslMode: DbHealthSslMode.Unknown,
      error: DbHealthTransportError.UnknownPosture,
    });
  });

  it("uses disabled TLS for IPv6 localhost DATABASE_URL pool and posture", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@[::1]:5432/app";
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");

    expect(getDatabaseTransportPosture()).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Localhost,
      sslMode: DbHealthSslMode.Disabled,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: false,
      error: DbHealthTransportError.TlsDisabled,
    });

    await withDb(() => null);

    expect(mocks.poolConfigs).toHaveLength(1);
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({
        ssl: false,
      })
    );
  });

  it("reports PGHOST/IAM insecure posture when ALLOW_INSECURE_SSL is enabled", () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    process.env.ALLOW_INSECURE_SSL = "1";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGDATABASE = "app";
    process.env.PGHOST = "stage-db.abc123.us-east-1.rds.amazonaws.com";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "app_user";

    expect(getDatabaseTransportPosture()).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Insecure,
      authMode: DbHealthAuthMode.Iam,
      source: DbHealthSource.PgHostIam,
      verifiedRdsTls: false,
      error: DbHealthTransportError.TlsInsecure,
    });
  });

  // FEA-3315: both branches must pass an explicit ceiling and an explicit
  // acquire timeout. Deleting either option from getPool() fails here, which is
  // what stops the DATABASE_URL branch from silently returning to an untimed
  // queue — the shape `pool-acquire-timeout.test.ts` proves is an infinite wait.
  it("configures an explicit ceiling and acquire timeout on the DATABASE_URL pool", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");

    await withDb(() => null);

    expect(mocks.poolConfigs).toHaveLength(1);
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({
        max: DB_POOL_MAX_DATABASE_URL_DEFAULT,
        connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
      })
    );
  });

  it("configures an explicit ceiling and acquire timeout on the IAM pool", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGDATABASE = "app";
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "app_user";

    await withDb(() => null);

    expect(mocks.poolConfigs).toHaveLength(1);
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({
        max: DB_POOL_MAX_IAM,
        connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
      })
    );
  });
});

function resetDatabaseGlobals() {
  const globals = globalThis as typeof globalThis & {
    pool?: unknown;
    prisma?: unknown;
    signer?: unknown;
  };
  globals.pool = null;
  globals.prisma = null;
  globals.signer = null;
}
