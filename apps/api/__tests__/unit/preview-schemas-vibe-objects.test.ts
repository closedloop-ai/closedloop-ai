/**
 * ISS-12056: a vibe environment's S3 objects (everything under
 * `vibe-environments/<schema>/` in the shared buckets) are deleted with its
 * schema, on the branch drop path and by the daily sweep, and an S3 failure
 * never turns a completed DROP into a failed one.
 *
 * S3 is a small in-memory fake behind the mocked `@repo/aws` helpers, with
 * key-ordered continuation tokens like S3's, so the assertions read which
 * objects are left in each bucket rather than which calls were made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockWithMigratorClient,
  mockListAllBranchNames,
  awsMocks,
  bucketConfig,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
  mockListAllBranchNames: vi.fn(),
  awsMocks: {
    listObjects: vi.fn(),
    listCommonPrefixes: vi.fn(),
    deleteObjects: vi.fn(),
  },
  bucketConfig: {
    TRANSCRIPTS_BUCKET: "transcripts-bucket" as string | undefined,
    FILE_ATTACHMENTS_BUCKET: "attachments-bucket" as string | undefined,
    PLUGIN_STORE_BUCKET: "attachments-bucket" as string | undefined,
  },
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

vi.mock("@repo/aws", () => awsMocks);

// A two-key page forces the multi-page and page-cap paths with small fixtures.
vi.mock("@repo/aws/s3-client", () => ({
  config: bucketConfig,
  S3_BATCH_DELETE_MAX_KEYS: 2,
}));

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { makeCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { vibeEnvironmentKeyPrefix } from "@repo/database/scripts/vibe-environment";
import { log } from "@repo/observability/log";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import {
  emptyVibeObjectCleanupReport,
  summarizeSweep,
  sweepOrphanedVibeObjects,
  VIBE_OBJECT_PAGES_PER_PREFIX,
  VIBE_ORPHAN_PREFIXES_PER_SWEEP,
  VIBE_PREFIX_LISTING_PAGES,
} from "@/app/preview-schemas/service/vibe-object-cleanup";
import { createPreviewSchemaMocks, readSqlText } from "./preview-schemas-mocks";

const {
  mockCleanupStaleObservationsSuccess,
  mockDropFailure,
  mockDropSuccess,
  mockListSchemas,
  mockRegistryRow,
  mockSchemaExists,
  mockTransactionalDropOnce,
} = createPreviewSchemaMocks(
  mockWithDb,
  mockListAllBranchNames,
  mockWithMigratorClient
);

const TRANSCRIPTS = "transcripts-bucket";
const ATTACHMENTS = "attachments-bucket";
const BRANCH = "feat/vibe-env";
const SCHEMA = normalizePreviewSchemaName(BRANCH);
const PREFIX = vibeEnvironmentKeyPrefix(SCHEMA);
const OTHER_SCHEMA = "preview_other_env_1234abcd";
const OTHER_PREFIX = vibeEnvironmentKeyPrefix(OTHER_SCHEMA);
const STAGE_KEY = "attachments/org/doc/file";
const NEVER_EXHAUSTED = { isExhausted: () => false };

/** Bucket name to its keys. */
const store = new Map<string, Set<string>>();

function seed(bucket: string, keys: string[]): void {
  const existing = store.get(bucket) ?? new Set<string>();
  for (const key of keys) {
    existing.add(key);
  }
  store.set(bucket, existing);
}

function keysIn(bucket: string): string[] {
  return [...(store.get(bucket) ?? [])].sort();
}

function installFakeS3(): void {
  awsMocks.listObjects.mockImplementation(
    (options: {
      bucket: string;
      prefix: string;
      continuationToken?: string;
      maxKeys: number;
    }) => {
      const after = options.continuationToken ?? "";
      const matching = keysIn(options.bucket).filter(
        (key) => key.startsWith(options.prefix) && key > after
      );
      const page = matching.slice(0, options.maxKeys);
      return Promise.resolve({
        objects: page.map((key) => ({ key })),
        nextContinuationToken:
          matching.length > page.length ? page.at(-1) : undefined,
      });
    }
  );
  awsMocks.listCommonPrefixes.mockImplementation(
    (options: { bucket: string; prefix: string }) => {
      const prefixes = new Set<string>();
      for (const key of keysIn(options.bucket)) {
        if (key.startsWith(options.prefix)) {
          const rest = key.slice(options.prefix.length);
          const slash = rest.indexOf("/");
          if (slash !== -1) {
            prefixes.add(`${options.prefix}${rest.slice(0, slash + 1)}`);
          }
        }
      }
      return Promise.resolve({
        prefixes: [...prefixes],
        nextContinuationToken: undefined,
      });
    }
  );
  awsMocks.deleteObjects.mockImplementation(
    (keys: string[], bucket: string) => {
      for (const key of keys) {
        store.get(bucket)?.delete(key);
      }
      return Promise.resolve();
    }
  );
}

/** The `pg_namespace` lookup of the sweep's orphan pass, one per bucket. */
function mockExistingSchemasOnce(existing: string[]): { queries: unknown[] } {
  const queries: unknown[] = [];
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      $queryRaw: (query: unknown) => {
        queries.push(query);
        return Promise.resolve(existing.map((nspname) => ({ nspname })));
      },
    })
  );
  return { queries };
}

beforeEach(() => {
  store.clear();
  mockWithDb.mockReset();
  mockWithMigratorClient.mockReset();
  mockListAllBranchNames.mockResolvedValue(["main"]);
  bucketConfig.TRANSCRIPTS_BUCKET = TRANSCRIPTS;
  bucketConfig.FILE_ATTACHMENTS_BUCKET = ATTACHMENTS;
  bucketConfig.PLUGIN_STORE_BUCKET = ATTACHMENTS;
  installFakeS3();
});

describe("dropSchemaForBranch deletes the dropped environment's objects", () => {
  it("empties the schema's prefix in every bucket and leaves every other key", async () => {
    seed(TRANSCRIPTS, [
      `${PREFIX}t/1.jsonl`,
      `${PREFIX}t/2.jsonl`,
      "t/stage.jsonl",
    ]);
    seed(ATTACHMENTS, [`${PREFIX}a/1`, `${OTHER_PREFIX}a/1`, STAGE_KEY]);
    mockSchemaExists(SCHEMA, true);
    mockTransactionalDropOnce();

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(BRANCH);

    expect(result).toMatchObject({ dropped: true, error: null });
    expect(result.vibeObjects).toEqual({
      deleted: 3,
      cleared: 2,
      truncated: 0,
      errored: 0,
      deferred: 0,
    });
    expect(keysIn(TRANSCRIPTS)).toEqual(["t/stage.jsonl"]);
    expect(keysIn(ATTACHMENTS)).toEqual([STAGE_KEY, `${OTHER_PREFIX}a/1`]);
  });

  it("reports an S3 failure without failing the drop, and still clears the other bucket", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    seed(ATTACHMENTS, [`${PREFIX}a/1`]);
    awsMocks.deleteObjects.mockImplementationOnce(() =>
      Promise.reject(new Error("AccessDenied"))
    );
    mockSchemaExists(SCHEMA, true);
    mockTransactionalDropOnce();

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(BRANCH);

    expect(result).toMatchObject({
      dropped: true,
      alreadyGone: false,
      error: null,
    });
    expect(result.vibeObjects).toMatchObject({ errored: 1, cleared: 1 });
    expect(keysIn(TRANSCRIPTS)).toEqual([`${PREFIX}t/1.jsonl`]);
    expect(keysIn(ATTACHMENTS)).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      "[preview-schema-cleanup] Failed to delete vibe environment objects",
      { bucket: TRANSCRIPTS, prefix: PREFIX, error: "AccessDenied" }
    );
  });

  it("stops at the page cap and reports the prefix as truncated", async () => {
    const keys = Array.from(
      { length: VIBE_OBJECT_PAGES_PER_PREFIX * 2 + 1 },
      (_, i) => `${PREFIX}t/${String(i).padStart(3, "0")}`
    );
    seed(TRANSCRIPTS, keys);
    bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
    bucketConfig.PLUGIN_STORE_BUCKET = undefined;
    mockSchemaExists(SCHEMA, true);
    mockTransactionalDropOnce();

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(BRANCH);

    expect(result.vibeObjects).toMatchObject({
      deleted: VIBE_OBJECT_PAGES_PER_PREFIX * 2,
      cleared: 0,
      truncated: 1,
    });
    expect(
      summarizeSweep(
        makeCounters(),
        result.vibeObjects ?? emptyVibeObjectCleanupReport()
      ).exitCode
    ).toBe(1);
    expect(keysIn(TRANSCRIPTS)).toEqual([keys.at(-1)]);
  });

  it("touches no bucket when the schema was already gone", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    mockSchemaExists(SCHEMA, false);

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(BRANCH);

    expect(result).toMatchObject({ alreadyGone: true });
    expect(result.vibeObjects).toBeUndefined();
    expect(keysIn(TRANSCRIPTS)).toEqual([`${PREFIX}t/1.jsonl`]);
    expect(awsMocks.listObjects).not.toHaveBeenCalled();
  });

  it("touches no bucket when the DROP failed", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    mockSchemaExists(SCHEMA, true);
    mockWithMigratorClient.mockImplementationOnce(() =>
      Promise.reject(new Error("permission denied"))
    );

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(BRANCH);

    expect(result).toMatchObject({
      dropped: false,
      error: "permission denied",
    });
    expect(awsMocks.listObjects).not.toHaveBeenCalled();
  });
});

describe("runDailySweep deletes objects whose schema is gone", () => {
  it("deletes a schema's objects in the same run that drops the schema", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T00:00:00.000Z"));
    try {
      seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`, "t/stage.jsonl"]);
      mockListSchemas([SCHEMA]);
      mockRegistryRow({ last_seen_at: "2026-09-01T00:00:00.000Z" });
      mockDropSuccess();
      mockCleanupStaleObservationsSuccess();
      const { queries } = mockExistingSchemasOnce([]);

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].dropped).toBe(1);
      expect(result.vibeObjects).toMatchObject({ deleted: 1, cleared: 1 });
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain(
        "vibe-objects[deleted=1 cleared=1 truncated=0 errored=0 deferred=0]"
      );
      expect(keysIn(TRANSCRIPTS)).toEqual(["t/stage.jsonl"]);
      const query = queries[0] as { values: unknown[] };
      expect(readSqlText(query)).toContain("pg_namespace");
      expect(query.values).toEqual([[SCHEMA]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes orphaned prefixes and keeps the prefix of a schema that still exists", async () => {
    seed(TRANSCRIPTS, [
      `${PREFIX}t/1.jsonl`,
      `${OTHER_PREFIX}t/1.jsonl`,
      "vibe-environments/not-a-preview/x",
    ]);
    seed(ATTACHMENTS, [`${PREFIX}a/1`, STAGE_KEY]);
    mockListSchemas([]);
    mockCleanupStaleObservationsSuccess();
    mockExistingSchemasOnce([OTHER_SCHEMA]);
    mockExistingSchemasOnce([]);

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.vibeObjects).toMatchObject({ deleted: 2, cleared: 2 });
    expect(keysIn(TRANSCRIPTS)).toEqual([
      "vibe-environments/not-a-preview/x",
      `${OTHER_PREFIX}t/1.jsonl`,
    ]);
    expect(keysIn(ATTACHMENTS)).toEqual([STAGE_KEY]);
    expect(result.exitCode).toBe(0);
  });

  it("fails the exit code on an S3 listing failure but keeps the schema counters clean", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    awsMocks.listCommonPrefixes.mockImplementationOnce(() =>
      Promise.reject(new Error("SlowDown"))
    );
    mockListSchemas([]);
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.vibeObjects.errored).toBe(1);
    expect(result.counters["ttl-expired"].errored).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(keysIn(TRANSCRIPTS)).toEqual([`${PREFIX}t/1.jsonl`]);
  });

  it("deletes nothing when the schema lookup fails", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
    bucketConfig.PLUGIN_STORE_BUCKET = undefined;
    mockListSchemas([]);
    mockCleanupStaleObservationsSuccess();
    mockWithDb.mockImplementationOnce(() =>
      Promise.reject(new Error("connection reset"))
    );

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.vibeObjects.errored).toBe(1);
    expect(keysIn(TRANSCRIPTS)).toEqual([`${PREFIX}t/1.jsonl`]);
    expect(awsMocks.deleteObjects).not.toHaveBeenCalled();
  });

  it("reads no schema and lists no bucket when no bucket is configured", async () => {
    bucketConfig.TRANSCRIPTS_BUCKET = undefined;
    bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
    bucketConfig.PLUGIN_STORE_BUCKET = undefined;
    mockListSchemas([]);
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.exitCode).toBe(0);
    expect(mockWithDb).toHaveBeenCalledTimes(2);
    expect(awsMocks.listCommonPrefixes).not.toHaveBeenCalled();
  });

  it("leaves a dropped schema's objects alone when the DROP failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T00:00:00.000Z"));
    try {
      seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
      bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
      bucketConfig.PLUGIN_STORE_BUCKET = undefined;
      mockListSchemas([SCHEMA]);
      mockRegistryRow({ last_seen_at: "2026-09-01T00:00:00.000Z" });
      mockDropFailure("permission denied");
      mockCleanupStaleObservationsSuccess();
      mockExistingSchemasOnce([SCHEMA]);

      const result = await previewSchemaCleanupService.runDailySweep(7);

      expect(result.counters["ttl-expired"].errored).toBe(1);
      expect(keysIn(TRANSCRIPTS)).toEqual([`${PREFIX}t/1.jsonl`]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sweepOrphanedVibeObjects bounds", () => {
  it("defers orphans past the per-sweep cap to the next run", async () => {
    bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
    bucketConfig.PLUGIN_STORE_BUCKET = undefined;
    const schemas = Array.from(
      { length: VIBE_ORPHAN_PREFIXES_PER_SWEEP + 2 },
      (_, i) => `preview_orphan_${String(i).padStart(3, "0")}`
    );
    seed(
      TRANSCRIPTS,
      schemas.map((schema) => `${vibeEnvironmentKeyPrefix(schema)}k`)
    );
    mockExistingSchemasOnce([]);

    const report = await sweepOrphanedVibeObjects(NEVER_EXHAUSTED);

    expect(report).toMatchObject({
      cleared: VIBE_ORPHAN_PREFIXES_PER_SWEEP,
      deferred: 2,
    });
    expect(summarizeSweep(makeCounters(), report).exitCode).toBe(1);
    expect(keysIn(TRANSCRIPTS)).toHaveLength(2);
  });

  it("reports a prefix listing that hits its page cap as incomplete", async () => {
    bucketConfig.FILE_ATTACHMENTS_BUCKET = undefined;
    bucketConfig.PLUGIN_STORE_BUCKET = undefined;
    const schemas = Array.from(
      { length: VIBE_PREFIX_LISTING_PAGES },
      (_, index) => `preview_existing_${index}`
    );
    awsMocks.listCommonPrefixes.mockImplementation(
      (options: { continuationToken?: string }) => {
        const index = Number(options.continuationToken ?? "0");
        return Promise.resolve({
          prefixes: [vibeEnvironmentKeyPrefix(schemas[index] ?? "")],
          nextContinuationToken: String(index + 1),
        });
      }
    );
    mockExistingSchemasOnce(schemas);

    const report = await sweepOrphanedVibeObjects(NEVER_EXHAUSTED);

    expect(report).toEqual({
      deleted: 0,
      cleared: 0,
      truncated: 1,
      errored: 0,
      deferred: 0,
    });
    expect(awsMocks.listCommonPrefixes).toHaveBeenCalledTimes(
      VIBE_PREFIX_LISTING_PAGES
    );
    expect(summarizeSweep(makeCounters(), report).exitCode).toBe(1);
  });

  it("defers every orphan once the sweep budget is spent", async () => {
    seed(TRANSCRIPTS, [`${PREFIX}t/1.jsonl`]);
    seed(ATTACHMENTS, [`${OTHER_PREFIX}a/1`]);
    mockExistingSchemasOnce([]);
    mockExistingSchemasOnce([]);

    const report = await sweepOrphanedVibeObjects({ isExhausted: () => true });

    expect(report).toMatchObject({ deferred: 2, cleared: 0, deleted: 0 });
    expect(awsMocks.deleteObjects).not.toHaveBeenCalled();
  });
});
