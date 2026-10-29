/**
 * ISS-11298 coverage recovery: pins branches of index.ts's getDatabase() /
 * getPool() / getSigner() left uncovered by runtime-pool.test.ts and its
 * siblings — the PGSCHEMA-set truthy side of every `schema ? … : …` in both
 * the DATABASE_URL and IAM pool branches, the IAM branch's explicit
 * PGPORT/PGDATABASE overrides, getSigner()'s missing-credentials throw, and
 * the pool/signer global-cache short-circuits.
 *
 * Same technique as runtime-pool.test.ts: mock pg/@prisma/adapter-pg/the
 * generated client/Signer so `withDb` runs its real branching logic against
 * fakes, with real env vars and the real global cache.
 *
 * Two `Number(env.PGPORT || "5432")` fallbacks (getSigner() and the IAM pool
 * builder) are NOT exercisable as a live branch and stay uncovered: `keys.ts`
 * declares `PGPORT: z.string().default("5432")`, so `env.PGPORT` coming out of
 * `keys()` is always a non-empty string — the `|| "5432"` never sees a falsy
 * left side even when `process.env.PGPORT` itself is deleted, which is what
 * the "PGPORT is unset" test below actually proves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDb } from "../index";

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
  const signerConfigs: unknown[] = [];

  class MockPool {
    options: { max: number };

    totalCount = 0;

    idleCount = 0;

    waitingCount = 0;

    constructor(config: unknown) {
      poolConfigs.push(config);
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

  class MockSigner {
    config: unknown;

    getAuthToken = vi.fn(async () => "iam-token");

    constructor(config: unknown) {
      this.config = config;
      signerConfigs.push(config);
    }
  }

  return {
    poolConfigs,
    signerConfigs,
    MockPool,
    MockPrismaClient,
    MockPrismaPg,
    MockSigner,
  };
});

vi.mock("pg", () => ({
  default: { Pool: mocks.MockPool },
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
  Signer: mocks.MockSigner,
}));

function resetDatabaseGlobals(
  opts: { keepPool?: boolean; keepSigner?: boolean } = {}
) {
  const globals = globalThis as typeof globalThis & {
    pool?: unknown;
    prisma?: unknown;
    signer?: unknown;
  };
  if (!opts.keepPool) {
    globals.pool = null;
  }
  globals.prisma = null;
  if (!opts.keepSigner) {
    globals.signer = null;
  }
}

describe("index.ts — getDatabase/getPool/getSigner branch coverage", () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    mocks.poolConfigs.length = 0;
    mocks.signerConfigs.length = 0;
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

  it("passes a resolved schema to PrismaPg and the pool's search_path on the DATABASE_URL path", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.PGSCHEMA = "tenant_one";
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");

    let capturedDb: unknown;
    await withDb((db) => {
      capturedDb = db;
      return null;
    });

    const client = capturedDb as InstanceType<typeof mocks.MockPrismaClient>;
    expect(client).toBeInstanceOf(mocks.MockPrismaClient);
    const adapter = client.adapter as InstanceType<typeof mocks.MockPrismaPg>;
    expect(adapter.options).toEqual({ schema: "tenant_one" });
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({ options: "-c search_path=tenant_one" })
    );
  });

  it("passes a resolved schema and explicit PGPORT/PGDATABASE overrides on the IAM path", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGDATABASE = "custom_db";
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGPORT = "5433";
    process.env.PGUSER = "app_user";
    process.env.PGSCHEMA = "tenant_two";

    let capturedDb: unknown;
    await withDb((db) => {
      capturedDb = db;
      return null;
    });

    const client = capturedDb as InstanceType<typeof mocks.MockPrismaClient>;
    const adapter = client.adapter as InstanceType<typeof mocks.MockPrismaPg>;
    expect(adapter.options).toEqual({ schema: "tenant_two" });
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({
        database: "custom_db",
        port: 5433,
        options: "-c search_path=tenant_two",
      })
    );
    // getSigner()'s own `port: Number(env.PGPORT || "5432")` is a SEPARATE
    // occurrence from the pool config's — both must see the explicit override.
    expect(mocks.signerConfigs[0]).toEqual(
      expect.objectContaining({ port: 5433 })
    );
  });

  it("defaults the signer and pool port to 5432 when PGPORT is unset on the IAM path", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "ALLOW_INSECURE_SSL");
    Reflect.deleteProperty(process.env, "PGPORT");
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGDATABASE = "app";
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGUSER = "app_user";

    await withDb(() => null);

    expect(mocks.signerConfigs[0]).toEqual(
      expect.objectContaining({ port: 5432 })
    );
    expect(mocks.poolConfigs[0]).toEqual(
      expect.objectContaining({ port: 5432 })
    );
  });

  it("throws when IAM credentials are incomplete (AWS_REGION missing)", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "AWS_REGION");
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGUSER = "app_user";

    await expect(withDb(() => null)).rejects.toThrow(
      "Missing required IAM credentials: PGHOST, PGUSER, AWS_REGION"
    );
    expect(mocks.signerConfigs).toHaveLength(0);
  });

  it("reuses the cached pool across withDb calls rather than rebuilding it", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";

    await withDb(() => null);
    expect(mocks.poolConfigs).toHaveLength(1);

    // Tear down only the Prisma-client global, as getDatabase() sees on every
    // call whose cached client has been reset for some other reason — the
    // pool global surviving is what forces getPool()'s cache check.
    resetDatabaseGlobals({ keepPool: true });

    await withDb(() => null);
    expect(mocks.poolConfigs).toHaveLength(1);
  });

  it("reuses the cached signer across pool rebuilds rather than constructing a second one", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
    process.env.PGHOST = "db.example.rds.amazonaws.com";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "app_user";

    await withDb(() => null);
    expect(mocks.signerConfigs).toHaveLength(1);
    expect(mocks.poolConfigs).toHaveLength(1);

    // Tear down the pool (forcing getPool() to rebuild) but keep the signer
    // global — getSigner() must find the cache instead of constructing again.
    resetDatabaseGlobals({ keepSigner: true });

    await withDb(() => null);
    expect(mocks.signerConfigs).toHaveLength(1);
    expect(mocks.poolConfigs).toHaveLength(2);
  });
});
