import { type Mocked, vi } from "vitest";
import { CloneFailedError } from "../../scripts/clone-schema";
import { MigrateGateOutcome } from "../../scripts/migrate-telemetry";
import type { SerializeLockContendedMode } from "../../scripts/migration-lock";
import type { MigrationPipelineDeps } from "../../scripts/migration-pipeline";

/**
 * Full mock dependency set for runMigrationPipeline. The serialize gate mock
 * actually invokes its callback so prestamp + migrate run inside it (as they do
 * in production), and withRetry runs its callback once. All collaborators are
 * injected so no real DB/prisma/fs is touched.
 */
export function makePipelineDeps(opts_: {
  isNew?: boolean;
  atHead?: boolean;
  reset?: boolean;
  cloneOk?: boolean;
  /** ISS-8039: whether the direct SQL replay claims the migrate. Default false
   *  keeps every pre-existing case on the `runMigrate` path it was written for. */
  replayed?: boolean;
  /** ISS-8039: the FEA-3065 gate's outcome; default `acquired`. */
  gateOutcome?: MigrateGateOutcome;
}): Mocked<MigrationPipelineDeps> {
  const opts = opts_;
  const gateOutcome = opts.gateOutcome ?? MigrateGateOutcome.Acquired;
  return {
    ensureSchemaExists: vi.fn<MigrationPipelineDeps["ensureSchemaExists"]>(() =>
      Promise.resolve(opts.isNew ?? false)
    ),
    upsertSchemaRegistry: vi.fn<MigrationPipelineDeps["upsertSchemaRegistry"]>(
      () => Promise.resolve()
    ),
    probePreviewSchemaAtHead: vi.fn<
      MigrationPipelineDeps["probePreviewSchemaAtHead"]
    >(() => Promise.resolve(opts.atHead ?? false)),
    // Invokes its callback (prestamp + migrate run inside) as production does,
    // and REPORTS ITS OUTCOME first — the real gate always does, and ISS-8039's
    // replay reads it, so a mock that stays silent would model a permanently
    // fail-open gate and quietly disable the path under test.
    withMigrationSerializeLock: vi.fn<
      MigrationPipelineDeps["withMigrationSerializeLock"]
    >(
      (
        opts: {
          databaseUrl: string;
          onContended?: SerializeLockContendedMode;
          budgetMs?: number;
          lockKey?: number;
          onOutcome?: (outcome: MigrateGateOutcome, waitMs: number) => void;
        },
        fn: () => Promise<boolean>
      ) => {
        opts.onOutcome?.(gateOutcome, 1);
        return fn();
      }
    ),
    prestampSkippableMigrationsViaSql: vi.fn<
      MigrationPipelineDeps["prestampSkippableMigrationsViaSql"]
    >(() => Promise.resolve()),
    replayPendingMigrationsViaSql: vi.fn<
      MigrationPipelineDeps["replayPendingMigrationsViaSql"]
    >(() => Promise.resolve(opts.replayed ?? false)),
    plainBuildPreviewConcurrentIndexes: vi.fn<
      MigrationPipelineDeps["plainBuildPreviewConcurrentIndexes"]
    >(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn<MigrationPipelineDeps["sweepInvalidIndexes"]>(
      () => Promise.resolve([])
    ),
    runMigrate: vi.fn<MigrationPipelineDeps["runMigrate"]>(() =>
      Promise.resolve(opts.reset ?? false)
    ),
    cloneDataFromPublic: vi.fn<MigrationPipelineDeps["cloneDataFromPublic"]>(
      (_url: string, schema: string) =>
        opts.cloneOk === false
          ? Promise.reject(
              new CloneFailedError(schema, new Error("clone failed"))
            )
          : Promise.resolve()
    ),
    dropSchema: vi.fn<MigrationPipelineDeps["dropSchema"]>(() =>
      Promise.resolve()
    ),
    runPreviewSeed: vi.fn<MigrationPipelineDeps["runPreviewSeed"]>(),
    readVibeEnvironmentMarker: vi.fn<
      MigrationPipelineDeps["readVibeEnvironmentMarker"]
    >(() => Promise.resolve(null)),
    writeVibeEnvironmentMarker: vi.fn<
      MigrationPipelineDeps["writeVibeEnvironmentMarker"]
    >(() => Promise.resolve()),
    readIncompletePreviewBuild: vi.fn<
      MigrationPipelineDeps["readIncompletePreviewBuild"]
    >(() => Promise.resolve(false)),
    clearIncompletePreviewBuild: vi.fn<
      MigrationPipelineDeps["clearIncompletePreviewBuild"]
    >(() => Promise.resolve()),
    withRetry: vi.fn<MigrationPipelineDeps["withRetry"]>(
      (fn: () => Promise<void>) => fn()
    ),
    assertMigrateRoleOwnsSchema: vi.fn<
      MigrationPipelineDeps["assertMigrateRoleOwnsSchema"]
    >(() => Promise.resolve()),
  } satisfies MigrationPipelineDeps;
}
