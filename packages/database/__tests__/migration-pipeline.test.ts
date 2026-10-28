import { describe, expect, it, vi } from "vitest";
import { normalizePreviewSchemaName } from "../schema-utils";
import { defaultApplyToSchema } from "../scripts/migrate-all-previews";
import {
  PreviewResetMode,
  recoverMigrateDeployFailure,
} from "../scripts/migrate-deploy-recovery";
import { MigrateGateOutcome } from "../scripts/migrate-telemetry";
import {
  applyMigrationsToSchema,
  runMigrateWithRetry,
  runMigrationPipeline,
} from "../scripts/migration-pipeline";
import { prestampSkippableMigrationsViaSql } from "../scripts/preview-prestamp";
import { upsertSchemaRegistry } from "../scripts/preview-schema";
import { makePipelineDeps as makeDeps } from "./support/migration-pipeline.test-fixtures";

// `runMigrateWithRetry` shells `prisma migrate deploy` and, on failure, calls the
// recovery. Both are stubbed so the failure→recovery forwarding path is unit-
// testable without a prisma subprocess or a database. Other tests in this file
// inject `runMigrate`, so they never reach these stubs.
//
// ISS-6403 Finding 4: `spawn`, not `spawnSync` — the pipeline no longer blocks
// the event loop on the CLI. The fake exits 1 with no output, as before, but
// has to do it as a child process would: streams end, then `close`.
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout: InstanceType<typeof PassThrough>;
        stderr: InstanceType<typeof PassThrough>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let drained = 0;
      const settle = () => {
        drained += 1;
        if (drained === 2) {
          child.emit("close", 1);
        }
      };
      child.stdout.on("end", settle);
      child.stderr.on("end", settle);
      setImmediate(() => {
        child.stdout.end("");
        child.stderr.end("");
      });
      return child;
    }),
  };
});
vi.mock("../scripts/migrate-deploy-recovery", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/migrate-deploy-recovery")
  >()),
  recoverMigrateDeployFailure: vi.fn(() => Promise.resolve(false)),
}));
// ISS-6814: the REAL pre-stamp, wrapped so the closure the pipeline binds for
// recovery can be driven and its arguments observed. Behavior is unchanged.
vi.mock("../scripts/preview-prestamp", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scripts/preview-prestamp")>();
  return {
    ...actual,
    prestampSkippableMigrationsViaSql: vi.fn(
      actual.prestampSkippableMigrationsViaSql
    ),
  };
});

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";
const TRANSIENT_BUILD_RE = /transient build failure/;
const OWNERSHIP_DRIFT_RE = /schema_ownership_drift/;
const MERGE_QUEUE_REF = "gh-readonly-queue/main/pr-4444-abc1234";
const CLONE_FAILED_RE = /The data clone from public into .* failed/;
/**
 * An explicitly named, non-preview schema (`PGSCHEMA`): a new one still takes the
 * gated migrate below. A new branch preview is built around a clone instead
 * (ISS-11785, `preview-clone-first.test.ts`).
 */
const EXPLICIT_SCHEMA = "explicit_schema";

async function run(
  schema: string | null,
  deps: ReturnType<typeof makeDeps>
): Promise<void> {
  await runMigrationPipeline("postgres://x", schema, "some-branch", deps);
}

/** The serialize gate's calls, without a branch preview's build lock (ISS-11785). */
function serializeGateCalls(deps: ReturnType<typeof makeDeps>) {
  return deps.withMigrationSerializeLock.mock.calls.filter(
    ([gate]) => gate.lockKey === undefined
  );
}

describe("runMigrationPipeline at-head branch (FEA-3071)", () => {
  it("skips the gate, prestamp, migrate, and clone when the preview is at head", async () => {
    const deps = makeDeps({ isNew: false, atHead: true });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.probePreviewSchemaAtHead).toHaveBeenCalledTimes(1);
    // The whole gated path is skipped: no serialize-gate acquisition. The
    // preview's build lock (ISS-11785) is per schema, not the shared gate.
    expect(serializeGateCalls(deps)).toEqual([]);
    expect(deps.prestampSkippableMigrationsViaSql).not.toHaveBeenCalled();
    expect(deps.runMigrate).not.toHaveBeenCalled();
    // No reset happened, so the existing preview keeps its data — no clone.
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    // ISS-4437: the plain-index ensure runs even on at-head (unconditional) so a
    // schema whose earlier build failed self-heals — the at-head probe cannot see
    // a missing index.
    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledTimes(1);
    // Seed still runs (idempotent, outside the gate).
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });

  it("takes the normal gated path (prestamp + migrate) when the preview is behind", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: false });
    await run(PREVIEW_SCHEMA, deps);

    expect(serializeGateCalls(deps)).toHaveLength(1);
    expect(deps.prestampSkippableMigrationsViaSql).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    // Not new and no reset → no clone.
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });

  it("clones after a reset (didReset) on the gated path", async () => {
    const deps = makeDeps({
      isNew: false,
      atHead: false,
      reset: true,
      replayed: true,
    });
    await run(PREVIEW_SCHEMA, deps);

    // ISS-11785: the reset only empties the schema; the migrate of what public
    // has not applied, over the clone, is the second.
    expect(deps.runMigrate).toHaveBeenCalledTimes(2);
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("plain-builds preview indexes AFTER migrate and AFTER the clone (ISS-4437)", async () => {
    const deps = makeDeps({
      isNew: false,
      atHead: false,
      reset: true,
      replayed: true,
    });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledTimes(1);
    // Ordering: migrate (creates tables) → clone (persists data) → plain-build
    // (indexes the already-cloned, unique-by-public data). Clone before build so a
    // fail-then-retry keeps its data (see the regression below).
    const migrateOrder = deps.runMigrate.mock.invocationCallOrder[0];
    const cloneOrder = deps.cloneDataFromPublic.mock.invocationCallOrder[0];
    const plainBuildOrder =
      deps.plainBuildPreviewConcurrentIndexes.mock.invocationCallOrder[0];
    expect(migrateOrder).toBeLessThan(cloneOrder);
    expect(cloneOrder).toBeLessThan(plainBuildOrder);
  });

  it("persists the clone BEFORE the plain-build so a fail-then-retry keeps data (ISS-4437)", async () => {
    // Run 1: fresh schema; migrate + clone run, then the plain-build throws.
    const first = makeDeps({ isNew: true, atHead: true, replayed: true });
    first.plainBuildPreviewConcurrentIndexes.mockRejectedValueOnce(
      new Error("transient build failure")
    );
    await expect(run(PREVIEW_SCHEMA, first)).rejects.toThrow(
      TRANSIENT_BUILD_RE
    );
    // The clone already ran (data persisted) even though the build then threw.
    expect(first.cloneDataFromPublic).toHaveBeenCalledTimes(1);
    expect(first.cloneDataFromPublic.mock.invocationCallOrder[0]).toBeLessThan(
      first.plainBuildPreviewConcurrentIndexes.mock.invocationCallOrder[0]
    );

    // Run 2 (retry): schema now at head → migrate + clone are skipped, but the
    // plain-build recovers over the still-present cloned data.
    const retry = makeDeps({ isNew: false, atHead: true });
    await run(PREVIEW_SCHEMA, retry);
    expect(retry.runMigrate).not.toHaveBeenCalled();
    expect(retry.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(retry.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledTimes(1);
  });

  it("never probes a brand-new schema; migrates and clones it", async () => {
    const deps = makeDeps({ isNew: true, atHead: true });
    await run(EXPLICIT_SCHEMA, deps);

    // `!isNew` short-circuits the probe for a fresh schema.
    expect(deps.probePreviewSchemaAtHead).not.toHaveBeenCalled();
    expect(deps.withMigrationSerializeLock).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    // isNew → clone.
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("takes the normal gated path for the public schema (probe returns false)", async () => {
    const deps = makeDeps({ isNew: false, atHead: false });
    await run("public", deps);

    expect(deps.withMigrationSerializeLock).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
  });

  it("always ensures the schema, upserts the registry, and seeds (parity guard)", async () => {
    const deps = makeDeps({ isNew: false, atHead: false });
    await run(PREVIEW_SCHEMA, deps);

    // The pipeline owns ensure/upsert/seed; the extracted core does not.
    expect(deps.ensureSchemaExists).toHaveBeenCalledTimes(1);
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledTimes(1);
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });
});

/*
 * ISS-6810. Four steps of a run open migration files themselves — the at-head
 * probe, the pre-stamp, the plain-index build and the ownership preflight — off
 * `process.cwd()` by default. The ensure route's function runs from `apps/api`
 * while the traced migrations sit under `packages/database`, so the first real
 * preview ensure died in the pre-stamp with ENOENT. `prismaCli.migrationsDir` is
 * the per-run answer, and every one of the four must receive readers bound to
 * it: a reader that reaches only some of them leaves the others failing on cwd.
 * Asserted by READING through the readers the pipeline handed over, against a
 * temp directory that is not cwd — not by matching an argument shape.
 */
describe("runMigrationPipeline threads prismaCli.migrationsDir into every migration-file reader (ISS-6810)", () => {
  it("hands every reader-consuming step readers bound to the run's directory", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const migrationsDir = mkdtempSync(
      path.join(tmpdir(), "iss6810-migrations-")
    );
    const migration = "20990101000000_iss6810_probe";
    mkdirSync(path.join(migrationsDir, migration));
    writeFileSync(
      path.join(migrationsDir, migration, "migration.sql"),
      "SELECT 1;"
    );

    try {
      const deps = makeDeps({ isNew: false, atHead: false, reset: false });
      await runMigrationPipeline("postgres://x", PREVIEW_SCHEMA, "b", {
        ...deps,
        prismaCli: { migrationsDir },
      });

      const readersHandedTo = (mock: { mock: { calls: unknown[][] } }) =>
        mock.mock.calls[0]?.at(-1) as
          | {
              readMigrationSql?: (name: string) => string;
              listMigrationDirs?: () => string[];
            }
          | undefined;
      const consumers = {
        probe: readersHandedTo(deps.probePreviewSchemaAtHead),
        preflight: readersHandedTo(deps.assertMigrateRoleOwnsSchema),
        prestamp: readersHandedTo(deps.prestampSkippableMigrationsViaSql),
        plainIndex: readersHandedTo(deps.plainBuildPreviewConcurrentIndexes),
      };

      for (const [name, readers] of Object.entries(consumers)) {
        expect(readers?.readMigrationSql, name).toBeTypeOf("function");
        expect(readers?.listMigrationDirs, name).toBeTypeOf("function");
        expect(readers?.readMigrationSql?.(migration), name).toBe("SELECT 1;");
        expect(readers?.listMigrationDirs?.(), name).toEqual([migration]);
      }
    } finally {
      rmSync(migrationsDir, { force: true, recursive: true });
    }
  });

  it("hands them nothing when no directory is named, so each keeps its cwd default", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: false });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.probePreviewSchemaAtHead.mock.calls[0]?.at(2)).toEqual({});
    expect(deps.assertMigrateRoleOwnsSchema.mock.calls[0]?.at(2)).toEqual({});
    expect(deps.prestampSkippableMigrationsViaSql.mock.calls[0]?.at(2)).toEqual(
      { freshSchema: false }
    );
    expect(
      deps.plainBuildPreviewConcurrentIndexes.mock.calls[0]?.at(2)
    ).toEqual({
      budgetMs: undefined,
    });
  });
});

/*
 * ISS-6814. The pre-stamp must know whether the schema it stamps is FRESH: on
 * a schema created in this run every table is empty during migrate, and the
 * plain-build (unique, FK-referenced) entries have to run natively there or a
 * later migration's foreign key fails at 42830. `isNew` is that fact; it has to
 * reach the pre-stamp as `freshSchema`, and a reset in recovery — a fresh schema
 * by construction — has to say so too.
 */
describe("runMigrationPipeline tells the pre-stamp whether the schema is fresh (ISS-6814)", () => {
  it("a brand-new schema pre-stamps as fresh", async () => {
    // ISS-11785: `atHead` is the post-clone probe; nothing above public's level
    // remains, so the replay's pre-stamp is the run's only one.
    const deps = makeDeps({
      isNew: true,
      atHead: true,
      reset: false,
      replayed: true,
    });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.prestampSkippableMigrationsViaSql).toHaveBeenCalledTimes(1);
    expect(
      deps.prestampSkippableMigrationsViaSql.mock.calls[0]?.at(2)
    ).toMatchObject({ freshSchema: true });
  });

  it("an existing schema pre-stamps as not fresh", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: false });
    await run(PREVIEW_SCHEMA, deps);

    expect(
      deps.prestampSkippableMigrationsViaSql.mock.calls[0]?.at(2)
    ).toMatchObject({ freshSchema: false });
  });

  it("recovery's re-stamp (after a reset) is fresh by construction, over the run's readers", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    vi.mocked(prestampSkippableMigrationsViaSql).mockClear();
    const migrationsDir = "/tmp/iss6814-not-cwd/migrations";

    await runMigrateWithRetry(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      undefined,
      {},
      { migrationsDir }
    );
    const recoveryDeps = vi.mocked(recoverMigrateDeployFailure).mock
      .calls[0][1];
    expect(recoveryDeps.prestampSkippableMigrations).toBeTypeOf("function");

    // Drive the REAL closure the pipeline bound for recovery. Its `postgres://x`
    // connect fails, and with no plain-build entry in scope that is fail-OPEN —
    // which is itself the fresh contract — so it resolves rather than throws.
    await expect(
      recoveryDeps.prestampSkippableMigrations?.("postgres://x", PREVIEW_SCHEMA)
    ).resolves.toBeUndefined();

    const passed = vi
      .mocked(prestampSkippableMigrationsViaSql)
      .mock.calls.at(-1)?.[2];
    expect(passed).toMatchObject({ freshSchema: true });
    expect(passed?.readMigrationSql).toBeTypeOf("function");
  });
});

describe("applyMigrationsToSchema (FEA-3071 Slice 2 shared core)", () => {
  it("at head → 0 gate, 0 clone, didReset:false, and NEVER ensures/upserts/seeds", async () => {
    const deps = makeDeps({ isNew: false, atHead: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      { isNew: false },
      deps
    );

    expect(result).toEqual({
      didReset: false,
      invalidIndexes: [],
    });
    expect(deps.probePreviewSchemaAtHead).toHaveBeenCalledTimes(1);
    expect(deps.withMigrationSerializeLock).not.toHaveBeenCalled();
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    // The core is registry-neutral — the migrator walk relies on this so a walk
    // never refreshes last_seen_at and defeats the TTL reaper.
    expect(deps.ensureSchemaExists).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).not.toHaveBeenCalled();
  });

  it("behind → gate + migrate, returns didReset from runMigrate", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: false });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      { isNew: false },
      deps
    );
    expect(result).toEqual({
      didReset: false,
      invalidIndexes: [],
    });
    expect(deps.withMigrationSerializeLock).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
  });

  it("reset → clones and returns didReset:true", async () => {
    const deps = makeDeps({
      isNew: false,
      atHead: false,
      reset: true,
      replayed: true,
    });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      { isNew: false },
      deps
    );
    expect(result).toEqual({
      didReset: true,
      invalidIndexes: [],
    });
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("fails the run when a post-reset clone fails (ISS-11785)", async () => {
    const deps = makeDeps({
      isNew: false,
      atHead: false,
      reset: true,
      cloneOk: false,
      replayed: true,
    });
    await expect(
      applyMigrationsToSchema(
        "postgres://x",
        PREVIEW_SCHEMA,
        "branch",
        { isNew: false },
        deps
      )
    ).rejects.toThrow(CLONE_FAILED_RE);
    expect(deps.dropSchema).toHaveBeenCalledWith(
      "postgres://x",
      PREVIEW_SCHEMA
    );
  });

  it("threads serializeMode and serializeBudgetMs into the gate opts", async () => {
    const deps = makeDeps({ isNew: false, atHead: false });
    await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      { isNew: false, serializeMode: "skip", serializeBudgetMs: 4242 },
      deps
    );
    expect(deps.withMigrationSerializeLock).toHaveBeenCalledWith(
      expect.objectContaining({ onContended: "skip", budgetMs: 4242 }),
      expect.any(Function)
    );
  });

  it("isNew skips the probe and clones", async () => {
    const deps = makeDeps({ isNew: true, atHead: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      EXPLICIT_SCHEMA,
      "branch",
      { isNew: true },
      deps
    );
    expect(deps.probePreviewSchemaAtHead).not.toHaveBeenCalled();
    expect(result).toEqual({
      didReset: false,
      invalidIndexes: [],
    });
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });
});

describe("merge-queue ref clone skip (ISS-5285)", () => {
  it("skips the data clone for a new schema on a gh-readonly-queue ref, still migrating; skipped ≠ failed", async () => {
    const deps = makeDeps({ isNew: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      MERGE_QUEUE_REF,
      { isNew: true },
      deps
    );

    // The migrate itself still runs — only the data clone is skipped.
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    // Skipped is not a failed clone: the schema is intentionally empty.
    expect(result).toEqual({
      didReset: false,
      invalidIndexes: [],
    });
  });

  it("skips the post-reset clone on a gh-readonly-queue ref", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      MERGE_QUEUE_REF,
      { isNew: false },
      deps
    );

    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(result).toEqual({
      didReset: true,
      invalidIndexes: [],
    });
  });

  it("still clones a new schema on a non-queue ref", async () => {
    const deps = makeDeps({ isNew: true, replayed: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "feat/my-branch",
      { isNew: true },
      deps
    );

    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      didReset: false,
      invalidIndexes: [],
    });
  });

  it("threads the queue ref through runMigrationPipeline: migrate + seed run, clone does not", async () => {
    const deps = makeDeps({ isNew: true });
    await runMigrationPipeline(
      "postgres://x",
      PREVIEW_SCHEMA,
      MERGE_QUEUE_REF,
      deps
    );

    expect(deps.ensureSchemaExists).toHaveBeenCalledTimes(1);
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    // ISS-4437: the fail-closed correctness-index build is NOT part of the
    // queue-ref skip — only the data clone is.
    expect(deps.plainBuildPreviewConcurrentIndexes).toHaveBeenCalledTimes(1);
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });
});

describe("runMigrateWithRetry recovery-upsert injection (FEA-3071 Slice 2)", () => {
  it("forwards the injected recovery upsert to recovery — the walk's TTL-safe no-op path", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    const injectedUpsert = vi.fn(() => Promise.resolve());

    await runMigrateWithRetry(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      injectedUpsert
    );

    expect(recoverMigrateDeployFailure).toHaveBeenCalledTimes(1);
    const recoveryDeps = vi.mocked(recoverMigrateDeployFailure).mock
      .calls[0][1];
    // The walk passes a no-op here, so the REAL registry upsert never runs on a
    // reset — this is what keeps the 7-day TTL reaper working (review: whitlockk).
    expect(recoveryDeps.upsertSchemaRegistry).toBe(injectedUpsert);
    expect(recoveryDeps.upsertSchemaRegistry).not.toBe(upsertSchemaRegistry);
  });

  it("defaults to the real registry upsert when none is injected (pipeline path)", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();

    await runMigrateWithRetry("postgres://x", PREVIEW_SCHEMA, "branch");

    const recoveryDeps = vi.mocked(recoverMigrateDeployFailure).mock
      .calls[0][1];
    expect(recoveryDeps.upsertSchemaRegistry).toBe(upsertSchemaRegistry);
  });
});

describe("ownership preflight wiring (ISS-5952)", () => {
  it("runs the preflight BEFORE the gate and migrate on the public-schema path", async () => {
    const deps = makeDeps({ isNew: false, atHead: false });
    await run("public", deps);

    expect(deps.assertMigrateRoleOwnsSchema).toHaveBeenCalledTimes(1);
    // ISS-6810: the third argument is the run's migration-file readers — empty
    // here, since no `prismaCli.migrationsDir` was named.
    expect(deps.assertMigrateRoleOwnsSchema).toHaveBeenCalledWith(
      "postgres://x",
      "public",
      {}
    );
    const preflightOrder =
      deps.assertMigrateRoleOwnsSchema.mock.invocationCallOrder[0];
    const gateOrder =
      deps.withMigrationSerializeLock.mock.invocationCallOrder[0];
    const migrateOrder = deps.runMigrate.mock.invocationCallOrder[0];
    expect(preflightOrder).toBeLessThan(gateOrder);
    expect(preflightOrder).toBeLessThan(migrateOrder);
  });

  it("a preflight rejection fails the run before migrate deploy is ever invoked", async () => {
    const deps = makeDeps({ isNew: false, atHead: false });
    deps.assertMigrateRoleOwnsSchema.mockRejectedValueOnce(
      new Error("schema_ownership_drift")
    );

    await expect(run("public", deps)).rejects.toThrow(OWNERSHIP_DRIFT_RE);
    // The failure happened BEFORE any lock, prestamp, or DDL-running step.
    expect(deps.withMigrationSerializeLock).not.toHaveBeenCalled();
    expect(deps.prestampSkippableMigrationsViaSql).not.toHaveBeenCalled();
    expect(deps.runMigrate).not.toHaveBeenCalled();
  });

  it("does not run when the preview at-head probe already skipped migrate", async () => {
    const deps = makeDeps({ isNew: false, atHead: true });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.assertMigrateRoleOwnsSchema).not.toHaveBeenCalled();
  });
});

describe("direct SQL replay on a fresh preview schema (ISS-8039)", () => {
  it("replaces the migrate-deploy spawn when the replay claims a new schema", async () => {
    // ISS-11785: `atHead` is the post-clone probe here: nothing above public's
    // level remains, so no CLI runs for the rest either.
    const deps = makeDeps({ isNew: true, replayed: true, atHead: true });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledTimes(1);
    // The whole point: no `prisma migrate deploy` child for the 344-migration
    // history that had grown migrate_ms to 258s of a 290s route budget.
    expect(deps.runMigrate).not.toHaveBeenCalled();
    // It runs INSIDE the serialize gate it replaces, so the DDL stays
    // serialized against concurrent deploys exactly as the migrate was.
    expect(serializeGateCalls(deps)).toHaveLength(1);
    // A created schema is empty, so the clone still runs — off `isNew`, not off
    // the replay's return, which reports "nothing was reset".
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("falls back to migrate deploy when the replay declines", async () => {
    const deps = makeDeps({ isNew: true, replayed: false });
    await run(EXPLICIT_SCHEMA, deps);

    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledTimes(1);
    // Fail-open: declining can only cost the old path, never skip the migrate.
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("never offers an EXISTING schema to the replay", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, replayed: true });
    await run(PREVIEW_SCHEMA, deps);

    // An existing preview holds data and a real history. Even with the replay
    // reporting success it must not be consulted, or `migrate deploy` would be
    // skipped for a schema whose pending set the replay never computed.
    expect(deps.replayPendingMigrationsViaSql).not.toHaveBeenCalled();
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
  });

  it("runs AFTER the pre-stamp, whose rows it treats as already applied", async () => {
    const deps = makeDeps({ isNew: true, replayed: true });
    await run(PREVIEW_SCHEMA, deps);

    const prestampOrder =
      deps.prestampSkippableMigrationsViaSql.mock.invocationCallOrder[0];
    const replayOrder =
      deps.replayPendingMigrationsViaSql.mock.invocationCallOrder[0];
    expect(prestampOrder).toBeDefined();
    expect(replayOrder).toBeGreaterThan(prestampOrder as number);
  });
});

describe("ISS-8039 replay: the serialize gate is a precondition, not decoration", () => {
  it("declines the replay when the gate FAILED OPEN, leaving the CLI to run", async () => {
    const deps = makeDeps({
      isNew: true,
      replayed: true,
      gateOutcome: MigrateGateOutcome.FailOpen,
    });
    await run(EXPLICIT_SCHEMA, deps);

    // The gate fails open by default, so the callback runs UNGUARDED. `migrate
    // deploy` survives that because Prisma takes its own per-database migration
    // lock underneath; the raw-SQL replay holds no lock at all, so two first
    // deployments of one preview would otherwise replay the same DDL and history
    // rows into the same schema concurrently.
    expect(deps.replayPendingMigrationsViaSql).not.toHaveBeenCalled();
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
  });

  it("takes the replay when the gate was ACQUIRED", async () => {
    const deps = makeDeps({
      isNew: true,
      replayed: true,
      atHead: true,
      gateOutcome: MigrateGateOutcome.Acquired,
    });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.replayPendingMigrationsViaSql).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).not.toHaveBeenCalled();
  });

  it("hands the replay the run's migration-file readers (ISS-6810)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const migrationsDir = mkdtempSync(
      path.join(tmpdir(), "iss8039-migrations-")
    );
    const migration = "20990101000000_iss8039_probe";
    mkdirSync(path.join(migrationsDir, migration));
    writeFileSync(
      path.join(migrationsDir, migration, "migration.sql"),
      "SELECT 1;"
    );

    try {
      const deps = makeDeps({ isNew: true, replayed: true });
      await runMigrationPipeline("postgres://x", PREVIEW_SCHEMA, "b", {
        ...deps,
        prismaCli: { migrationsDir },
      });

      // `/preview-schemas/ensure` runs from `apps/api`, so the replay MUST take
      // the run's readers rather than a cwd default — otherwise it lists no
      // migrations there and silently declines on staging only.
      const readers = deps.replayPendingMigrationsViaSql.mock.calls[0]?.at(
        -1
      ) as
        | {
            readMigrationSql?: (name: string) => string;
            listMigrationDirs?: () => string[];
          }
        | undefined;
      expect(readers?.readMigrationSql?.(migration)).toBe("SELECT 1;");
      expect(readers?.listMigrationDirs?.()).toEqual([migration]);
    } finally {
      rmSync(migrationsDir, { force: true, recursive: true });
    }
  });
});

describe("ISS-8039 telemetry: migrate_ms stays interpretable", () => {
  async function emittedExecutor(opts: {
    isNew: boolean;
    replayed: boolean;
    schema?: string;
  }): Promise<string | null | undefined> {
    const events: { migrate_executor?: string | null }[] = [];
    await applyMigrationsToSchema(
      "postgres://x",
      opts.schema ?? PREVIEW_SCHEMA,
      "b",
      {
        isNew: opts.isNew,
        telemetry: {
          emit: (event: { migrate_executor?: string | null }) => {
            events.push(event);
          },
        },
      },
      // ISS-11785: for a new schema `atHead` is the post-clone probe; nothing
      // above public's level remains, so the replay is the run's only migrate.
      makeDeps({
        isNew: opts.isNew,
        replayed: opts.replayed,
        atHead: opts.isNew,
      })
    );
    return events[0]?.migrate_executor;
  }

  it("tells the SQL replay apart from a Prisma deploy", async () => {
    // The ticket's whole diagnosis was that `migrate_ms` measured Prisma CLI
    // time (258s of a 290s budget). After ISS-8039 a 1.5s replay and a 1.5s
    // `migrate deploy` are indistinguishable without this discriminator.
    expect(await emittedExecutor({ isNew: true, replayed: true })).toBe(
      "sql_replay"
    );
    expect(
      await emittedExecutor({
        isNew: true,
        replayed: false,
        schema: EXPLICIT_SCHEMA,
      })
    ).toBe("prisma_cli");
    expect(await emittedExecutor({ isNew: false, replayed: false })).toBe(
      "prisma_cli"
    );
  });
});

/*
 * ISS-11785: the reset mode is chosen in `applyMigrationsToSchema` but acted on in
 * recovery, two adapters away. Driven through the REAL adapters (the pipeline
 * default and the migrator walk's) with only the spawn and recovery stubbed, so
 * an adapter that drops the argument puts the old re-migrating reset back.
 */
describe("the preview reset mode reaches recovery through both adapters (ISS-11785)", () => {
  function depsWithoutRunMigrate() {
    const { runMigrate: _runMigrate, ...deps } = makeDeps({
      isNew: false,
      atHead: false,
    });
    return deps;
  }

  function recoveryResetMode(): PreviewResetMode | undefined {
    return vi.mocked(recoverMigrateDeployFailure).mock.calls[0]?.[1]
      .previewReset;
  }

  it("the pipeline's default adapter: ResetOnly for a branch preview", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "feat/my-branch",
      { isNew: false },
      depsWithoutRunMigrate()
    );
    expect(recoveryResetMode()).toBe(PreviewResetMode.ResetOnly);
  });

  it("the pipeline's default adapter: Remigrate for a merge-queue preview", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      MERGE_QUEUE_REF,
      { isNew: false },
      depsWithoutRunMigrate()
    );
    expect(recoveryResetMode()).toBe(PreviewResetMode.Remigrate);
  });

  it("the migrator walk's adapter: ResetOnly for a branch preview", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    await defaultApplyToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      60_000,
      () => Promise.resolve("postgres://x"),
      "feat/my-branch",
      depsWithoutRunMigrate()
    );
    expect(recoveryResetMode()).toBe(PreviewResetMode.ResetOnly);
  });

  it("the direct retry adapter defaults to Never for a retained branch", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    await runMigrateWithRetry(
      "postgres://x",
      normalizePreviewSchemaName("vibe/direct"),
      "vibe/direct"
    );
    expect(recoveryResetMode()).toBe(PreviewResetMode.Never);
  });

  it("the walk's real retry adapter preserves Never without branch provenance", async () => {
    vi.mocked(recoverMigrateDeployFailure).mockClear();
    await defaultApplyToSchema(
      "postgres://x",
      normalizePreviewSchemaName("vibe/missing"),
      60_000,
      () => Promise.resolve("postgres://x"),
      undefined,
      depsWithoutRunMigrate()
    );
    expect(recoveryResetMode()).toBe(PreviewResetMode.Never);
  });
});
