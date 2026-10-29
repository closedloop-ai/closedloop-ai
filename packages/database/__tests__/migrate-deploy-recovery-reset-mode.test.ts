import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreviewResetMode,
  PrismaMigrateDeployErrorCode,
  recoverMigrateDeployFailure,
} from "../scripts/migrate-deploy-recovery";
import { makeDeployError } from "./test-helpers/deploy-error";

/*
 * ISS-11785: what the preview-reset decision does under each `PreviewResetMode`.
 * Split from migrate-deploy-recovery.test.ts, which sits at the file-size ceiling.
 * A reset that re-migrates the empty schema is how a migration that failed on
 * real rows came back green on the next deploy.
 */

const DATABASE_URL = "postgresql://app:password@localhost:5432/db";
const PREVIEW_SCHEMA = "preview_iss_11785";
const P3018_OUTPUT = `Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
Migration name: 20260930150000_iss11212_comment_contract_core
Database error code: 23502`;
const P3009_OUTPUT = `Error: ${PrismaMigrateDeployErrorCode.FailedMigration}
Migration name: 20261021150300_prd725_link_order_metadata_backfill`;

function createDeps(previewReset?: PreviewResetMode) {
  const steps: string[] = [];
  const step = (name: string) =>
    vi.fn(() => {
      steps.push(name);
      return Promise.resolve();
    });
  return {
    steps,
    deps: {
      prestampSkippableMigrations: step("prestamp"),
      resetSchema: step("reset"),
      resolveFailedMigration: step("resolve"),
      runMigrateDeploy: step("migrate"),
      upsertSchemaRegistry: step("upsert"),
      ...(previewReset === undefined ? {} : { previewReset }),
    },
  };
}

function recover(deps: ReturnType<typeof createDeps>["deps"], error: Error) {
  return recoverMigrateDeployFailure(
    {
      branch: "feat/iss-11785",
      databaseUrl: DATABASE_URL,
      error,
      schema: PREVIEW_SCHEMA,
    },
    deps
  );
}

describe("preview reset mode (ISS-11785)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-migrates the reset schema when no mode is given", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps, steps } = createDeps();

    await expect(
      recover(deps, makeDeployError({ stderr: P3018_OUTPUT }))
    ).resolves.toBe(true);
    expect(steps).toEqual(["reset", "prestamp", "migrate", "upsert"]);
  });

  it("ResetOnly empties the schema and leaves the migrate to the caller", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps, steps } = createDeps(PreviewResetMode.ResetOnly);

    await expect(
      recover(deps, makeDeployError({ stderr: P3018_OUTPUT }))
    ).resolves.toBe(true);
    expect(steps).toEqual(["reset", "upsert"]);
  });

  it("Never rethrows the migrate's own failure and touches nothing", async () => {
    const { deps, steps } = createDeps(PreviewResetMode.Never);
    const error = makeDeployError({ stderr: P3018_OUTPUT });

    await expect(recover(deps, error)).rejects.toBe(error);
    expect(steps).toEqual([]);
  });

  it("Never preserves retained rows while resolving and retrying P3009", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps, steps } = createDeps(PreviewResetMode.Never);

    await expect(
      recover(deps, makeDeployError({ stderr: P3009_OUTPUT }))
    ).resolves.toBe(false);
    expect(steps).toEqual(["resolve", "migrate"]);
  });
});
