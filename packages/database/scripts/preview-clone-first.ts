/**
 * ISS-11785 — build a preview schema in the order stage and prod will apply its
 * migrations: the migrations stage `public` has already applied, then a clone of
 * `public`'s rows, then the rest through `prisma migrate deploy`.
 *
 * The previous order migrated the empty schema to head and cloned afterwards, so a
 * migration that depends on existing rows never saw one in any preview.
 * `20260930150000_iss11212_comment_contract_core` passed every preview and failed
 * the prod deploy on one legacy comment (ISS-11749).
 *
 * Runs for a non-merge-queue preview schema that is empty: created in this run,
 * or just reset by recovery (`PreviewResetMode.ResetOnly`). A failure is thrown,
 * never swallowed; nothing here resets the schema to retry it empty. A vibe
 * environment (ISS-12056) is never built here: it stays empty.
 */

import { createHash } from "node:crypto";
import { MERGE_QUEUE_REF_PREFIX } from "./cleanup-preview-schemas-lib";
import { PreviewResetMode } from "./migrate-deploy-recovery";
import {
  MigrateExecutor,
  MigrateGateOutcome,
  type MigrateRunRecorder,
} from "./migrate-telemetry";
import type {
  SerializeLockContendedMode,
  SerializeLockOutcome,
} from "./migration-lock";
import type { MigrationPipelineDeps } from "./migration-pipeline";
import { isPreviewSchema } from "./preview-schema";
import type { MigrationFileReaders } from "./prisma-cli";
import { isVibeEnvironmentSchema } from "./vibe-environment-retention";

export type ClonePreviewContext = {
  databaseUrl: string;
  schema: string;
  branch: string | undefined;
  deps: MigrationPipelineDeps;
  readers: MigrationFileReaders;
  recorder: MigrateRunRecorder;
  serializeMode: SerializeLockContendedMode;
  serializeBudgetMs: number | undefined;
  /** The URL for the steps after the clone, re-minted where configured (ISS-5285). */
  postCloneUrl: () => Promise<string>;
  /** ISS-12056: a vibe environment schema, which is never cloned from `public`. */
  vibeEnvironment: boolean;
};

const PUBLIC_SCHEMA = "public";

/** A non-merge-queue preview schema: the ones this module builds. */
export function isCloneFirstSchema(
  schema: string | null,
  branch: string | undefined
): boolean {
  return (
    isPreviewSchema(schema) &&
    !(branch?.startsWith(MERGE_QUEUE_REF_PREFIX) ?? false)
  );
}

/**
 * Fills a schema that is empty after this run's migrate step (created, or reset
 * by recovery). `replayed`: a reset clone-first schema already holds `public`'s
 * migrations (`replayResetSchema`). A failed clone throws in every branch
 * (ISS-11785).
 */
export async function populateEmptySchema(
  ctx: ClonePreviewContext,
  replayed: boolean
): Promise<void> {
  if (ctx.vibeEnvironment) {
    // ISS-12056: the vibe environment workflow seeds it (or leaves it blank).
    console.log(
      `↪ ${ctx.schema} is a vibe environment; it starts empty and is never cloned from public (ISS-12056)`
    );
    return;
  }
  if (isCloneFirstSchema(ctx.schema, ctx.branch)) {
    await buildPreviewOnClone(ctx, replayed);
    return;
  }
  if (isPreviewSchema(ctx.schema)) {
    // ISS-5285: fresh or reset queue schemas would re-clone the full stage
    // `public` data (an eject+requeue while main is unchanged reuses the
    // byte-identical queue branch name, so it maps to the SAME schema and
    // arrives here via reset, not creation) — concurrent queue waves hang
    // past Vercel's 45-min build cap and wedge the queue. Nobody browses a
    // queue preview: migrations still run, but the schema intentionally
    // starts empty. Skipped, not failed.
    console.log(
      `↪ Merge-queue ref ${ctx.branch} — skipping preview data clone; schema starts empty by design (ISS-5285)`
    );
    return;
  }
  // An explicitly named non-preview schema (`PGSCHEMA`): migrated, then cloned.
  await ctx.deps.cloneDataFromPublic(ctx.databaseUrl, ctx.schema);
}

/**
 * Builds the empty preview `schema` on a clone of `public`. A failure before the
 * clone lands drops an ordinary schema, so the next deploy creates and rebuilds it instead
 * of finding it empty and migrating it as an existing preview. A migration that
 * fails on the cloned rows leaves the schema behind head, so the next deploy
 * re-runs that migration on them.
 */
async function buildPreviewOnClone(
  ctx: ClonePreviewContext,
  replayed: boolean
): Promise<void> {
  try {
    if (!replayed) {
      await migrateToPublicLevel(ctx);
    }
    await ctx.deps.cloneDataFromPublic(ctx.databaseUrl, ctx.schema);
  } catch (error) {
    await dropUnbuiltSchema(ctx);
    throw error;
  }
  const url = await ctx.postCloneUrl();
  if (
    !(await ctx.deps.probePreviewSchemaAtHead(url, ctx.schema, ctx.readers))
  ) {
    await migrateRest(ctx, url);
  }
}

/** Never throws: the build's own failure is the one the caller reports. */
async function dropUnbuiltSchema(ctx: ClonePreviewContext): Promise<void> {
  if (isVibeEnvironmentSchema(ctx.schema, ctx.branch)) {
    return;
  }
  try {
    await ctx.deps.dropSchema(await ctx.postCloneUrl(), ctx.schema);
    console.warn(
      `↪ Dropped ${ctx.schema} so the next deploy rebuilds it on a fresh clone (ISS-11785)`
    );
  } catch (error) {
    console.error(
      `⚠️ Could not drop ${ctx.schema} after its build failed; drop it before the next deploy or it will read as built: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** Replays the migrations `public` has applied, under its own serialize gate hold. */
function migrateToPublicLevel(ctx: ClonePreviewContext): Promise<boolean> {
  const { recorder } = ctx;
  let gateOutcome: SerializeLockOutcome | null = null;
  return ctx.deps.withMigrationSerializeLock(
    {
      databaseUrl: ctx.databaseUrl,
      onContended: ctx.serializeMode,
      budgetMs: ctx.serializeBudgetMs,
      onOutcome: (outcome, waitMs) => {
        gateOutcome = outcome;
        recorder.setGate(outcome, waitMs);
      },
    },
    async () => {
      try {
        await replayToPublicLevel(ctx, gateOutcome, () =>
          recorder.markMigrateStart()
        );
        recorder.setMigrateExecutor(MigrateExecutor.SqlReplay);
        return true;
      } finally {
        recorder.markMigrateDone();
      }
    }
  );
}

/**
 * Applies the migrations `public` has not, over the cloned rows, the way a later
 * deploy of an existing preview does (not-fresh pre-stamp, then `migrate
 * deploy`) but with no reset to fall back on. Its gate, executor and timing
 * replace the first phase's on the run's one telemetry event: this is the
 * migrate that runs the branch's own migrations.
 */
async function migrateRest(ctx: ClonePreviewContext, url: string) {
  const { schema, deps, readers, recorder } = ctx;
  await deps.withMigrationSerializeLock(
    {
      databaseUrl: url,
      onContended: ctx.serializeMode,
      budgetMs: ctx.serializeBudgetMs,
      onOutcome: (outcome, waitMs) => recorder.setGate(outcome, waitMs),
    },
    async () => {
      await deps.prestampSkippableMigrationsViaSql(url, schema, {
        ...readers,
        freshSchema: false,
      });
      recorder.markMigrateStart();
      recorder.setMigrateExecutor(MigrateExecutor.PrismaCli);
      try {
        return await deps.runMigrate(
          url,
          schema,
          ctx.branch,
          { onAttempts: (attempt) => recorder.setAttempts(attempt) },
          deps.prismaCli,
          PreviewResetMode.Never
        );
      } finally {
        recorder.markMigrateDone();
      }
    }
  );
}

/**
 * Replays `public`'s migrations into a clone-first schema that recovery has just
 * reset, inside the serialize gate hold the reset ran under, so a contended
 * second take cannot leave the reset schema dropped (review: tamsinb). Drops
 * the schema when the replay fails, as `buildPreviewOnClone` does.
 */
export async function replayResetSchema(
  ctx: ClonePreviewContext,
  gateOutcome: SerializeLockOutcome | null
): Promise<void> {
  try {
    await replayToPublicLevel(ctx, gateOutcome, () => undefined);
  } catch (error) {
    await dropUnbuiltSchema(ctx);
    throw error;
  }
}

/**
 * Throws when the replay cannot run or does not complete. The replay needs the
 * gate (ISS-8039) and `migrate deploy` cannot stop at `public`'s level, so the
 * only other way on is migrating the empty schema to head, which reports success
 * without the branch's migrations ever meeting a cloned row (review: tamsinb).
 */
async function replayToPublicLevel(
  ctx: ClonePreviewContext,
  gateOutcome: SerializeLockOutcome | null,
  onReplayStart: () => void
): Promise<void> {
  const { databaseUrl, schema, deps, readers } = ctx;
  if (gateOutcome !== MigrateGateOutcome.Acquired) {
    throw new Error(
      `${schema}: the serialize gate was not held, so public's migrations cannot be replayed into it (ISS-11785)`
    );
  }
  await deps.prestampSkippableMigrationsViaSql(databaseUrl, schema, {
    ...readers,
    freshSchema: true,
  });
  onReplayStart();
  if (
    !(await deps.replayPendingMigrationsViaSql(databaseUrl, schema, {
      ...readers,
      appliedInSchema: PUBLIC_SCHEMA,
    }))
  ) {
    throw new Error(
      `${schema}: the replay of public's migrations did not complete (ISS-11785)`
    );
  }
}

/**
 * Runs `fn` holding the build lock of a clone-first preview `schema`, so one
 * pipeline at a time builds or migrates it, across instances. A build releases
 * the serialize gate between `public`'s migrations and the clone; without this a
 * second deploy of the branch, or the migrator walk, takes the gate in that gap
 * and runs the branch's migrations before or under the clone (review:
 * tamsinb). Fails closed: a run that cannot take it within `budgetMs` throws
 * `SerializeLockContendedError` and leaves the schema to the run holding it.
 * Any other schema runs `fn` without it.
 */
export async function withPreviewBuildLock<T>(
  gate: MigrationPipelineDeps["withMigrationSerializeLock"],
  target: {
    databaseUrl: string;
    schema: string | null;
    branch: string | undefined;
    budgetMs?: number;
  },
  fn: () => Promise<T>
): Promise<T> {
  const { schema } = target;
  if (!(schema && isCloneFirstSchema(schema, target.branch))) {
    return fn();
  }
  let result!: T;
  await gate(
    {
      databaseUrl: target.databaseUrl,
      lockKey: previewBuildLockKey(schema),
      onContended: "skip",
      budgetMs: target.budgetMs,
    },
    async () => {
      result = await fn();
      return true;
    }
  );
  return result;
}

/**
 * The build lock's advisory key: a 32-bit hash of `schema` above the int4 range,
 * so it can equal neither the serialize gate's key, Prisma's, nor a
 * `pg_advisory_xact_lock(hashtext(...))` key (`MIGRATION_SERIALIZE_LOCK_KEY`).
 * Two schemas that share a hash only wait for each other.
 */
export function previewBuildLockKey(schema: string): number {
  return (
    PREVIEW_BUILD_LOCK_KEY_BASE +
    createHash("sha256").update(schema).digest().readUInt32BE(0)
  );
}

const PREVIEW_BUILD_LOCK_KEY_BASE = 11_785 * 2 ** 32;
