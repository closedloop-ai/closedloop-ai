import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  defaultApplyToSchema,
  defaultEnumeratePreviewSchemas,
  isPreviewMigratorEnabled,
  type MigrateAllPreviewsDeps,
  migrateAllPreviewSchemas,
} from "../scripts/migrate-all-previews";
import { SerializeLockContendedError } from "../scripts/migration-lock";

const BASE_URL = "postgresql://u@stage-host:5432/app";
const MERGE_QUEUE_REF = "gh-readonly-queue/main/pr-4444-abc1234";

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

/** Enumeration stub: entries with no registry branch (the common case). */
function previews(...schemaNames: string[]) {
  return schemaNames.map((schemaName) => ({ schemaName, branch: undefined }));
}

/** signDatabaseUrl stub: records the schemas it was asked to sign, in order. */
function makeSigner() {
  const signed: string[] = [];
  const sign = vi.fn((schema: string) => {
    signed.push(schema);
    return Promise.resolve(`${BASE_URL}?schema=${schema}&token=fresh`);
  });
  return { sign, signed };
}

function run(
  signer: ReturnType<typeof makeSigner>,
  deps: MigrateAllPreviewsDeps
) {
  return migrateAllPreviewSchemas(BASE_URL, signer.sign, deps);
}

describe("migrateAllPreviewSchemas — serial walk (FEA-3071 Slice 2)", () => {
  it("walks every schema serially, in enumerated order, signing once per schema", async () => {
    const order: string[] = [];
    const applyToSchema = vi.fn((_url: string, schema: string) => {
      order.push(schema);
      return Promise.resolve({ didReset: false, cloneFailed: false });
    });
    const signer = makeSigner();
    const summary = await run(signer, {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b", "preview_c")),
      applyToSchema,
      logger: makeLogger(),
    });

    expect(order).toEqual(["preview_a", "preview_b", "preview_c"]);
    expect(signer.signed).toEqual(["preview_a", "preview_b", "preview_c"]);
    expect(summary).toMatchObject({
      discovered: 3,
      succeeded: 3,
      skippedContended: 0,
      skippedBudget: 0,
      failed: 0,
    });
  });

  it("is best-effort: one apply error does not stop the rest (counted as failed)", async () => {
    const applyToSchema = vi.fn((_url: string, schema: string) =>
      schema === "preview_b"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ didReset: false, cloneFailed: false })
    );
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b", "preview_c")),
      applyToSchema,
      logger: makeLogger(),
    });

    expect(applyToSchema).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ succeeded: 2, failed: 1, discovered: 3 });
  });

  it("fails CLOSED: a contended gate skips the schema (never migrates unguarded)", async () => {
    const applyToSchema = vi.fn((_url: string, schema: string) =>
      schema === "preview_b"
        ? Promise.reject(new SerializeLockContendedError("57014"))
        : Promise.resolve({ didReset: false, cloneFailed: false })
    );
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b", "preview_c")),
      applyToSchema,
      logger: makeLogger(),
    });

    // Contended is counted separately from a real failure, and the walk continues.
    expect(summary).toMatchObject({
      succeeded: 2,
      skippedContended: 1,
      failed: 0,
    });
  });

  it("stops at the wall-clock budget and reports the un-walked remainder", async () => {
    // Clock: start=0, then jumps past the 100ms budget before the 2nd schema.
    const times = [0, 0, 500, 500, 500];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const applyToSchema = vi.fn(() =>
      Promise.resolve({ didReset: false, cloneFailed: false })
    );
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b", "preview_c")),
      applyToSchema,
      now,
      budgetMs: 100,
      logger: makeLogger(),
    });

    // Only the first schema ran before the budget check tripped on the second.
    expect(applyToSchema).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ succeeded: 1, skippedBudget: 2 });
  });

  it("seeds ONLY after a reset (never refreshes an un-reset schema)", async () => {
    const seed = vi.fn();
    const applyToSchema = vi.fn((_url: string, schema: string) =>
      Promise.resolve({
        didReset: schema === "preview_reset",
        cloneFailed: false,
      })
    );
    await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_plain", "preview_reset")),
      applyToSchema,
      runPreviewSeed: seed,
      logger: makeLogger(),
    });

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith(expect.any(String), "preview_reset");
  });

  it("counts a reset with a failed clone as failed and does NOT seed it", async () => {
    const seed = vi.fn();
    const applyToSchema = vi.fn(() =>
      Promise.resolve({ didReset: true, cloneFailed: true })
    );
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_broken")),
      applyToSchema,
      runPreviewSeed: seed,
      logger: makeLogger(),
    });

    // A reset that couldn't restore data must not be a silent success.
    expect(seed).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
  });

  it("threads the remaining admission deadline into applyToSchema", async () => {
    const seen: number[] = [];
    const applyToSchema = vi.fn(
      (_url: string, _schema: string, remainingBudgetMs: number) => {
        seen.push(remainingBudgetMs);
        return Promise.resolve({ didReset: false, cloneFailed: false });
      }
    );
    // Clock advances 10ms per read; budget 1000ms → both schemas get a positive,
    // decreasing remaining deadline.
    let t = 0;
    const now = () => {
      t += 10;
      return t;
    };
    await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b")),
      applyToSchema,
      now,
      budgetMs: 1000,
      logger: makeLogger(),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(1000);
    expect(seen[1]).toBeLessThan(seen[0]);
  });

  it("no-ops on an empty enumeration", async () => {
    const applyToSchema = vi.fn();
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () => Promise.resolve([]),
      applyToSchema,
      logger: makeLogger(),
    });
    expect(applyToSchema).not.toHaveBeenCalled();
    expect(summary.discovered).toBe(0);
  });

  it("swallows an enumeration failure (never fails the host deploy)", async () => {
    const applyToSchema = vi.fn();
    const logger = makeLogger();
    const summary = await run(makeSigner(), {
      enumeratePreviewSchemas: () => Promise.reject(new Error("db down")),
      applyToSchema,
      logger,
    });
    expect(applyToSchema).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ discovered: 0, succeeded: 0 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("skips a schema whose URL cannot be signed, continuing the rest", async () => {
    const applyToSchema = vi.fn(() =>
      Promise.resolve({ didReset: false, cloneFailed: false })
    );
    const signed: string[] = [];
    const sign = vi.fn((schema: string) => {
      if (schema === "preview_b") {
        return Promise.reject(new Error("token error"));
      }
      signed.push(schema);
      return Promise.resolve(`${BASE_URL}?schema=${schema}`);
    });
    const summary = await migrateAllPreviewSchemas(BASE_URL, sign, {
      enumeratePreviewSchemas: () =>
        Promise.resolve(previews("preview_a", "preview_b", "preview_c")),
      applyToSchema,
      logger: makeLogger(),
    });

    // preview_b never reached applyToSchema; a and c did.
    expect(applyToSchema).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ succeeded: 2, failed: 1 });
  });

  it("threads the registry branch from enumeration into applyToSchema (ISS-5285)", async () => {
    const applyToSchema = vi.fn(() =>
      Promise.resolve({ didReset: false, cloneFailed: false })
    );
    await run(makeSigner(), {
      enumeratePreviewSchemas: () =>
        Promise.resolve([
          { schemaName: "preview_a", branch: MERGE_QUEUE_REF },
          { schemaName: "preview_b", branch: undefined },
        ]),
      applyToSchema,
      logger: makeLogger(),
    });

    expect(applyToSchema).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "preview_a",
      expect.any(Number),
      expect.any(Function),
      MERGE_QUEUE_REF
    );
    expect(applyToSchema).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "preview_b",
      expect.any(Number),
      expect.any(Function),
      undefined
    );
  });
});

describe("defaultApplyToSchema — queue-ref clone skip via the walk (ISS-5285)", () => {
  /**
   * Pipeline overrides for the PRODUCTION walk adapter: the gate invokes its
   * callback (as production does) and runMigrate reports a reset, so the
   * adapter's own branch-forwarding into the shared core is what decides
   * whether the clone runs.
   */
  function makePipelineOverrides(opts: { reset: boolean }) {
    return {
      probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(false)),
      withMigrationSerializeLock: vi.fn(
        (_opts: { databaseUrl: string }, fn: () => Promise<boolean>) => fn()
      ),
      prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
      plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
      runMigrate: vi.fn(() => Promise.resolve(opts.reset)),
      cloneDataFromPublic: vi.fn(() => Promise.resolve(true)),
      sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    };
  }

  it("a walk-triggered reset of a queue-ref schema skips the clone (skipped ≠ failed)", async () => {
    const overrides = makePipelineOverrides({ reset: true });
    const result = await defaultApplyToSchema(
      `${BASE_URL}?schema=preview_q`,
      "preview_q",
      60_000,
      () => Promise.resolve(`${BASE_URL}?schema=preview_q&token=fresh`),
      MERGE_QUEUE_REF,
      overrides
    );

    expect(overrides.runMigrate).toHaveBeenCalledTimes(1);
    expect(overrides.cloneDataFromPublic).not.toHaveBeenCalled();
    // The fail-closed correctness-index build (ISS-4437) is not part of the
    // skip — same pin as the direct-call pipeline test.
    expect(overrides.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledTimes(
      1
    );
    expect(result).toEqual({
      didReset: true,
      cloneFailed: false,
      invalidIndexes: [],
    });
  });

  it("a walk-triggered reset of a non-queue schema still clones", async () => {
    const overrides = makePipelineOverrides({ reset: true });
    const result = await defaultApplyToSchema(
      `${BASE_URL}?schema=preview_q`,
      "preview_q",
      60_000,
      () => Promise.resolve(`${BASE_URL}?schema=preview_q&token=fresh`),
      "feat/my-branch",
      overrides
    );

    expect(overrides.cloneDataFromPublic).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      didReset: true,
      cloneFailed: false,
      invalidIndexes: [],
    });
  });
});

describe("defaultEnumeratePreviewSchemas", () => {
  function makeClient(
    onQuery: (sql: string) => Promise<{ rows: unknown[] }>
  ): SqlClient {
    return {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn((text: string) => onQuery(text)),
    };
  }

  it("returns only real preview schemas with their registry branch (defensive isPreviewSchema filter)", async () => {
    let capturedSql = "";
    const client = makeClient((sql) => {
      capturedSql = sql;
      return Promise.resolve({
        rows: [
          { schema_name: "preview_alpha", branch: MERGE_QUEUE_REF },
          { schema_name: "public", branch: "main" }, // must be filtered out
          { schema_name: "previewXnot" }, // no underscore — not a preview schema
          { schema_name: 123 }, // malformed — dropped
          { schema_name: "preview_beta", branch: null }, // unregistered → undefined
        ],
      });
    });
    const entries = await defaultEnumeratePreviewSchemas(
      BASE_URL,
      () => client
    );
    // Pin the projection: the fake returns `branch` regardless, so without this
    // the production query could drop `r.branch AS branch` and stay green —
    // silently sending queue resets back through the full clone (ISS-5285).
    expect(capturedSql).toContain("r.branch AS branch");
    expect(entries).toEqual([
      { schemaName: "preview_alpha", branch: MERGE_QUEUE_REF },
      { schemaName: "preview_beta", branch: undefined },
    ]);
  });

  it("drops a non-canonical name whose seed target would normalize to a different schema", async () => {
    // `preview_foo-bar` is a valid quoted identifier, but the seed path would
    // normalize PGSCHEMA to `preview_foo_bar` and write into the wrong schema if
    // both exist. Only canonical (normalizer fixed-point) names are walkable.
    const client = makeClient(() =>
      Promise.resolve({
        rows: [
          { schema_name: "preview_foo-bar" },
          { schema_name: "preview_foo_bar" },
        ],
      })
    );
    const entries = await defaultEnumeratePreviewSchemas(
      BASE_URL,
      () => client
    );
    expect(entries).toEqual([
      { schemaName: "preview_foo_bar", branch: undefined },
    ]);
  });

  it("falls back to the plain catalog scan when the registry table is missing (42P01)", async () => {
    const seen: string[] = [];
    const client = makeClient((sql) => {
      seen.push(sql);
      if (sql.includes("preview_schemas")) {
        return Promise.reject(
          Object.assign(
            new Error('relation "preview_schemas" does not exist'),
            {
              code: "42P01",
            }
          )
        );
      }
      return Promise.resolve({ rows: [{ schema_name: "preview_only" }] });
    });
    const entries = await defaultEnumeratePreviewSchemas(
      BASE_URL,
      () => client
    );
    expect(entries).toEqual([
      { schemaName: "preview_only", branch: undefined },
    ]);
    // First tried the registry join, then the plain fallback.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("preview_schemas");
    expect(seen[1]).not.toContain("preview_schemas");
  });

  it("escapes the LIKE wildcard so the `_` in `preview_` is a literal", async () => {
    let capturedSql = "";
    const client = makeClient((sql) => {
      capturedSql = sql;
      return Promise.resolve({ rows: [] });
    });
    await defaultEnumeratePreviewSchemas(BASE_URL, () => client);
    expect(capturedSql).toContain(String.raw`LIKE 'preview\_%' ESCAPE '\'`);
  });
});

describe("isPreviewMigratorEnabled (kill-switch)", () => {
  it("is disabled when unset", () => {
    expect(isPreviewMigratorEnabled({})).toBe(false);
  });

  it("is disabled for falsey-looking strings (the =false / =0 foot-gun)", () => {
    expect(
      isPreviewMigratorEnabled({ PREVIEW_MIGRATOR_ENABLED: "false" })
    ).toBe(false);
    expect(isPreviewMigratorEnabled({ PREVIEW_MIGRATOR_ENABLED: "0" })).toBe(
      false
    );
    expect(isPreviewMigratorEnabled({ PREVIEW_MIGRATOR_ENABLED: "" })).toBe(
      false
    );
    expect(isPreviewMigratorEnabled({ PREVIEW_MIGRATOR_ENABLED: "nope" })).toBe(
      false
    );
  });

  it("is enabled only for explicit truthy tokens", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(isPreviewMigratorEnabled({ PREVIEW_MIGRATOR_ENABLED: raw })).toBe(
        true
      );
    }
  });
});
