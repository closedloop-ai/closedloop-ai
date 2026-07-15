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

  class MockPool {
    constructor(config: unknown) {
      poolConfigs.push(config);
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
