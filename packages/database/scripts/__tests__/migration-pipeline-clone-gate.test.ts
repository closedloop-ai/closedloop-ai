import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../db-utils";
import { recoverMigrateDeployFailure } from "../migrate-deploy-recovery";
import { MigrateGateOutcome } from "../migrate-telemetry";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
  runMigrationPipeline,
} from "../migration-pipeline";
import {
  type PrestampDeps,
  prestampSkippableMigrationsViaSql,
  TABLES_WITHOUT_MIGRATION_HISTORY_SQL,
} from "../preview-prestamp";

const PREVIEW_SCHEMA = "preview_feature_branch_abc123";
const BASE_URL =
  "postgresql://user:stale@db.example.com:5432/cl?sslmode=require";
const REFRESHED_URL =
  "postgresql://user:fresh@db.example.com:5432/cl?sslmode=require";
const FEATURE_REF = "feat/iss-5285-clone";

/**
 * Every collaborator stubbed so a test exercises the pipeline's own branching
 * and nothing else. Overrides are merged on top per test.
 */
function makeDeps(
  overrides: Partial<MigrationPipelineDeps> = {}
): MigrationPipelineDeps {
  return {
    ensureSchemaExists: vi.fn(() => Promise.resolve(true)),
    upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(false)),
    // ISS-11785: a clone-first build needs the gate acquired and the replay of
    // public's migrations to complete; either failing fails the run.
    withMigrationSerializeLock: vi.fn((opts, fn) => {
      opts.onOutcome?.(MigrateGateOutcome.Acquired, 1);
      return fn();
    }),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    replayPendingMigrationsViaSql: vi.fn(() => Promise.resolve(true)),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runMigrate: vi.fn(() => Promise.resolve(false)),
    cloneDataFromPublic: vi.fn(() => Promise.resolve()),
    dropSchema: vi.fn(() => Promise.resolve()),
    runPreviewSeed: vi.fn(),
    readVibeEnvironmentMarker: vi.fn(() => Promise.resolve(null)),
    writeVibeEnvironmentMarker: vi.fn(() => Promise.resolve()),
    readIncompletePreviewBuild: vi.fn(() => Promise.resolve(false)),
    clearIncompletePreviewBuild: vi.fn(() => Promise.resolve()),
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    assertMigrateRoleOwnsSchema: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("post-clone URL refresh (ISS-5285)", () => {
  it("hands the REFRESHED url to the fail-closed index build", async () => {
    const deps = makeDeps({
      refreshDatabaseUrl: vi.fn(() => Promise.resolve(REFRESHED_URL)),
    });

    await applyMigrationsToSchema(
      BASE_URL,
      PREVIEW_SCHEMA,
      FEATURE_REF,
      { isNew: true },
      deps
    );

    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledWith(
      REFRESHED_URL,
      PREVIEW_SCHEMA,
      expect.anything()
    );
    // The clone itself still uses the original URL — it runs before expiry.
    expect(deps.cloneDataFromPublic).toHaveBeenCalledWith(
      BASE_URL,
      PREVIEW_SCHEMA
    );
  });

  it("hands the REFRESHED url to the seed", async () => {
    const deps = makeDeps({
      refreshDatabaseUrl: vi.fn(() => Promise.resolve(REFRESHED_URL)),
    });

    await runMigrationPipeline(BASE_URL, PREVIEW_SCHEMA, FEATURE_REF, deps);

    expect(deps.runPreviewSeed).toHaveBeenCalledWith(
      REFRESHED_URL,
      PREVIEW_SCHEMA
    );
  });

  it("threads the ORIGINAL url unchanged when no refresh is configured", async () => {
    const deps = makeDeps();

    await runMigrationPipeline(BASE_URL, PREVIEW_SCHEMA, FEATURE_REF, deps);

    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledWith(
      BASE_URL,
      PREVIEW_SCHEMA,
      expect.anything()
    );
    expect(deps.runPreviewSeed).toHaveBeenCalledWith(BASE_URL, PREVIEW_SCHEMA);
  });

  it("falls back to the original url when the refresh throws, without masking the downstream error", async () => {
    const downstream = new Error("index build failed for its own reasons");
    const deps = makeDeps({
      refreshDatabaseUrl: vi.fn(() => Promise.reject(new Error("sts down"))),
      plainBuildPreviewConcurrentIndexes: vi.fn(() =>
        Promise.reject(downstream)
      ),
    });

    await expect(
      applyMigrationsToSchema(
        BASE_URL,
        PREVIEW_SCHEMA,
        FEATURE_REF,
        { isNew: true },
        deps
      )
    ).rejects.toThrow("index build failed for its own reasons");

    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledWith(
      BASE_URL,
      PREVIEW_SCHEMA,
      expect.anything()
    );
  });

  it("still falls back when the refresh rejects with a non-Error", async () => {
    // A rejected promise can carry anything. Stringifying rather than reading
    // .message keeps the warning readable instead of logging "undefined", and
    // the fallback must still hand the original url downstream.
    const deps = makeDeps({
      refreshDatabaseUrl: vi.fn(() => Promise.reject("sts down")),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await applyMigrationsToSchema(
      BASE_URL,
      PREVIEW_SCHEMA,
      FEATURE_REF,
      { isNew: true },
      deps
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sts down"));
    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledWith(
      BASE_URL,
      PREVIEW_SCHEMA,
      expect.anything()
    );
    warn.mockRestore();
  });
});

// ————————————————————————————————————————————————————————————————————————————
// ISS-6466 — a stale preview must be reset and RE-CLONED, not silently kept.
//
// Driven over the REAL pre-stamp and the REAL P3005 recovery; only Postgres and
// the Prisma CLI are faked. THE FIXTURE'S STARTING STATE IS THE TEST: an
// EXISTING preview schema (`isNew: false`) holding a table and NO
// `_prisma_migrations`. A fixture that starts empty reaches the clone through
// `isNew`, and one with intact history needs no reset — both pass under the
// broken ordering, which is why the defect shipped.
//
// `fakeDeploy` encodes exactly one rule: `prisma migrate deploy` raises P3005
// when the target schema holds a base table and has no migration history. That
// rule was MEASURED against Prisma 7.8.0 on a real Postgres rather than assumed
// — a preview schema holding only a sequence, an enum, a view or a function
// deployed straight through; a bare `scratch` table raised P3005; and that same
// schema with `_prisma_migrations` pre-created deployed cleanly to completion,
// which is the silent success this ticket is about.
// ————————————————————————————————————————————————————————————————————————————

const STALE_TABLE = "scratch";
const MIGRATIONS_TABLE = "_prisma_migrations";

/** A one-schema stand-in for Postgres: just the set of base tables it holds. */
function makeFakeSchema(initialTables: string[]) {
  const tables = new Set(initialTables);
  const hasOtherTables = () =>
    [...tables].some((name) => name !== MIGRATIONS_TABLE);

  const client: SqlClient = {
    connect: () => Promise.resolve(),
    end: () => Promise.resolve(),
    query: (text: string) => {
      // Matched against the production statement itself, so a change to the
      // probe's SQL or its row alias reaches this fake instead of leaving it
      // answering a contract production no longer speaks.
      if (text === TABLES_WITHOUT_MIGRATION_HISTORY_SQL) {
        return Promise.resolve({
          rows: [
            { unbaselined: hasOtherTables() && !tables.has(MIGRATIONS_TABLE) },
          ],
        });
      }
      if (text.includes("CREATE TABLE IF NOT EXISTS")) {
        tables.add(MIGRATIONS_TABLE);
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rowCount: 1 });
    },
  };

  return { tables, hasOtherTables, client };
}

function makeStalePreviewWiring(state: ReturnType<typeof makeFakeSchema>) {
  const resetSchema = vi.fn(() => {
    state.tables.clear();
    return Promise.resolve();
  });

  const prestamp = (
    databaseUrl: string,
    schema: string | null,
    opts?: Pick<PrestampDeps, "freshSchema">
  ) =>
    prestampSkippableMigrationsViaSql(databaseUrl, schema, {
      ...opts,
      createClient: () => state.client,
      readMigrationSql: (name) => `-- ${name}\n`,
      logger: { log: () => undefined, warn: () => undefined },
    });

  // Production binds the recovery re-stamp with `freshSchema: true`
  // (migration-pipeline.ts), which is what keeps the plain-build entries OUT of
  // the post-reset stamp per ISS-6814. Mirrored here or this test would drive
  // the opposite scope on the one route it claims to cover end to end.
  const recoveryPrestamp = (databaseUrl: string, schema: string | null) =>
    prestamp(databaseUrl, schema, { freshSchema: true });

  const fakeDeploy = () => {
    if (state.hasOtherTables() && !state.tables.has(MIGRATIONS_TABLE)) {
      return Promise.reject(
        new Error("Error: P3005\n\nThe database schema is not empty.")
      );
    }
    state.tables.add(MIGRATIONS_TABLE);
    return Promise.resolve();
  };

  const runMigrate = (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined
  ) =>
    fakeDeploy().then(
      () => false,
      (error: unknown) =>
        recoverMigrateDeployFailure(
          { databaseUrl, schema, branch, error },
          {
            runMigrateDeploy: fakeDeploy,
            resolveFailedMigration: () => Promise.resolve(),
            resetSchema,
            upsertSchemaRegistry: () => Promise.resolve(),
            prestampSkippableMigrations: recoveryPrestamp,
          }
        )
    );

  return { resetSchema, prestamp, recoveryPrestamp, runMigrate };
}

describe("stale preview schema is reset and re-cloned (ISS-6466)", () => {
  it("clones an EXISTING preview schema that holds tables but no migration history", async () => {
    const state = makeFakeSchema([STALE_TABLE]);
    const wiring = makeStalePreviewWiring(state);
    const deps = makeDeps({
      prestampSkippableMigrationsViaSql: wiring.prestamp,
      runMigrate: wiring.runMigrate,
    });

    // Fixture check, not a behavioral claim: confirms the schema really starts
    // in the defective shape, so a mis-built fixture cannot make the assertions
    // below pass for the wrong reason.
    expect(state.tables.has(MIGRATIONS_TABLE)).toBe(false);
    expect(state.hasOtherTables()).toBe(true);

    const result = await applyMigrationsToSchema(
      BASE_URL,
      PREVIEW_SCHEMA,
      FEATURE_REF,
      { isNew: false },
      deps
    );

    // The reset actually fired — not merely "the clone was reached somehow".
    expect(wiring.resetSchema).toHaveBeenCalledTimes(1);
    expect(result.didReset).toBe(true);
    // `isNew` is false above, so this call cannot be the fresh-schema path.
    expect(deps.cloneDataFromPublic).toHaveBeenCalledWith(
      BASE_URL,
      PREVIEW_SCHEMA
    );
  });

  it("leaves a genuinely migrated preview alone: no reset, no re-clone", async () => {
    // The discriminating half. Without it, a pipeline that cloned on every
    // deploy would satisfy the assertion above.
    const state = makeFakeSchema([STALE_TABLE, MIGRATIONS_TABLE]);
    const wiring = makeStalePreviewWiring(state);
    const deps = makeDeps({
      prestampSkippableMigrationsViaSql: wiring.prestamp,
      runMigrate: wiring.runMigrate,
    });

    const result = await applyMigrationsToSchema(
      BASE_URL,
      PREVIEW_SCHEMA,
      FEATURE_REF,
      { isNew: false },
      deps
    );

    expect(wiring.resetSchema).not.toHaveBeenCalled();
    expect(result.didReset).toBe(false);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
  });
});
