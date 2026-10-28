import { afterEach, describe, expect, it, vi } from "vitest";

const SCHEMA = "preview_feat_iss_8039";
const URL = "postgresql://user:pw@db.example.com:5432/cl";

const createSqlClientMock = vi.fn();
vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return {
    ...actual,
    createSqlClient: (...args: unknown[]) => createSqlClientMock(...args),
  };
});

const { replayPendingMigrationsViaSql } = await import("../preview-sql-replay");

function makeClient(queryImpl: (text: string, values?: unknown[]) => unknown) {
  return {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) =>
      Promise.resolve(queryImpl(text, values))
    ),
  };
}

afterEach(() => {
  createSqlClientMock.mockReset();
});

describe("appliedMigrationNames — non-array rows", () => {
  it("treats a result with no rows array as no migrations applied", async () => {
    // pins current behavior; looks odd because a real pg query result always
    // has a `rows` array, but the parser guards a malformed/mocked result by
    // returning an empty set rather than throwing.
    const client = makeClient((text) => {
      if (text.includes('SELECT "migration_name"')) {
        return {};
      }
      return { rowCount: 1 };
    });
    createSqlClientMock.mockReturnValue(client);
    const files = { "20260101000000_a": 'CREATE TABLE "a" ("id" TEXT);' };

    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA, {
      listMigrationDirs: () => Object.keys(files),
      readMigrationSql: (name: string) => files[name as keyof typeof files],
      logger: { log: () => undefined, warn: () => undefined },
    });

    expect(ok).toBe(true);
    const ddlCalls = client.query.mock.calls.filter(([text]) =>
      String(text).startsWith('CREATE TABLE "a"')
    );
    expect(ddlCalls).toHaveLength(1);
  });
});

describe("appliedMigrationNames — non-string migration_name rows", () => {
  it("skips a row whose migration_name is not a string", async () => {
    const files = {
      "20260101000000_a": 'CREATE TABLE "a" ("id" TEXT);',
      "20260102000000_b": 'CREATE TABLE "b" ("id" TEXT);',
    };
    const client = makeClient((text) => {
      if (text.includes('SELECT "migration_name"')) {
        return {
          rows: [
            { migration_name: 20_260_101_000_000 },
            { migration_name: "20260102000000_b" },
          ],
        };
      }
      return { rowCount: 1 };
    });
    createSqlClientMock.mockReturnValue(client);

    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA, {
      listMigrationDirs: () => Object.keys(files),
      readMigrationSql: (name: string) => files[name as keyof typeof files],
      logger: { log: () => undefined, warn: () => undefined },
    });

    expect(ok).toBe(true);
    // The non-string row is not recognized as applied, so "a" is re-applied;
    // the string row IS recognized as applied, so "b" is skipped.
    const ddlTexts = client.query.mock.calls
      .map(([text]) => String(text))
      .filter(
        (text) =>
          (text.startsWith('CREATE TABLE "a"') ||
            text.startsWith('CREATE TABLE "b"')) &&
          !text.includes("_prisma_migrations")
      );
    expect(ddlTexts).toEqual(['CREATE TABLE "a" ("id" TEXT);']);
  });
});

describe("replayPendingMigrationsViaSql — non-Error rejection", () => {
  it("reports a thrown non-Error value via String() rather than .message", async () => {
    const files = { "20260101000000_a": 'CREATE TABLE "a" ("id" TEXT);' };
    const client = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((text: string) => {
        if (text.startsWith('CREATE TABLE "a"')) {
          return Promise.reject("boom-string-rejection");
        }
        if (text.includes('SELECT "migration_name"')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rowCount: 1 });
      }),
    };
    createSqlClientMock.mockReturnValue(client);
    const warn = vi.fn();

    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA, {
      listMigrationDirs: () => Object.keys(files),
      readMigrationSql: (name: string) => files[name as keyof typeof files],
      logger: { log: () => undefined, warn },
    });

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("boom-string-rejection")
    );
  });
});

describe("replayPendingMigrationsViaSql — default deps", () => {
  it("uses the default createClient/readMigrationSql/listMigrationDirs/logger when omitted", async () => {
    const client = makeClient(() => ({ rows: [] }));
    createSqlClientMock.mockReturnValue(client);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const ok = await replayPendingMigrationsViaSql(URL, SCHEMA);

    // The mocked createSqlClient stands in for the real default, proving the
    // `deps.createClient ?? createSqlClient` branch actually took the default.
    expect(createSqlClientMock).toHaveBeenCalledWith(URL);
    expect(ok).toBe(true);
    // Real migrations on disk were read and replayed against the fake client,
    // via the real defaultReadMigrationSql / defaultListMigrationDirs.
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Replayed"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
