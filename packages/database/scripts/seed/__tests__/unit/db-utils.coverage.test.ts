/**
 * ISS-11298 coverage recovery: pins branches of db-utils.ts left uncovered by
 * db-utils.test.ts — createSslClient/createSqlClient option defaults,
 * clampTimeoutMs's undefined-budget path, the empty-hostname
 * classifyHostType/classifySslMode fallthrough, endQuietly's null no-op, and
 * readMigrationSql's default migrationsDir argument plus its non-Error catch
 * branch.
 */

import { readFileSync } from "node:fs";
import {
  DbHealthCheckStatus,
  DbHealthHostType,
  DbHealthSource,
  DbHealthSslMode,
  DbHealthTransportError,
} from "@repo/api/src/types/db-health";
import { describe, expect, it, vi } from "vitest";
import {
  clampTimeoutMs,
  classifyDatabaseTransport,
  createSqlClient,
  createSslClient,
  endQuietly,
  MIN_TIMEOUT_MS,
  readMigrationSql,
} from "../../../db-utils";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Records the config each pg.Client is constructed with, so a test can tell an
// omitted key from one forwarded as `undefined` (pg itself treats both alike).
const pgClientConfigs = vi.hoisted((): unknown[] => []);

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  const RealClient = actual.default.Client;
  class RecordingClient extends RealClient {
    constructor(config?: ConstructorParameters<typeof RealClient>[0]) {
      pgClientConfigs.push(config);
      super(config);
    }
  }
  return { ...actual, default: { ...actual.default, Client: RecordingClient } };
});

const mockedReadFileSync = vi.mocked(readFileSync);
const NONEXISTENT_MIGRATION_ERROR_RE =
  /Could not read migration SQL at .*iss11298_nonexistent_migration/;

describe("createSslClient — option defaults and ternaries", () => {
  it("builds a client with no opts argument at all (default-arg branch)", () => {
    const client = createSslClient("postgresql://user:pass@localhost:5432/db");
    // localhost never uses TLS.
    expect((client as unknown as { ssl: unknown }).ssl).toBe(false);
  });

  it("honors an explicit allowInsecure: false rather than the ?? true default", () => {
    // Non-localhost with no sslmode: `allowInsecure: false` must select the
    // verifying branch (rejectUnauthorized: true), not the default's
    // unverified one.
    const client = createSslClient(
      "postgresql://user:pass@db.example.rds.amazonaws.com:5432/db",
      { allowInsecure: false }
    );
    const sslOption = (client as unknown as { ssl: unknown }).ssl as {
      rejectUnauthorized: boolean;
    };
    expect(sslOption.rejectUnauthorized).toBe(true);
  });

  it("omits connectionTimeoutMillis from the pg config when not provided", () => {
    pgClientConfigs.length = 0;
    createSslClient("postgresql://user:pass@localhost:5432/db");
    expect(pgClientConfigs).toHaveLength(1);
    expect(pgClientConfigs[0]).not.toHaveProperty("connectionTimeoutMillis");
  });

  it("forwards an explicit connectionTimeoutMillis", () => {
    const client = createSslClient("postgresql://user:pass@localhost:5432/db", {
      connectionTimeoutMillis: 4321,
    });
    expect(
      (client as unknown as { _connectionTimeoutMillis?: number })
        ._connectionTimeoutMillis
    ).toBe(4321);
  });

  it("omits query_timeout from the pg config when not provided", () => {
    pgClientConfigs.length = 0;
    createSslClient("postgresql://user:pass@localhost:5432/db");
    expect(pgClientConfigs).toHaveLength(1);
    expect(pgClientConfigs[0]).not.toHaveProperty("query_timeout");
  });

  it("forwards an explicit queryTimeoutMillis as query_timeout", () => {
    const client = createSslClient("postgresql://user:pass@localhost:5432/db", {
      queryTimeoutMillis: 9876,
    });
    expect(
      (
        client as unknown as {
          connectionParameters: { query_timeout?: number };
        }
      ).connectionParameters.query_timeout
    ).toBe(9876);
  });
});

describe("createSqlClient — default opts argument", () => {
  it("adapts a real pg.Client with no opts argument", async () => {
    const client = createSqlClient("postgresql://user:pass@localhost:5432/db");
    // The adapter delegates end() without ever actually connecting — a
    // never-connected pg.Client's end() resolves rather than throwing.
    await expect(client.end()).resolves.toBeUndefined();
  });
});

describe("clampTimeoutMs — undefined budget", () => {
  it("returns the fixed value unchanged when budgetMs is undefined", () => {
    expect(clampTimeoutMs(5000, undefined)).toBe(5000);
  });

  it("still clamps to the floor when a budget IS given", () => {
    // Sibling case, proving the undefined branch above is the one being
    // isolated rather than the function always returning fixedMs.
    expect(clampTimeoutMs(5000, 1)).toBe(MIN_TIMEOUT_MS);
  });
});

describe("classifyDatabaseTransport — empty-hostname fallthrough", () => {
  it("classifies a schemeless DATABASE_URL with no host as unknown posture", () => {
    // `new URL("postgresql:///dbname")` parses without throwing and yields an
    // EMPTY hostname — distinct from an unparseable URL (which throws and
    // takes the catch-block buildUnknownTransportCheck path instead). This
    // drives classifyHostType's `length > 0` check false (→ Unknown) and, in
    // turn, classifySslMode's `hostType === Unknown` check true (→ Unknown).
    expect(
      classifyDatabaseTransport({ databaseUrl: "postgresql:///dbname" })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Unknown,
      sslMode: DbHealthSslMode.Unknown,
      source: DbHealthSource.DatabaseUrl,
      error: DbHealthTransportError.UnknownPosture,
    });
  });
});

describe("endQuietly — null client", () => {
  it("resolves without error and touches nothing when the client is null", async () => {
    await expect(endQuietly(null)).resolves.toBeUndefined();
  });
});

describe("readMigrationSql — default migrationsDir and non-Error catch", () => {
  it("resolves the migrations dir from cwd when migrationsDir is omitted", () => {
    // No such migration exists under the real cwd-relative prisma/migrations,
    // so this throws — the default-arg branch is exercised regardless of
    // whether the read itself succeeds.
    expect(() => readMigrationSql("iss11298_nonexistent_migration")).toThrow(
      NONEXISTENT_MIGRATION_ERROR_RE
    );
  });

  it("stringifies a thrown non-Error value instead of reading .message", () => {
    // Pins the `error instanceof Error ? error.message : String(error)` false
    // branch, which requires a non-Error throw from readFileSync.
    mockedReadFileSync.mockImplementationOnce(() => {
      // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw to test the fallback branch
      throw "disk exploded";
    });

    expect(() => readMigrationSql("m_one", "/tmp/iss11298-fixture")).toThrow(
      "Could not read migration SQL at /tmp/iss11298-fixture/m_one/migration.sql: disk exploded"
    );
  });
});
