import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSchemaBootstrapHook, withDb } from "../index";

/**
 * ISS-5984: the seam that lets `apps/api` create a Vercel preview's schema
 * before anything queries it. The property under test is ORDERING — the hook
 * must settle before the Prisma client exists, because a client pointed at a
 * schema that does not exist fails every query it is handed.
 */

const ENV_KEYS = [
  "DATABASE_URL",
  "PGHOST",
  "PGSCHEMA",
  "PGUSER",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
] as const;

const mocks = vi.hoisted(() => {
  const events: string[] = [];

  class MockPool {
    options = { max: 10 };

    totalCount = 0;

    idleCount = 0;

    waitingCount = 0;

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

  class MockPrismaPg {}

  class MockPrismaClient {
    constructor() {
      events.push("client-constructed");
    }
  }

  return { events, MockPool, MockPrismaClient, MockPrismaPg };
});

vi.mock("pg", () => ({ default: { Pool: mocks.MockPool } }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: mocks.MockPrismaPg }));
vi.mock("../generated/client", () => ({
  PrismaClient: mocks.MockPrismaClient,
}));

describe("schema bootstrap hook", () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    mocks.events.length = 0;
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]])
    );
    process.env.DATABASE_URL = "postgresql://user:pw@localhost:5432/app";
    resetDatabaseGlobals();
  });

  afterEach(() => {
    setSchemaBootstrapHook(null);
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

  it("awaits a registered hook before the Prisma client is constructed", async () => {
    setSchemaBootstrapHook(async () => {
      mocks.events.push("hook-started");
      await Promise.resolve();
      mocks.events.push("hook-settled");
    });

    await withDb(() => null);

    expect(mocks.events).toEqual([
      "hook-started",
      "hook-settled",
      "client-constructed",
    ]);
  });

  it("runs the hook once per instance, not once per query", async () => {
    const hook = vi.fn(() => Promise.resolve());
    setSchemaBootstrapHook(hook);

    await withDb(() => null);
    await withDb(() => null);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("fails the caller and constructs no client when the hook rejects", async () => {
    setSchemaBootstrapHook(() =>
      Promise.reject(new Error("bootstrap unavailable"))
    );
    const callback = vi.fn(() => null);

    await expect(withDb(callback)).rejects.toThrow("bootstrap unavailable");
    expect(callback).not.toHaveBeenCalled();
    expect(mocks.events).not.toContain("client-constructed");
  });

  it("constructs the client with no hook registered", async () => {
    await withDb(() => null);

    expect(mocks.events).toEqual(["client-constructed"]);
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
