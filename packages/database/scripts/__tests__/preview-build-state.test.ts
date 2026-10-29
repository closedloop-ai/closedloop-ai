import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePipelineDeps } from "../../__tests__/support/migration-pipeline.test-fixtures";
import { normalizePreviewSchemaName } from "../../schema-utils";
import { CloneFailedError } from "../clone-schema";
import { defaultApplyToSchema } from "../migrate-all-previews";
import { runMigrationPipeline } from "../migration-pipeline";
import {
  clearIncompletePreviewBuild,
  formatIncompletePreviewBuild,
  hasIncompletePreviewBuild,
  readIncompletePreviewBuild,
} from "../preview-build-state";
import { dropSchema, ensureSchemaExists } from "../preview-schema";
import {
  formatVibeEnvironmentMarker,
  readVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  writeVibeEnvironmentMarker,
} from "../vibe-environment";

const databaseUrl = "postgres://x";
const mockCreateSslClient = vi.hoisted(() => vi.fn());
const commentLiteralPattern = / IS '(.*)'$/;
const escapedQuotePattern = /''/g;
vi.mock("../db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db-utils")>();
  return { ...actual, createSslClient: mockCreateSslClient };
});

beforeEach(() => mockCreateSslClient.mockReset());

describe("durable protected preview build state", () => {
  it.each([
    null,
    "old operator comment",
    "{}",
    formatVibeEnvironmentMarker({
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    }),
  ])("preserves old or explicit environment comments: %s", (comment) => {
    expect(hasIncompletePreviewBuild(comment)).toBe(false);
  });

  it.each([
    formatIncompletePreviewBuild(),
    '{"closedloopPreviewBuild":null}',
    '{"closedloopPreviewBuild":{"state":"unknown"}}',
  ])(
    "unknown or malformed additive build metadata blocks success: %s",
    (comment) => {
      expect(hasIncompletePreviewBuild(comment)).toBe(true);
    }
  );

  it.each(["vibe/retry", undefined])(
    "failed clone then at-head retry retains incomplete state with branch=%s",
    async (branch) => {
      const fixture = buildFixture();
      const schema = normalizePreviewSchemaName("vibe/retry");
      const error = new CloneFailedError(schema, new Error("clone failed"));
      fixture.deps.cloneDataFromPublic.mockRejectedValueOnce(error);
      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, fixture.deps)
      ).rejects.toBe(error);
      expect(fixture.catalog.exists).toBe(true);
      expect(hasIncompletePreviewBuild(fixture.catalog.comment)).toBe(true);
      expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
      fixture.deps.probePreviewSchemaAtHead.mockResolvedValue(true);
      fixture.deps.cloneDataFromPublic.mockClear();
      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, fixture.deps)
      ).rejects.toBeInstanceOf(CloneFailedError);
      expect(fixture.deps.probePreviewSchemaAtHead).not.toHaveBeenCalled();
      expect(fixture.deps.runMigrate).not.toHaveBeenCalled();
      expect(fixture.deps.cloneDataFromPublic).not.toHaveBeenCalled();
      expect(fixture.deps.clearIncompletePreviewBuild).not.toHaveBeenCalled();
      expect(fixture.deps.runPreviewSeed).not.toHaveBeenCalled();
      expect(fixture.catalog.exists).toBe(true);
    }
  );

  it.each([
    formatIncompletePreviewBuild(),
    '{"closedloopPreviewBuild":null}',
    '{"closedloopPreviewBuild":{"state":"unknown"}}',
  ])(
    "maintenance refuses incomplete or unknown metadata before probing head: %s",
    async (comment) => {
      const fixture = buildFixture();
      fixture.catalog.exists = true;
      fixture.catalog.comment = comment;
      fixture.deps.probePreviewSchemaAtHead.mockResolvedValue(true);
      await expect(
        defaultApplyToSchema(
          databaseUrl,
          normalizePreviewSchemaName("vibe/retry"),
          5000,
          async () => databaseUrl,
          undefined,
          fixture.deps
        )
      ).rejects.toBeInstanceOf(CloneFailedError);
      expect(fixture.deps.probePreviewSchemaAtHead).not.toHaveBeenCalled();
      expect(fixture.deps.runMigrate).not.toHaveBeenCalled();
      expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    "old operator comment",
    formatVibeEnvironmentMarker({
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    }),
  ])(
    "legacy schema comments still allow ordinary maintenance: %s",
    async (comment) => {
      const fixture = buildFixture();
      fixture.catalog.exists = true;
      fixture.catalog.comment = comment;
      fixture.deps.probePreviewSchemaAtHead.mockResolvedValue(true);
      await defaultApplyToSchema(
        databaseUrl,
        normalizePreviewSchemaName("vibe/legacy"),
        5000,
        async () => databaseUrl,
        "vibe/legacy",
        fixture.deps
      );
      expect(fixture.deps.probePreviewSchemaAtHead).toHaveBeenCalledOnce();
      expect(fixture.catalog.comment).toBe(comment);
      expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
    }
  );

  it("a failed public replay remains incomplete on the second build", async () => {
    const fixture = buildFixture();
    fixture.deps.replayPendingMigrationsViaSql.mockResolvedValue(false);
    const schema = normalizePreviewSchemaName("vibe/replay");
    await expect(
      runMigrationPipeline(databaseUrl, schema, "vibe/replay", fixture.deps)
    ).rejects.toThrow("the replay of public's migrations did not complete");
    fixture.deps.replayPendingMigrationsViaSql.mockClear();
    await expect(
      runMigrationPipeline(databaseUrl, schema, "vibe/replay", fixture.deps)
    ).rejects.toBeInstanceOf(CloneFailedError);
    expect(fixture.deps.replayPendingMigrationsViaSql).not.toHaveBeenCalled();
    expect(hasIncompletePreviewBuild(fixture.catalog.comment)).toBe(true);
    expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
  });

  it("complete build clears its marker and a repeat may skip at head", async () => {
    const fixture = buildFixture();
    const schema = normalizePreviewSchemaName("vibe/complete");
    await runMigrationPipeline(
      databaseUrl,
      schema,
      "vibe/complete",
      fixture.deps
    );
    expect(fixture.catalog.comment).toBeNull();
    expect(
      fixture.deps.clearIncompletePreviewBuild
    ).toHaveBeenCalledExactlyOnceWith(databaseUrl, schema);
    fixture.deps.probePreviewSchemaAtHead.mockResolvedValue(true);
    fixture.deps.probePreviewSchemaAtHead.mockClear();
    await runMigrationPipeline(
      databaseUrl,
      schema,
      "vibe/complete",
      fixture.deps
    );
    expect(fixture.deps.probePreviewSchemaAtHead).toHaveBeenCalledOnce();
    expect(fixture.deps.cloneDataFromPublic).toHaveBeenCalledOnce();
  });

  it("completion uses the refreshed migration connection after the clone", async () => {
    const fixture = buildFixture();
    const refreshedUrl = "postgres://refreshed";
    fixture.deps.refreshDatabaseUrl = vi.fn(() =>
      Promise.resolve(refreshedUrl)
    );
    const schema = normalizePreviewSchemaName("vibe/refreshed");
    await runMigrationPipeline(
      databaseUrl,
      schema,
      "vibe/refreshed",
      fixture.deps
    );
    expect(
      fixture.deps.clearIncompletePreviewBuild
    ).toHaveBeenCalledExactlyOnceWith(refreshedUrl, schema);
    expect(fixture.catalog.comment).toBeNull();
  });

  it("marker completion failure fails the build and keeps the next build blocked", async () => {
    const fixture = buildFixture();
    fixture.catalog.failClear = true;
    const schema = normalizePreviewSchemaName("vibe/complete-failed");
    await expect(
      runMigrationPipeline(
        databaseUrl,
        schema,
        "vibe/complete-failed",
        fixture.deps
      )
    ).rejects.toThrow("comment failed");
    expect(hasIncompletePreviewBuild(fixture.catalog.comment)).toBe(true);
    await expect(
      runMigrationPipeline(
        databaseUrl,
        schema,
        "vibe/complete-failed",
        fixture.deps
      )
    ).rejects.toBeInstanceOf(CloneFailedError);
    expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
  });

  it("creation and marker are atomic when the marker write fails", async () => {
    const fixture = buildFixture();
    fixture.catalog.failMark = true;
    await expect(
      ensureSchemaExists(databaseUrl, normalizePreviewSchemaName("vibe/atomic"))
    ).rejects.toThrow("comment failed");
    expect(fixture.catalog.exists).toBe(false);
    expect(fixture.catalog.comment).toBeNull();
    expect(fixture.issued).toContain("ROLLBACK");
    expect(fixture.issued).not.toContain("COMMIT");
  });

  it.each([VibeEnvironmentMode.Blank, VibeEnvironmentMode.Seeded])(
    "explicit %s rebuild repairs retained partial state without cloning",
    async (mode) => {
      const fixture = buildFixture();
      fixture.catalog.exists = true;
      fixture.catalog.comment = formatIncompletePreviewBuild();
      const schema = normalizePreviewSchemaName("vibe/repair");
      await runMigrationPipeline(
        databaseUrl,
        schema,
        "vibe/repair",
        fixture.deps,
        { vibeEnvironment: mode }
      );
      expect(fixture.deps.dropSchema).toHaveBeenCalledExactlyOnceWith(
        databaseUrl,
        schema
      );
      expect(fixture.catalog.comment).toBe(
        formatVibeEnvironmentMarker({
          mode,
          state:
            mode === VibeEnvironmentMode.Blank
              ? VibeEnvironmentState.Ready
              : VibeEnvironmentState.Pending,
        })
      );
      expect(fixture.deps.cloneDataFromPublic).not.toHaveBeenCalled();
      expect(fixture.deps.runPreviewSeed).not.toHaveBeenCalled();
    }
  );

  it.each(["feat/ordinary", "andy/ordinary", "vibe-lookalike"])(
    "ordinary %s still completes and failed clones still drop",
    async (branch) => {
      const fixture = buildFixture();
      const schema = normalizePreviewSchemaName(branch);
      fixture.deps.cloneDataFromPublic.mockRejectedValueOnce(
        new CloneFailedError(schema, new Error("clone failed"))
      );
      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, fixture.deps)
      ).rejects.toBeInstanceOf(CloneFailedError);
      expect(fixture.catalog.exists).toBe(false);
      await runMigrationPipeline(databaseUrl, schema, branch, fixture.deps);
      expect(fixture.catalog.exists).toBe(true);
      expect(hasIncompletePreviewBuild(fixture.catalog.comment)).toBe(false);
      expect(fixture.deps.readIncompletePreviewBuild).not.toHaveBeenCalled();
    }
  );

  it("completed ordinary prefix lookalikes still allow missing-provenance maintenance", async () => {
    const fixture = buildFixture();
    const schema = normalizePreviewSchemaName("vibe-lookalike");
    await runMigrationPipeline(
      databaseUrl,
      schema,
      "vibe-lookalike",
      fixture.deps
    );
    expect(fixture.catalog.comment).toBeNull();
    fixture.deps.probePreviewSchemaAtHead.mockResolvedValue(true);
    await defaultApplyToSchema(
      databaseUrl,
      schema,
      5000,
      async () => databaseUrl,
      undefined,
      fixture.deps
    );
    expect(
      fixture.deps.readIncompletePreviewBuild
    ).toHaveBeenCalledExactlyOnceWith(databaseUrl, schema);
  });

  it("ordinary lookalike retries complete after a post-clone migration failure", async () => {
    const fixture = buildFixture();
    const branch = "vibe-lookalike";
    const schema = normalizePreviewSchemaName(branch);
    const error = new Error("branch migration failed");
    fixture.deps.runMigrate.mockRejectedValueOnce(error);
    await expect(
      runMigrationPipeline(databaseUrl, schema, branch, fixture.deps)
    ).rejects.toBe(error);
    expect(hasIncompletePreviewBuild(fixture.catalog.comment)).toBe(true);
    expect(fixture.catalog.exists).toBe(true);
    await runMigrationPipeline(databaseUrl, schema, branch, fixture.deps);
    expect(fixture.catalog.comment).toBeNull();
    expect(fixture.deps.cloneDataFromPublic).toHaveBeenCalledOnce();
    await defaultApplyToSchema(
      databaseUrl,
      schema,
      5000,
      async () => databaseUrl,
      undefined,
      fixture.deps
    );
  });

  it("completion preserves other additive schema-comment fields", async () => {
    const fixture = buildFixture();
    fixture.catalog.comment =
      '{"closedloopPreviewBuild":{"state":"incomplete"},"existing":"value"}';
    await clearIncompletePreviewBuild(
      databaseUrl,
      normalizePreviewSchemaName("vibe/comment")
    );
    expect(fixture.catalog.comment).toBe('{"existing":"value"}');
  });
});

/** Execute the real ensure/comment/repair adapters against a durable catalog-shaped fake. */
function buildFixture() {
  const catalog = {
    exists: false,
    comment: null as string | null,
    failMark: false,
    failClear: false,
  };
  const issued: string[] = [];
  let beforeCreate: { exists: boolean; comment: string | null } | undefined;
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string) => {
      issued.push(sql);
      if (sql.includes("information_schema.schemata")) {
        return Promise.resolve({ rows: catalog.exists ? [{}] : [] });
      }
      if (sql.includes("obj_description")) {
        return Promise.resolve({ rows: [{ comment: catalog.comment }] });
      }
      if (sql === "BEGIN") {
        beforeCreate = { exists: catalog.exists, comment: catalog.comment };
      } else if (sql === "ROLLBACK" && beforeCreate) {
        Object.assign(catalog, beforeCreate);
      } else if (sql.startsWith("CREATE SCHEMA")) {
        catalog.exists = true;
      } else if (sql.startsWith("DROP SCHEMA")) {
        catalog.exists = false;
        catalog.comment = null;
      } else if (sql.startsWith("COMMENT ON SCHEMA")) {
        const comment = sql.endsWith(" IS NULL")
          ? null
          : (commentLiteralPattern
              .exec(sql)?.[1]
              ?.replace(escapedQuotePattern, "'") ?? null);
        if (
          (catalog.failMark && comment !== null) ||
          (catalog.failClear && comment === null)
        ) {
          return Promise.reject(new Error("comment failed"));
        }
        catalog.comment = comment;
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  mockCreateSslClient.mockImplementation(() => client as unknown as pg.Client);
  const deps = makePipelineDeps({ replayed: true });
  deps.ensureSchemaExists.mockImplementation(ensureSchemaExists);
  deps.dropSchema.mockImplementation(dropSchema);
  deps.readVibeEnvironmentMarker.mockImplementation(readVibeEnvironmentMarker);
  deps.writeVibeEnvironmentMarker.mockImplementation(
    writeVibeEnvironmentMarker
  );
  deps.readIncompletePreviewBuild.mockImplementation(
    readIncompletePreviewBuild
  );
  deps.clearIncompletePreviewBuild.mockImplementation(
    clearIncompletePreviewBuild
  );
  return { catalog, issued, deps };
}
