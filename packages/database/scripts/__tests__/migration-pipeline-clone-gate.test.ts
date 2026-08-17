import { describe, expect, it, vi } from "vitest";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
  runMigrationPipeline,
} from "../migration-pipeline";

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
    withMigrationSerializeLock: vi.fn((_opts, fn) => fn()),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runMigrate: vi.fn(() => Promise.resolve(false)),
    cloneDataFromPublic: vi.fn(() => Promise.resolve(true)),
    runPreviewSeed: vi.fn(),
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
