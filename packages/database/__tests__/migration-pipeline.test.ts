import { describe, expect, it, vi } from "vitest";
import { recoverMigrateDeployFailure } from "../scripts/migrate-deploy-recovery";
import type { MigrationPipelineDeps } from "../scripts/migration-pipeline";
import {
  applyMigrationsToSchema,
  runMigrateWithRetry,
  runMigrationPipeline,
} from "../scripts/migration-pipeline";
import { prestampSkippableMigrationsViaSql } from "../scripts/preview-prestamp";
import { upsertSchemaRegistry } from "../scripts/preview-schema";

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
vi.mock("../scripts/migrate-deploy-recovery", () => ({
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

/**
 * Full mock dependency set for runMigrationPipeline. The serialize gate mock
 * actually invokes its callback so prestamp + migrate run inside it (as they do
 * in production), and withRetry runs its callback once. All collaborators are
 * injected so no real DB/prisma/fs is touched.
 */
function makeDeps(opts: {
  isNew?: boolean;
  atHead?: boolean;
  reset?: boolean;
  cloneOk?: boolean;
}) {
  return {
    ensureSchemaExists: vi.fn(() => Promise.resolve(opts.isNew ?? false)),
    upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
    probePreviewSchemaAtHead: vi.fn(() =>
      Promise.resolve(opts.atHead ?? false)
    ),
    // Invokes its callback (prestamp + migrate run inside) as production does.
    withMigrationSerializeLock: vi.fn(
      (
        _opts: {
          databaseUrl: string;
          onContended?: "run" | "skip";
          budgetMs?: number;
        },
        fn: () => Promise<boolean>
      ) => fn()
    ),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runMigrate: vi.fn(() => Promise.resolve(opts.reset ?? false)),
    cloneDataFromPublic: vi.fn(() => Promise.resolve(opts.cloneOk ?? true)),
    runPreviewSeed: vi.fn(),
    withRetry: vi.fn((fn: () => Promise<void>) => fn()),
    assertMigrateRoleOwnsSchema: vi.fn(() => Promise.resolve()),
  } satisfies MigrationPipelineDeps;
}

async function run(
  schema: string | null,
  deps: ReturnType<typeof makeDeps>
): Promise<void> {
  await runMigrationPipeline("postgres://x", schema, "some-branch", deps);
}

describe("runMigrationPipeline at-head branch (FEA-3071)", () => {
  it("skips the gate, prestamp, migrate, and clone when the preview is at head", async () => {
    const deps = makeDeps({ isNew: false, atHead: true });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.probePreviewSchemaAtHead).toHaveBeenCalledTimes(1);
    // The whole lock-taking path is skipped: 0 advisory-lock acquisitions.
    expect(deps.withMigrationSerializeLock).not.toHaveBeenCalled();
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

    expect(deps.withMigrationSerializeLock).toHaveBeenCalledTimes(1);
    expect(deps.prestampSkippableMigrationsViaSql).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    // Not new and no reset → no clone.
    expect(deps.cloneDataFromPublic).not.toHaveBeenCalled();
    expect(deps.runPreviewSeed).toHaveBeenCalledTimes(1);
  });

  it("clones after a reset (didReset) on the gated path", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: true });
    await run(PREVIEW_SCHEMA, deps);

    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("plain-builds preview indexes AFTER migrate and AFTER the clone (ISS-4437)", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: true });
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
    const first = makeDeps({ isNew: true, atHead: true });
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
    await run(PREVIEW_SCHEMA, deps);

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
    const deps = makeDeps({ isNew: true, atHead: false, reset: false });
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
      cloneFailed: false,
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
      cloneFailed: false,
      invalidIndexes: [],
    });
    expect(deps.withMigrationSerializeLock).toHaveBeenCalledTimes(1);
    expect(deps.runMigrate).toHaveBeenCalledTimes(1);
  });

  it("reset → clones and returns didReset:true", async () => {
    const deps = makeDeps({ isNew: false, atHead: false, reset: true });
    const result = await applyMigrationsToSchema(
      "postgres://x",
      PREVIEW_SCHEMA,
      "branch",
      { isNew: false },
      deps
    );
    expect(result).toEqual({
      didReset: true,
      cloneFailed: false,
      invalidIndexes: [],
    });
    expect(deps.cloneDataFromPublic).toHaveBeenCalledTimes(1);
  });

  it("reports cloneFailed when a post-reset clone fails", async () => {
    const deps = makeDeps({
      isNew: false,
      atHead: false,
      reset: true,
      cloneOk: false,
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
      cloneFailed: true,
      invalidIndexes: [],
    });
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
      PREVIEW_SCHEMA,
      "branch",
      { isNew: true },
      deps
    );
    expect(deps.probePreviewSchemaAtHead).not.toHaveBeenCalled();
    expect(result).toEqual({
      didReset: false,
      cloneFailed: false,
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
      cloneFailed: false,
      invalidIndexes: [],
    });
  });

  it("skips the post-reset clone on a gh-readonly-queue ref without reporting cloneFailed", async () => {
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
      cloneFailed: false,
      invalidIndexes: [],
    });
  });

  it("still clones a new schema on a non-queue ref", async () => {
    const deps = makeDeps({ isNew: true });
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
      cloneFailed: false,
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
    // reset — this is what keeps the 7-day TTL reaper working (review: wongk).
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
