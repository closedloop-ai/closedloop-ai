import { describe, expect, it } from "vitest";
import {
  BranchesWebSeedRefusalCode,
  checkBranchesWebSeedDatabaseName,
  resolveBranchesWebSeedDatabaseTarget,
} from "../seed-branches-web-db-guards";

const BASE_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/symphony";

describe("branches web seed target guards", () => {
  it("requires an explicit database name or URL", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl: undefined,
        baseDatabaseUrl: BASE_DATABASE_URL,
      })
    ).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.TargetMissing },
    });
  });

  it("resolves an explicit database name through the local base URL", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: "symphony_worker_8018",
        explicitDatabaseUrl: undefined,
        baseDatabaseUrl: BASE_DATABASE_URL,
      })
    ).toMatchObject({
      ok: true,
      target: {
        databaseName: "symphony_worker_8018",
        label: "localhost:5432/symphony_worker_8018",
      },
    });
  });

  it("accepts an explicit localhost database URL", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl:
          "postgresql://postgres:postgres@127.0.0.1:5432/symphony_worker_8018",
        baseDatabaseUrl: undefined,
      })
    ).toMatchObject({
      ok: true,
      target: {
        databaseName: "symphony_worker_8018",
        label: "127.0.0.1:5432/symphony_worker_8018",
      },
    });
  });

  it("refuses ambiguous, remote, host-overridden, and system targets", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: "symphony_worker_8018",
        explicitDatabaseUrl: BASE_DATABASE_URL,
        baseDatabaseUrl: BASE_DATABASE_URL,
      })
    ).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.TargetAmbiguous },
    });
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl:
          "postgresql://postgres:postgres@db.example.test:5432/symphony_worker_8018",
        baseDatabaseUrl: undefined,
      })
    ).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.DatabaseUrlNotLocal },
    });
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl: `${BASE_DATABASE_URL}?host=db.example.test`,
        baseDatabaseUrl: undefined,
      })
    ).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.DatabaseUrlHostOverride },
    });
    expect(checkBranchesWebSeedDatabaseName("postgres")).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.DatabaseNameSystem },
    });
  });

  it("refuses an explicit database name that fails the safe-character pattern", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: "bad name!",
        explicitDatabaseUrl: undefined,
        baseDatabaseUrl: BASE_DATABASE_URL,
      })
    ).toStrictEqual({
      ok: false,
      error: {
        code: BranchesWebSeedRefusalCode.DatabaseNameInvalid,
        message:
          "Database name must contain only letters, numbers, underscores, or hyphens.",
      },
    });
  });

  it("requires a base DATABASE_URL when only --database-name is given", () => {
    // Whitespace-only, not `undefined` — this is what actually exercises the
    // `?.trim()` on `baseDatabaseUrl` rather than short-circuiting on a bare
    // falsy check, which would report the same refusal either way.
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: "symphony_worker_1",
        explicitDatabaseUrl: undefined,
        baseDatabaseUrl: "   ",
      })
    ).toStrictEqual({
      ok: false,
      error: {
        code: BranchesWebSeedRefusalCode.BaseDatabaseUrlMissing,
        message:
          "DATABASE_URL is required as the base connection string when --database-name is used.",
      },
    });
  });

  it("propagates the base URL's own refusal when it is not local", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: "symphony_worker_1",
        explicitDatabaseUrl: undefined,
        baseDatabaseUrl:
          "postgresql://postgres:postgres@db.example.test:5432/symphony",
      })
    ).toStrictEqual({
      ok: false,
      error: {
        code: BranchesWebSeedRefusalCode.DatabaseUrlNotLocal,
        message:
          "Database URL host is 'db.example.test', expected localhost, 127.0.0.1, or ::1.",
      },
    });
  });

  it("refuses an explicit database URL that is not parseable", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl: "not a url",
        baseDatabaseUrl: undefined,
      })
    ).toStrictEqual({
      ok: false,
      error: {
        code: BranchesWebSeedRefusalCode.DatabaseUrlUnparseable,
        message: "Database URL is not parseable; refusing to connect.",
      },
    });
  });

  it("refuses a database URL whose path yields an unsafe database name", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl:
          "postgresql://postgres:postgres@localhost:5432/my.db",
        baseDatabaseUrl: undefined,
      })
    ).toMatchObject({
      ok: false,
      error: { code: BranchesWebSeedRefusalCode.DatabaseNameInvalid },
    });
  });

  it("labels the default port when the database URL carries none", () => {
    expect(
      resolveBranchesWebSeedDatabaseTarget({
        explicitDatabaseName: undefined,
        explicitDatabaseUrl:
          "postgresql://postgres@localhost/symphony_worker_9",
        baseDatabaseUrl: undefined,
      })
    ).toMatchObject({
      ok: true,
      target: { label: "localhost:5432/symphony_worker_9" },
    });
  });
});
