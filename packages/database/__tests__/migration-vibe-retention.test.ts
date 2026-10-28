import { describe, expect, it, vi } from "vitest";
import { normalizePreviewSchemaName } from "../schema-utils";
import { defaultApplyToSchema } from "../scripts/migrate-all-previews";
import {
  PreviewResetMode,
  PrismaMigrateDeployErrorCode,
  recoverMigrateDeployFailure,
} from "../scripts/migrate-deploy-recovery";
import type { MigrationPipelineDeps } from "../scripts/migration-pipeline";
import { runMigrationPipeline } from "../scripts/migration-pipeline";
import {
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "../scripts/vibe-environment";
import { makePipelineDeps } from "./support/migration-pipeline.test-fixtures";

const databaseUrl = "postgres://x";
const recoveryCodes = [
  PrismaMigrateDeployErrorCode.NonEmptySchema,
  PrismaMigrateDeployErrorCode.FailedMigration,
  PrismaMigrateDeployErrorCode.MigrationFailedToApply,
];
const seededReady = {
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Ready,
};

describe("ISS-12135: unattended migration recovery retains vibe rows", () => {
  it.each(["vibe/fresh", undefined])(
    "retains unmarked creation residue after cloning fails with branch=%s",
    async (branch) => {
      const deps = makePipelineDeps({ isNew: true, replayed: true });
      const error = new Error("clone failed");
      deps.cloneDataFromPublic.mockRejectedValue(error);
      const schema = normalizePreviewSchemaName("vibe/fresh");

      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, deps)
      ).rejects.toBe(error);

      expect(deps.cloneDataFromPublic).toHaveBeenCalledOnce();
      expect(deps.dropSchema).not.toHaveBeenCalled();
    }
  );

  it("retains unmarked creation residue after public-level replay fails", async () => {
    const deps = makePipelineDeps({ isNew: true, replayed: false });
    await expect(
      runMigrationPipeline(
        databaseUrl,
        normalizePreviewSchemaName("vibe/replay-failed"),
        "vibe/replay-failed",
        deps
      )
    ).rejects.toThrow("the replay of public's migrations did not complete");
    expect(deps.dropSchema).not.toHaveBeenCalled();
  });

  it.each(["feat/fresh", "andy/fresh", "vibe-lookalike"])(
    "ordinary failed-clone cleanup still drops %s",
    async (branch) => {
      const deps = makePipelineDeps({ isNew: true, replayed: true });
      const error = new Error("clone failed");
      deps.cloneDataFromPublic.mockRejectedValue(error);
      const schema = normalizePreviewSchemaName(branch);

      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, deps)
      ).rejects.toBe(error);

      expect(deps.dropSchema).toHaveBeenCalledExactlyOnceWith(
        databaseUrl,
        schema
      );
    }
  );

  it.each(recoveryCodes)(
    "maintenance surfaces %s without resetting a retained branch",
    async (code) => {
      const branch = "vibe/retained";
      const schema = normalizePreviewSchemaName(branch);
      const fixture = failureFixture(code);
      fixture.deps.readVibeEnvironmentMarker.mockResolvedValue(seededReady);

      await expect(
        defaultApplyToSchema(
          databaseUrl,
          schema,
          5000,
          async () => databaseUrl,
          branch,
          fixture.deps
        )
      ).rejects.toBe(fixture.error);

      expect(fixture.rows).toEqual(["saved row"]);
      expect(fixture.resetSchema).not.toHaveBeenCalled();
      expect(fixture.deps.runMigrate).toHaveBeenCalledWith(
        databaseUrl,
        schema,
        branch,
        expect.any(Object),
        undefined,
        PreviewResetMode.Never
      );
    }
  );

  it.each([true, false])(
    "protects missing branch provenance with marker present=%s",
    async (marked) => {
      const schema = normalizePreviewSchemaName("vibe/missing-registry");
      const fixture = failureFixture(
        PrismaMigrateDeployErrorCode.FailedMigration
      );
      if (marked) {
        fixture.deps.readVibeEnvironmentMarker.mockResolvedValue(seededReady);
      }

      await expect(
        defaultApplyToSchema(
          databaseUrl,
          schema,
          5000,
          async () => databaseUrl,
          undefined,
          fixture.deps
        )
      ).rejects.toBe(fixture.error);

      expect(fixture.rows).toEqual(["saved row"]);
      expect(fixture.resetSchema).not.toHaveBeenCalled();
    }
  );

  it.each(["feat/ordinary", "andy/retired", "vibe-lookalike"])(
    "keeps existing destructive recovery for the known ordinary branch %s",
    async (branch) => {
      const fixture = failureFixture(
        PrismaMigrateDeployErrorCode.FailedMigration
      );
      fixture.deps.replayPendingMigrationsViaSql.mockResolvedValue(true);
      await defaultApplyToSchema(
        databaseUrl,
        normalizePreviewSchemaName(branch),
        5000,
        async () => databaseUrl,
        branch,
        fixture.deps
      );

      expect(fixture.resetSchema).toHaveBeenCalledOnce();
      expect(fixture.rows).toEqual([]);
    }
  );

  it("a protected failure does not block recovery on a second ordinary schema", async () => {
    const protectedFixture = failureFixture(
      PrismaMigrateDeployErrorCode.FailedMigration
    );
    const ordinaryFixture = failureFixture(
      PrismaMigrateDeployErrorCode.FailedMigration
    );
    ordinaryFixture.deps.replayPendingMigrationsViaSql.mockResolvedValue(true);
    await expect(
      defaultApplyToSchema(
        databaseUrl,
        normalizePreviewSchemaName("vibe/one"),
        5000,
        async () => databaseUrl,
        "vibe/one",
        protectedFixture.deps
      )
    ).rejects.toBe(protectedFixture.error);
    await defaultApplyToSchema(
      databaseUrl,
      normalizePreviewSchemaName("feat/two"),
      5000,
      async () => databaseUrl,
      "feat/two",
      ordinaryFixture.deps
    );

    expect(protectedFixture.rows).toEqual(["saved row"]);
    expect(ordinaryFixture.rows).toEqual([]);
  });

  it("successful maintenance still applies pending migrations", async () => {
    const deps = makePipelineDeps({});
    deps.readVibeEnvironmentMarker.mockResolvedValue(seededReady);
    await defaultApplyToSchema(
      databaseUrl,
      normalizePreviewSchemaName("vibe/success"),
      5000,
      async () => databaseUrl,
      "vibe/success",
      deps
    );

    expect(deps.runMigrate).toHaveBeenCalledOnce();
    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledOnce();
  });

  it("an explicit initial build or reseed can recover its newly recreated empty schema", async () => {
    const fixture = failureFixture(
      PrismaMigrateDeployErrorCode.FailedMigration,
      true
    );
    fixture.deps.readVibeEnvironmentMarker.mockResolvedValue({
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    });
    fixture.deps.dropSchema.mockImplementation(() => {
      fixture.rows.splice(0);
      return Promise.resolve();
    });
    await runMigrationPipeline(
      databaseUrl,
      normalizePreviewSchemaName("vibe/reseed"),
      "vibe/reseed",
      fixture.deps,
      { vibeEnvironment: VibeEnvironmentMode.Seeded }
    );

    expect(fixture.deps.dropSchema).toHaveBeenCalledOnce();
    expect(fixture.resetSchema).toHaveBeenCalledOnce();
    expect(fixture.deps.writeVibeEnvironmentMarker).toHaveBeenCalledOnce();
  });

  it("a repeat mode request on a ready schema grants no destructive recovery", async () => {
    const fixture = failureFixture(
      PrismaMigrateDeployErrorCode.FailedMigration
    );
    fixture.deps.readVibeEnvironmentMarker.mockResolvedValue(seededReady);
    await expect(
      runMigrationPipeline(
        databaseUrl,
        normalizePreviewSchemaName("vibe/ready"),
        "vibe/ready",
        fixture.deps,
        { vibeEnvironment: VibeEnvironmentMode.Seeded }
      )
    ).rejects.toBe(fixture.error);

    expect(fixture.rows).toEqual(["saved row"]);
    expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
    expect(fixture.resetSchema).not.toHaveBeenCalled();
  });
});

describe("ISS-12214: unattended migration recovery retains prototype rows", () => {
  it.each([
    ["functional-prototype/kept", "functional-prototype/kept"],
    ["prototype/kept", "prototype/kept"],
    ["functional-prototype/missing-registry", undefined],
  ])(
    "a failed redeploy of %s (branch=%s) surfaces without a reset",
    async (name, branch) => {
      const schema = normalizePreviewSchemaName(name);
      const fixture = failureFixture(
        PrismaMigrateDeployErrorCode.FailedMigration
      );

      await expect(
        runMigrationPipeline(databaseUrl, schema, branch, fixture.deps)
      ).rejects.toBe(fixture.error);

      expect(fixture.rows).toEqual(["saved row"]);
      expect(fixture.resetSchema).not.toHaveBeenCalled();
      expect(fixture.deps.dropSchema).not.toHaveBeenCalled();
    }
  );
});

/** Drive the real recovery classifier; the reset spy models its row-erasing effect. */
function failureFixture(code: PrismaMigrateDeployErrorCode, isNew = false) {
  const deps = makePipelineDeps({ isNew });
  const rows = ["saved row"];
  const error = Object.assign(new Error("migrate deploy failed"), {
    stderr: `Error: ${code}`,
  });
  const resetSchema = vi.fn(() => {
    rows.splice(0);
    return Promise.resolve();
  });
  let migrationFailed = false;
  deps.runMigrate.mockImplementation((...args) => {
    if (migrationFailed) {
      return Promise.resolve(false);
    }
    migrationFailed = true;
    const [url, schema, branch, hooks, , previewReset] = args;
    return recoverMigrateDeployFailure(
      { databaseUrl: url, schema, branch, error },
      {
        resetSchema,
        runMigrateDeploy: vi.fn(() => Promise.resolve()),
        resolveFailedMigration: vi.fn(() => Promise.resolve()),
        upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
        onResetKind: hooks?.onResetKind,
        previewReset,
      }
    );
  });
  return {
    deps: deps satisfies MigrationPipelineDeps,
    rows,
    error,
    resetSchema,
  };
}
