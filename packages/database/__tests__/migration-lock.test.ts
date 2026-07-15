import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_SERIALIZE_LOCK_BUDGET_MS,
  MIGRATION_SERIALIZE_LOCK_KEY,
  type MigrationLockClient,
  PRISMA_MIGRATE_ADVISORY_LOCK_KEY,
  STATEMENT_TIMEOUT_SQLSTATE,
  withMigrationSerializeLock,
} from "../scripts/migration-lock";

const DATABASE_URL = "postgresql://u@localhost:5432/app";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

type MockBehavior = {
  connectError?: Error;
  acquireError?: Error;
  acquireGate?: Promise<void>;
};

function makeMockClient(behavior: MockBehavior = {}) {
  const calls: string[] = [];
  const queryArgs: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn((text: string, values?: unknown[]) => {
    calls.push(text);
    queryArgs.push({ text, values });
    if (text.includes("pg_advisory_lock(")) {
      return (async () => {
        if (behavior.acquireGate) {
          await behavior.acquireGate;
        }
        if (behavior.acquireError) {
          throw behavior.acquireError;
        }
        return { rows: [] };
      })();
    }
    return Promise.resolve({ rows: [] });
  });
  const connect = vi.fn(() =>
    behavior.connectError
      ? Promise.reject(behavior.connectError)
      : Promise.resolve()
  );
  const end = vi.fn().mockResolvedValue(undefined);
  const client: MigrationLockClient = { connect, query, end };
  return { client, calls, queryArgs, query, connect, end };
}

function makeLogger() {
  const logs: string[] = [];
  return { logger: { log: (message: string) => logs.push(message) }, logs };
}

function timeoutError(): Error {
  return Object.assign(
    new Error("canceling statement due to statement timeout"),
    {
      code: STATEMENT_TIMEOUT_SQLSTATE,
    }
  );
}

// ---------------------------------------------------------------------------
// constants / guard
// ---------------------------------------------------------------------------

describe("MIGRATION_SERIALIZE_LOCK_KEY", () => {
  it("differs from Prisma's migration advisory-lock key", () => {
    expect(MIGRATION_SERIALIZE_LOCK_KEY).not.toBe(
      PRISMA_MIGRATE_ADVISORY_LOCK_KEY
    );
    expect(MIGRATION_SERIALIZE_LOCK_KEY).not.toBe(72_707_369);
  });

  it("is a positive JS safe integer (valid int8 key)", () => {
    expect(Number.isSafeInteger(MIGRATION_SERIALIZE_LOCK_KEY)).toBe(true);
    expect(MIGRATION_SERIALIZE_LOCK_KEY).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("withMigrationSerializeLock — acquired", () => {
  it("acquires, runs fn once, then unlocks and closes", async () => {
    const { client, calls, queryArgs, end } = makeMockClient();
    const { logger, logs } = makeLogger();
    const fn = vi.fn().mockResolvedValue("migrated");

    const result = await withMigrationSerializeLock(
      { databaseUrl: DATABASE_URL, createClient: () => client, logger },
      fn
    );

    expect(result).toBe("migrated");
    expect(fn).toHaveBeenCalledTimes(1);
    // set_config (statement_timeout) is issued BEFORE the acquire.
    const setConfigIdx = calls.findIndex((c) => c.includes("set_config"));
    const acquireIdx = calls.findIndex((c) => c.includes("pg_advisory_lock("));
    expect(setConfigIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThan(setConfigIdx);
    // budget passed as the set_config value.
    const setConfigArgs = queryArgs.find((a) => a.text.includes("set_config"));
    expect(setConfigArgs?.values).toEqual([
      String(MIGRATION_SERIALIZE_LOCK_BUDGET_MS),
    ]);
    // released + closed.
    expect(calls.some((c) => c.includes("pg_advisory_unlock("))).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
    expect(logs).toContain("[migration-lock] waiting for serialize lock");
    expect(logs).toContain("[migration-lock] acquired serialize lock");
  });

  it("does not start fn until the blocking acquire resolves", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeMockClient({ acquireGate: gate });
    const { logger } = makeLogger();
    let fnStarted = false;
    const fn = vi.fn(() => {
      fnStarted = true;
      return Promise.resolve("ok");
    });

    const promise = withMigrationSerializeLock(
      { databaseUrl: DATABASE_URL, createClient: () => client, logger },
      fn
    );

    await flushMicrotasks();
    expect(fnStarted).toBe(false); // still blocked in the acquire

    release?.();
    await expect(promise).resolves.toBe("ok");
    expect(fnStarted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fail-open paths (the "no new failure mode" guarantee)
// ---------------------------------------------------------------------------

describe("withMigrationSerializeLock — fail-open", () => {
  it("statement_timeout cancel (57014) → runs fn unguarded, no unlock, closes, logs reason", async () => {
    const { client, calls, end } = makeMockClient({
      acquireError: timeoutError(),
    });
    const { logger, logs } = makeLogger();
    const fn = vi.fn().mockResolvedValue("migrated");

    const result = await withMigrationSerializeLock(
      { databaseUrl: DATABASE_URL, createClient: () => client, logger },
      fn
    );

    expect(result).toBe("migrated");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.includes("pg_advisory_unlock("))).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(
      logs.some((l) =>
        l.startsWith("[migration-lock] proceeding WITHOUT serialize lock:")
      )
    ).toBe(true);
    expect(logs.some((l) => l.includes(STATEMENT_TIMEOUT_SQLSTATE))).toBe(true);
  });

  it("connect() throws → runs fn unguarded exactly once (new-connection failure is not a new deploy-failure mode)", async () => {
    const { client, calls } = makeMockClient({
      connectError: Object.assign(new Error("ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    const { logger, logs } = makeLogger();
    const fn = vi.fn().mockResolvedValue("migrated");

    const result = await withMigrationSerializeLock(
      { databaseUrl: DATABASE_URL, createClient: () => client, logger },
      fn
    );

    expect(result).toBe("migrated");
    expect(fn).toHaveBeenCalledTimes(1);
    // never got as far as taking the lock
    expect(calls.some((c) => c.includes("pg_advisory_lock("))).toBe(false);
    expect(
      logs.some((l) =>
        l.startsWith("[migration-lock] proceeding WITHOUT serialize lock:")
      )
    ).toBe(true);
  });

  it("createClient factory throws → still runs fn unguarded", async () => {
    const { logger } = makeLogger();
    const fn = vi.fn().mockResolvedValue("migrated");

    const result = await withMigrationSerializeLock(
      {
        databaseUrl: DATABASE_URL,
        createClient: () => {
          throw new Error("factory boom");
        },
        logger,
      },
      fn
    );

    expect(result).toBe("migrated");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fn error propagation
// ---------------------------------------------------------------------------

describe("withMigrationSerializeLock — fn throws", () => {
  it("propagates fn's error and still unlocks + closes (finally)", async () => {
    const { client, calls, end } = makeMockClient();
    const { logger } = makeLogger();
    const boom = new Error("migrate deploy failed");
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(
      withMigrationSerializeLock(
        { databaseUrl: DATABASE_URL, createClient: () => client, logger },
        fn
      )
    ).rejects.toBe(boom);

    expect(calls.some((c) => c.includes("pg_advisory_unlock("))).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
