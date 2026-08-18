import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  buildPreviewMigratorDeps,
  DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS,
  defaultEnumeratePreviewSchemas,
  migrateAllPreviewSchemas,
  resolvePreviewMigratorBudgetMs,
} from "../scripts/migrate-all-previews";

/*
 * Config resolution and defaulting for the preview-migrator walk, split from
 * migrate-all-previews.test.ts (which owns the walk itself and is already near
 * the 500-line smell).
 *
 * The budget is the interesting part. It is read from an env var, and a bad
 * value has no loud failure mode: a NaN or zero budget makes the walk skip
 * every schema on its first deadline check and report them as budget-skipped,
 * which reads as a healthy short walk rather than a misconfiguration.
 */

const BASE_URL = "postgresql://u@stage-host:5432/app";

describe("resolvePreviewMigratorBudgetMs", () => {
  it("falls back to the default when the var is unset", () => {
    expect(resolvePreviewMigratorBudgetMs({})).toBe(
      DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS
    );
  });

  it("reads an explicit budget", () => {
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "45000" })
    ).toBe(45_000);
  });

  it("REFUSES a non-numeric value rather than propagating NaN", () => {
    // NaN > 0 is false, so every deadline comparison would be false and the
    // walk would skip everything while reporting success.
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "soon" })
    ).toBe(DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS);
  });

  it("REFUSES zero and negative budgets", () => {
    // A zero budget is indistinguishable from "walk nothing".
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "0" })
    ).toBe(DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS);
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "-1" })
    ).toBe(DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS);
  });

  it("REFUSES a non-finite budget", () => {
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "Infinity" })
    ).toBe(DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS);
  });

  it("treats an empty string as unset rather than as zero", () => {
    // Number("") is 0, which the > 0 guard rejects — the same outcome as unset,
    // but reached by the other branch.
    expect(
      resolvePreviewMigratorBudgetMs({ PREVIEW_MIGRATOR_BUDGET_MS: "" })
    ).toBe(DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS);
  });

  it("reads process.env when given no explicit environment", () => {
    const previous = process.env.PREVIEW_MIGRATOR_BUDGET_MS;
    process.env.PREVIEW_MIGRATOR_BUDGET_MS = "12345";
    try {
      expect(resolvePreviewMigratorBudgetMs()).toBe(12_345);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "PREVIEW_MIGRATOR_BUDGET_MS");
      } else {
        process.env.PREVIEW_MIGRATOR_BUDGET_MS = previous;
      }
    }
  });
});

describe("buildPreviewMigratorDeps", () => {
  it("carries the resolved budget and leaves the rest defaulted", () => {
    const deps = buildPreviewMigratorDeps({
      PREVIEW_MIGRATOR_BUDGET_MS: "60000",
    });

    expect(deps.budgetMs).toBe(60_000);
    // Sign/enumerate/apply must stay unset so the walk binds its own
    // fail-closed defaults rather than an env-derived stand-in.
    expect(deps.enumeratePreviewSchemas).toBeUndefined();
    expect(deps.applyToSchema).toBeUndefined();
  });

  it("reads process.env when given no explicit environment", () => {
    expect(buildPreviewMigratorDeps().budgetMs).toBeTypeOf("number");
  });
});

describe("migrateAllPreviewSchemas — defaulted collaborators", () => {
  it("runs with only an enumeration override, defaulting logger and budget", async () => {
    // Exercises the `??` defaults for logger/seed/now/budget in one pass: an
    // empty enumeration ends the walk before any of them would misbehave.
    const summary = await migrateAllPreviewSchemas(
      BASE_URL,
      () => Promise.resolve(BASE_URL),
      { enumeratePreviewSchemas: () => Promise.resolve([]) }
    );

    expect(summary.discovered).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("logs a non-Error failure as a string instead of [object Object]", async () => {
    // A rejected promise can carry anything. The summary carries only counts,
    // so the warning line is the operator's ONLY view of why a schema failed —
    // it must not render an unhelpful cast.
    const logger = { log: vi.fn(), warn: vi.fn() };

    const summary = await migrateAllPreviewSchemas(
      BASE_URL,
      () => Promise.resolve(BASE_URL),
      {
        applyToSchema: () => Promise.reject("pool exhausted"),
        budgetMs: 60_000,
        enumeratePreviewSchemas: () =>
          Promise.resolve([{ branch: undefined, schemaName: "preview_a" }]),
        logger,
        now: () => 0,
      }
    );

    expect(summary.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("pool exhausted")
    );
  });
});

describe("defaultEnumeratePreviewSchemas — error passthrough", () => {
  function clientThatFails(error: unknown): () => SqlClient {
    return () =>
      ({
        connect: () => Promise.resolve(),
        end: () => Promise.resolve(),
        query: () => Promise.reject(error),
      }) as unknown as SqlClient;
  }

  it("RETHROWS a failure that is not the missing-registry-table case", async () => {
    // Only 42P01 (undefined_table) means "registry not deployed yet" and earns
    // the plain-catalog fallback. Swallowing anything else would turn a real
    // outage into a silent zero-schema walk.
    const boom = Object.assign(new Error("permission denied"), {
      code: "42501",
    });

    await expect(
      defaultEnumeratePreviewSchemas(BASE_URL, clientThatFails(boom))
    ).rejects.toThrow("permission denied");
  });

  it("RETHROWS when the error carries no SQLSTATE at all", async () => {
    // `extractSqlstate` returns undefined for a non-string code, which must not
    // be mistaken for the fallback case.
    await expect(
      defaultEnumeratePreviewSchemas(
        BASE_URL,
        clientThatFails(
          Object.assign(new Error("socket hang up"), { code: 42 })
        )
      )
    ).rejects.toThrow("socket hang up");
  });

  it("tolerates a driver that returns no rows array", async () => {
    const client = () =>
      ({
        connect: () => Promise.resolve(),
        end: () => Promise.resolve(),
        query: () => Promise.resolve({}),
      }) as unknown as SqlClient;

    await expect(
      defaultEnumeratePreviewSchemas(BASE_URL, client)
    ).resolves.toEqual([]);
  });

  it("skips a row whose schema_name is not a string", async () => {
    const client = () =>
      ({
        connect: () => Promise.resolve(),
        end: () => Promise.resolve(),
        query: () =>
          Promise.resolve({
            rows: [{ schema_name: null }, { schema_name: 42 }, {}],
          }),
      }) as unknown as SqlClient;

    await expect(
      defaultEnumeratePreviewSchemas(BASE_URL, client)
    ).resolves.toEqual([]);
  });
});
