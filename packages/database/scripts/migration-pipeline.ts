/**
 * The `prisma migrate deploy` pipeline, extracted from migrate.ts so the branch
 * logic is unit-testable via injected dependencies (migrate.ts self-invokes
 * `main()` at import, so it cannot be imported by a test without side effects).
 *
 * Pipeline order (unchanged): ensureSchemaExists → upsertSchemaRegistry →
 * [FEA-3071 at-head probe] → serialize gate (prestamp → migrate) → clone → seed.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MERGE_QUEUE_REF_PREFIX } from "./cleanup-preview-schemas-lib";
import { cloneDataFromPublic } from "./clone-schema";
import { readMigrationSql } from "./db-utils";
import { type InvalidIndex, sweepInvalidIndexes } from "./invalid-index-sweep";
import { recoverMigrateDeployFailure } from "./migrate-deploy-recovery";
import {
  isPrismaAdvisoryLockError,
  isTransientConnectionError,
  isTransientMigrateDeployError,
  MIGRATE_DEPLOY_RETRY,
  withRetry,
} from "./migrate-retry";
import {
  createMigrateRunRecorder,
  type MigrateDeployEvent,
  MigrateOutcome,
  type MigrateResetKind,
  readMigrateTelemetryEnv,
} from "./migrate-telemetry";
import {
  type SerializeLockContendedMode,
  type SerializeLockOutcome,
  withMigrationSerializeLock,
} from "./migration-lock";
import { assertMigrateRoleOwnsSchema } from "./ownership-preflight";
import {
  defaultListMigrationDirs,
  probePreviewSchemaAtHead,
} from "./preview-at-head";
import { plainBuildPreviewConcurrentIndexes } from "./preview-plain-index";
import {
  type PrestampDeps,
  prestampSkippableMigrationsViaSql,
} from "./preview-prestamp";
import {
  ensureSchemaExists,
  isPreviewSchema,
  resetSchema,
  upsertSchemaRegistry,
} from "./preview-schema";
import { runPreviewSeed } from "./preview-seed";

/**
 * Telemetry callbacks threaded into a single migrate (ISS-4392). Optional and
 * best-effort — omitted for non-telemetry callers, so existing deps stay valid.
 */
export type RunMigrateHooks = {
  onAttempts?: (attempt: number) => void;
  onResetKind?: (kind: MigrateResetKind) => void;
};

/**
 * Optional per-run telemetry seam for `applyMigrationsToSchema`. Injected only in
 * tests (real callers use the defaults: process.env + the stdout/POST sink).
 */
export type MigrateTelemetryHooks = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  emit?: (event: MigrateDeployEvent) => void;
};

/** Classify a terminal migrate error into the telemetry outcome. */
function classifyMigrateOutcome(caught: unknown): MigrateOutcome {
  if (caught === undefined) {
    return MigrateOutcome.Ok;
  }
  return isPrismaAdvisoryLockError(caught)
    ? MigrateOutcome.P1002
    : MigrateOutcome.OtherError;
}

async function runMigrateDeploy(
  databaseUrl: string,
  cli: PrismaCliOptions
): Promise<void> {
  const result = await runPrismaCli(["migrate", "deploy"], databaseUrl, cli);
  writeCliOutput(result);

  if (result.error || result.status !== 0) {
    const error =
      result.error ??
      new Error(
        `prisma migrate deploy failed with exit code ${result.status ?? "unknown"}`
      );
    (error as Error & { stdout?: string; stderr?: string }).stdout =
      result.stdout;
    (error as Error & { stdout?: string; stderr?: string }).stderr =
      result.stderr;
    throw error;
  }
}

/**
 * Marks a failed migration as rolled-back using `prisma migrate resolve`.
 * This is the normal Prisma recovery path for failed migrations. A later
 * deploy retry may still surface committed DDL artifacts, which recovery
 * classifies separately before stopping automation.
 */
async function resolveFailedMigration(
  databaseUrl: string,
  migrationName: string,
  cli: PrismaCliOptions
): Promise<void> {
  console.log(`↪ Marking migration ${migrationName} as rolled-back...`);
  const result = await runPrismaCli(
    ["migrate", "resolve", "--rolled-back", migrationName],
    databaseUrl,
    cli
  );
  writeCliOutput(result);

  if (result.error || result.status !== 0) {
    throw new Error(
      `prisma migrate resolve --rolled-back ${migrationName} failed: ${result.stderr || result.error?.message}`
    );
  }
}

/**
 * Attempts to run prisma migrate deploy with automatic recovery:
 *
 * - Preview schemas: P3005/P3009/P3018 → drop and recreate schema, then retry.
 *   Reset is always safe for ephemeral preview schemas, and covers cases like a
 *   migration directory being renamed/regenerated after it was already applied,
 *   which leaves the schema state mismatched with `_prisma_migrations`.
 * - Non-preview schemas: P3009/P3018 (failed migration) → mark as rolled-back
 *   so the next deploy can re-apply. If that retry reports committed DDL
 *   artifacts, emit a bounded diagnostic and leave the next action to an
 *   operator.
 */
/**
 * `recoveryUpsert` is the registry upsert the reset-recovery path runs after it
 * drops + re-migrates a preview schema. It defaults to the real
 * `upsertSchemaRegistry`; the FEA-3071 Slice 2 migrator walk injects a no-op so
 * a reset *during the walk* does not refresh `last_seen_at` and defeat the 7-day
 * TTL reaper (the walk is maintenance, not user activity — TTL must reflect real
 * deploys only).
 */
export function runMigrateWithRetry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  recoveryUpsert: (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined
  ) => Promise<void> = upsertSchemaRegistry,
  // ISS-4392 telemetry: optional and best-effort. `onAttempts` observes ONLY the
  // migrate retry loop (not the recovery-path registry upsert); `onResetKind`
  // fires when recovery forces a preview reset. Absent → identical behavior.
  hooks: RunMigrateHooks = {},
  // ISS-6403 Finding 5: per-invocation, never process-global. BOUND HERE into
  // both spawns — the deploy and the rolled-back recovery — so a recovery
  // cannot run the CLI from a different config directory than the migrate it is
  // recovering. The recovery deps bag keeps its existing arity; these closures
  // are what carry the option across it.
  cli: PrismaCliOptions = {}
): Promise<boolean> {
  const deploy = (url: string) => runMigrateDeploy(url, cli);
  return withRetry(() => deploy(databaseUrl), isTransientMigrateDeployError, {
    ...MIGRATE_DEPLOY_RETRY,
    onAttempts: hooks.onAttempts,
  })
    .then(() => false)
    .catch((error) =>
      recoverMigrateDeployFailure(
        {
          databaseUrl,
          schema,
          branch,
          error,
        },
        {
          runMigrateDeploy: deploy,
          resolveFailedMigration: (url, migrationName) =>
            resolveFailedMigration(url, migrationName, cli),
          resetSchema,
          upsertSchemaRegistry: recoveryUpsert,
          // ISS-6810: the recovery re-stamp reads the same migration files
          // the first pre-stamp did — from THIS run's directory, not cwd.
          // ISS-6814: recovery stamps only after `resetSchema`, i.e. on a
          // schema that is fresh by construction, so the plain-build entries
          // run natively there too.
          prestampSkippableMigrations: (url, recoverySchema) =>
            prestampSkippableMigrationsViaSql(url, recoverySchema, {
              ...migrationFileReaders(cli),
              freshSchema: true,
            }),
          onResetKind: hooks.onResetKind,
        }
      )
    );
}

/**
 * Injectable collaborators for `runMigrationPipeline`. Defaults bind the real
 * implementations; tests override them to assert the at-head branch skips the
 * gate/prestamp/migrate/clone while every other case takes the normal path.
 */
export type MigrationPipelineDeps = {
  ensureSchemaExists: (
    databaseUrl: string,
    schema: string | null
  ) => Promise<boolean>;
  upsertSchemaRegistry: (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined
  ) => Promise<void>;
  probePreviewSchemaAtHead: (
    databaseUrl: string,
    schema: string | null,
    // ISS-6810: the run's migration-file readers; 2-arg mocks stay assignable.
    readers?: MigrationFileReaders
  ) => Promise<boolean>;
  // Typed at the pipeline's concrete usage (the gate wraps the migrate, which
  // returns boolean) rather than generically — this keeps the injected test
  // mocks assignable without casts, and the real generic implementations remain
  // assignable to the concrete field.
  withMigrationSerializeLock: (
    opts: {
      databaseUrl: string;
      onContended?: SerializeLockContendedMode;
      budgetMs?: number;
      // ISS-4392: optional telemetry callback; existing mocks omit it harmlessly.
      onOutcome?: (outcome: SerializeLockOutcome, waitMs: number) => void;
    },
    fn: () => Promise<boolean>
  ) => Promise<boolean>;
  prestampSkippableMigrationsViaSql: (
    databaseUrl: string,
    schema: string | null,
    // ISS-6810 readers + ISS-6814 fresh-schema scope; 2-arg mocks stay assignable.
    opts?: MigrationFileReaders & Pick<PrestampDeps, "freshSchema">
  ) => Promise<void>;
  // ISS-4437: plain-build (CONCURRENTLY-stripped) the correctness indexes a
  // preview needs, after migrate deploy and the clone. Fail-CLOSED (throws if an
  // index is missing/invalid after building). `budgetMs` bounds its lock/build
  // waits (the walk threads its remaining admission deadline). No-op for public/null.
  plainBuildPreviewConcurrentIndexes: (
    databaseUrl: string,
    schema: string | null,
    opts?: { budgetMs?: number } & MigrationFileReaders
  ) => Promise<void>;
  // ISS-4601: post-deploy sweep for INVALID indexes (a cancelled CONCURRENTLY
  // build that `IF NOT EXISTS` then no-ops over, leaving a green deploy with an
  // unusable index). Best-effort and WARN-ONLY by design — see the module header
  // for why fail-closed here would turn a perf regression into a deploy lockout.
  // `null` means the sweep could not run, which is UNKNOWN, not clean.
  sweepInvalidIndexes: (
    databaseUrl: string,
    schema: string | null,
    opts?: { budgetMs?: number }
  ) => Promise<InvalidIndex[] | null>;
  runMigrate: (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined,
    // ISS-4392: optional telemetry hooks; 3-arg mocks stay assignable.
    hooks?: RunMigrateHooks,
    // ISS-6403: the Prisma CLI spawn options for THIS run; 4-arg mocks stay
    // assignable.
    cli?: PrismaCliOptions
  ) => Promise<boolean>;
  // Returns true on a fully successful clone, false when the clone was attempted
  // but failed (swallowed, schema starts empty). Callers use it to avoid counting
  // a reset-with-failed-clone as a clean success.
  cloneDataFromPublic: (
    databaseUrl: string,
    schema: string
  ) => Promise<boolean>;
  runPreviewSeed: (databaseUrl: string, schema: string | null) => void;
  withRetry: (
    fn: () => Promise<void>,
    isTransient: (error: unknown) => boolean,
    opts: { attempts: number }
  ) => Promise<void>;
  // ISS-5952: table-ownership preflight for NON-preview schemas (no-op for
  // previews). Runs BEFORE the serialize gate + migrate deploy on one read-only
  // catalog query: foreign-owned tables with migrations pending fail the deploy
  // before any DDL can partially commit (the 2026-08-11 42501 → 42701
  // partial_committed_ddl_artifact wedge); dormant drift and preflight-internal
  // errors only warn (fail-open).
  assertMigrateRoleOwnsSchema: (
    databaseUrl: string,
    schema: string | null,
    readers?: MigrationFileReaders
  ) => Promise<void>;
  // ISS-5285: OPTIONAL re-mint of the connection URL for the steps that run
  // AFTER the clone. `migrate.ts` bakes ONE 15-minute RDS IAM token into
  // `databaseUrl` up front, and every later step opens a fresh connection with
  // it, so a long clone leaves the next step authenticating with an expired
  // token (`PAM authentication failed for user "vercel_iam"`). Absent — the
  // DATABASE_URL password path, local dev, and every existing caller/test — the
  // original URL is threaded through exactly as before.
  refreshDatabaseUrl?: () => Promise<string>;
  // ISS-6403: how to spawn the Prisma CLI for THIS run. Configuration, not a
  // collaborator — same shape as `refreshDatabaseUrl` above. Absent (the build,
  // the migrator walk, every existing test) → the child inherits this process's
  // cwd, exactly as before.
  prismaCli?: PrismaCliOptions;
};

const DEFAULT_PIPELINE_DEPS: MigrationPipelineDeps = {
  ensureSchemaExists,
  upsertSchemaRegistry,
  // ISS-6810: the four steps that read migration files take the run's readers
  // as their injected deps; absent readers leave each one on its cwd default.
  probePreviewSchemaAtHead: (databaseUrl, schema, readers) =>
    probePreviewSchemaAtHead(databaseUrl, schema, readers),
  withMigrationSerializeLock,
  prestampSkippableMigrationsViaSql: (databaseUrl, schema, readers) =>
    prestampSkippableMigrationsViaSql(databaseUrl, schema, readers),
  plainBuildPreviewConcurrentIndexes,
  sweepInvalidIndexes,
  // Adapter so the telemetry `hooks` (4th dep arg) map to runMigrateWithRetry's
  // 5th arg without displacing its `recoveryUpsert` default (4th arg).
  runMigrate: (databaseUrl, schema, branch, hooks, cli) =>
    runMigrateWithRetry(databaseUrl, schema, branch, undefined, hooks, cli),
  cloneDataFromPublic,
  runPreviewSeed,
  withRetry,
  assertMigrateRoleOwnsSchema: (databaseUrl, schema, readers) =>
    assertMigrateRoleOwnsSchema(databaseUrl, schema, readers),
};

/**
 * Applies pending migrations to ONE schema: the probe → serialize-gate (prestamp
 * + migrate) → clone-on-reset core, shared verbatim by `runMigrationPipeline`
 * (below) and the FEA-3071 Slice 2 migrator walk (`migrate-all-previews.ts`), so
 * both apply migrations identically. Returns `didReset` so the caller can decide
 * whether a post-reset seed is needed. Deliberately does NOT ensure the schema,
 * upsert the registry, or seed — those are the caller's responsibility.
 *
 * `opts.serializeMode` chooses the gate's acquire-failure behavior:
 *  - `"run"` (pipeline default): fail open — a user deploy must not be blocked.
 *  - `"skip"` (the walk): fail closed — a `SerializeLockContendedError` propagates
 *    so the walk skips the schema instead of migrating it unguarded (which would
 *    make the walk a source of Prisma-lock 72707369 contention).
 * `opts.serializeBudgetMs` overrides the gate's `statement_timeout` for the lock
 * wait (the walk threads its remaining admission deadline so no schema blocks on
 * the lock past it); omitted → the gate's default budget.
 * `opts.isNew` skips the at-head probe for a freshly-created schema (it must migrate).
 * Returns `didReset` and `cloneFailed` (a post-(reset|new) clone was attempted and
 * failed) so a caller can classify a reset-with-failed-clone distinctly, plus
 * `invalidIndexes` from the ISS-4601 post-deploy sweep (`null` = sweep did not run).
 */
export async function applyMigrationsToSchema(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  opts: {
    isNew: boolean;
    serializeMode?: SerializeLockContendedMode;
    serializeBudgetMs?: number;
    /** ISS-4392: injected only in tests; real callers use env + the default sink. */
    telemetry?: MigrateTelemetryHooks;
  },
  overrides: Partial<MigrationPipelineDeps> = {}
): Promise<{
  didReset: boolean;
  cloneFailed: boolean;
  invalidIndexes: InvalidIndex[] | null;
}> {
  const deps = { ...DEFAULT_PIPELINE_DEPS, ...overrides };
  const { isNew } = opts;
  const serializeMode = opts.serializeMode ?? "run";

  // ISS-4392: one telemetry event per schema-migrate. A FRESH recorder per call
  // (the walk migrates N schemas per process); emits in the `finally` so a thrown
  // P1002 is still recorded. Real callers omit `telemetry` → env + the stdout/POST
  // sink (Vercel-gated); tests inject env/now/emit. Never throws into the migrate.
  const recorder = createMigrateRunRecorder({
    schema,
    isPreview: isPreviewSchema(schema),
    env: readMigrateTelemetryEnv(opts.telemetry?.env ?? process.env),
    now: opts.telemetry?.now,
    emit: opts.telemetry?.emit,
  });
  recorder.start();
  let caught: unknown;
  // ISS-6810: one set of readers for every step of THIS run that opens a
  // migration file, so none of them can silently fall back to cwd alone.
  const readers = migrationFileReaders(deps.prismaCli ?? {});

  try {
    // FEA-3071 Slice 1: lock-free at-head probe. An EXISTING preview schema that
    // is already at migration head skips the gate + migrate entirely, taking ZERO
    // acquisitions of Prisma's per-DB migration advisory lock (72707369) — the
    // dominant baseline lock traffic that stacks the FEA-3065 gate. Fail-open: any
    // probe uncertainty falls through to the gated migrate below. Never fires for
    // `public` (isPreviewSchema=false) or a brand-new schema (isNew), which must
    // migrate.
    const previewAtHead =
      !isNew &&
      (await deps.probePreviewSchemaAtHead(databaseUrl, schema, readers));
    recorder.setAtHeadSkip(previewAtHead);

    if (previewAtHead) {
      console.log(
        `↪ ${schema} already at migration head — skipped migrate deploy (0 advisory locks, FEA-3071)`
      );
    }

    // FEA-3065: serialize the migrate against concurrent api deploys on the same
    // database through our own advisory lock, so Prisma's per-DB migration lock
    // (72707369) is uncontended. Wraps ONLY the lock-taking steps (ensure/registry
    // run in runMigrationPipeline; clone runs below, all outside the gate).
    //
    // `didReset` stays false when the at-head probe skipped the migrate: no reset
    // happened, so the clone below must NOT run (the existing preview keeps its
    // data). Only the gated migrate path can report a reset.
    let didReset = false;
    if (!previewAtHead) {
      // ISS-5952: ownership preflight BEFORE the gate and before any DDL. For a
      // non-preview schema with foreign-owned tables AND pending migrations this
      // throws — a clean pre-DDL failure instead of a mid-file 42501 partial
      // commit. Outside the serialize gate on purpose: it is one read-only
      // catalog query and must not extend the lock hold. No-op for previews.
      await deps.assertMigrateRoleOwnsSchema(databaseUrl, schema, readers);
      didReset = await deps.withMigrationSerializeLock(
        {
          databaseUrl,
          onContended: serializeMode,
          budgetMs: opts.serializeBudgetMs,
          onOutcome: (outcome, waitMs) => recorder.setGate(outcome, waitMs),
        },
        async () => {
          // On ephemeral preview schemas, pre-stamp the CONCURRENTLY perf-index
          // migration(s) as applied so the migrate deploy below skips their build.
          // `CREATE INDEX CONCURRENTLY` waits for every concurrent transaction on the
          // shared stage instance to drain, stretching each preview deploy's hold on
          // Prisma's migration advisory lock and starving peers into P1002 — and a
          // preview schema needs no perf index. No-op for `public`. LOCK-FREE (direct
          // SQL, not `prisma migrate resolve`, which itself takes Prisma's 72707369
          // lock and fails open under exactly this contention) and best-effort. The
          // reset path (P3005/P3009/P3018 → drop + re-migrate) is covered inside
          // recoverMigrateDeployFailure via the same prestampSkippableMigrations dep,
          // so both migrate entry points skip the build consistently. (FEA-3817.)
          //
          // ISS-6814: a schema created in THIS run is empty for the whole
          // migrate, so its plain-build (unique, correctness) entries run
          // natively instead of being stamped — a later migration's FK may
          // reference them, and on an empty table the CONCURRENTLY build is
          // milliseconds. See `PrestampScopeOptions`.
          await deps.prestampSkippableMigrationsViaSql(databaseUrl, schema, {
            ...readers,
            freshSchema: isNew,
          });
          recorder.markMigrateStart();
          try {
            return await deps.runMigrate(
              databaseUrl,
              schema,
              branch,
              {
                onAttempts: (attempt) => recorder.setAttempts(attempt),
                onResetKind: (kind) => recorder.setResetKind(kind),
              },
              deps.prismaCli
            );
          } finally {
            // Capture migrate_ms even when the migrate throws — the P1002/failed
            // cohort is exactly what this telemetry exists to analyze.
            recorder.markMigrateDone();
          }
        }
      );
    }

    let cloneFailed = false;
    if ((isNew || didReset) && schema) {
      if (branch?.startsWith(MERGE_QUEUE_REF_PREFIX)) {
        // ISS-5285: fresh or reset queue schemas would re-clone the full stage
        // `public` data (an eject+requeue while main is unchanged reuses the
        // byte-identical queue branch name, so it maps to the SAME schema and
        // arrives here via reset, not creation) — concurrent queue waves hang
        // past Vercel's 45-min build cap and wedge the queue. Nobody browses a
        // queue preview: migrations still run (above), but the schema
        // intentionally starts empty. Skipped ≠ failed — `cloneFailed` stays
        // false so the deploy is not classified as a reset-with-failed-clone.
        console.log(
          `↪ Merge-queue ref ${branch} — skipping preview data clone; schema starts empty by design (ISS-5285)`
        );
      } else {
        const cloned = await deps.cloneDataFromPublic(databaseUrl, schema);
        cloneFailed = !cloned;
      }
    }

    // ISS-4437: plain-build the CONCURRENTLY correctness indexes a preview needs
    // (FEA-3857's search_document unique upsert key + its perf indexes), which the
    // prestamp above skipped. OUTSIDE the serialize gate (raw pg, no Prisma lock).
    //
    // AFTER the clone (not before): if this throws after a fresh/reset migrate, the
    // clone has already persisted, so the retry — which sees the schema at head and
    // skips both migrate and clone — still has its data and just rebuilds the index.
    // Building on the freshly-cloned table is duplicate-safe because `public`
    // enforces the same unique constraint, so cloned rows never collide.
    //
    // Runs on EVERY preview deploy, NOT gated on `previewAtHead`: the at-head probe
    // reads only `_prisma_migrations` names, not real indexes, so a schema whose
    // earlier build failed would otherwise report at-head and stay broken;
    // re-running is a cheap `IF NOT EXISTS` no-op when the indexes already exist.
    // Its lock/build waits are bounded by the caller's remaining budget (the walk's
    // admission deadline) so one slow build can't blow it. FAIL-CLOSED — a missing
    // correctness index throws and fails the deploy rather than silently marking the
    // migration applied without its unique upsert target. No-op for public/null.
    // ISS-5285: re-mint the URL before this step. The clone above is the one
    // unbounded step in the pipeline, so it is the one that can outlive the
    // 15-minute IAM token baked into `databaseUrl`; this step opens a FRESH
    // connection and is fail-CLOSED, so a stale token here errors the deploy.
    // No-op when the dep is absent.
    const postCloneUrl = await refreshedOrOriginalUrl(
      databaseUrl,
      deps.refreshDatabaseUrl
    );
    await deps.plainBuildPreviewConcurrentIndexes(postCloneUrl, schema, {
      budgetMs: opts.serializeBudgetMs,
      ...readers,
    });

    // ISS-4601: LAST step, and deliberately NOT gated on `previewAtHead` or on
    // this deploy having applied anything. A cancelled `CREATE INDEX CONCURRENTLY`
    // leaves an INVALID index that the P3018 recovery retry then no-ops over with
    // `IF NOT EXISTS`, so the migration is recorded applied and the deploy goes
    // green with a permanently unusable index. Nothing is pending afterwards, so
    // the ONLY deploy that can still notice is a later one running this sweep over
    // the whole schema — which is also what surfaces an invalid index left by a
    // much older migration on prod. Warn-only (see the module header): it records
    // the finding on the telemetry event and lets the caller qualify its success
    // line, and can never fail the deploy on its own.
    // Same budget the plain-index build gets, so the walk's admission deadline
    // bounds every step it owns rather than all-but-one.
    //
    // Guarded HERE, not only inside the sweep: "warn, never fail" lives in the
    // default implementation, but this is an overridable dep and the pipeline
    // spreads arbitrary `...overrides` into it. An injected seam that rejects
    // would otherwise reach the `catch` below, be recorded by
    // `classifyMigrateOutcome` as a migrate FAILURE, and print `❌ Migration
    // failed` with `process.exitCode = 1` — turning a green deploy red over a
    // best-effort diagnostic that runs AFTER migrate deploy, the clone and the
    // plain-index build have all succeeded. `null` keeps the honest distinction
    // the whole feature rests on: UNKNOWN, never "verified clean".
    let invalidIndexes: InvalidIndex[] | null = null;
    try {
      invalidIndexes = await deps.sweepInvalidIndexes(postCloneUrl, schema, {
        budgetMs: opts.serializeBudgetMs,
      });
    } catch (sweepError) {
      console.warn(
        `⚠️  INVALID-index sweep failed (non-blocking, ISS-4601); index state UNVERIFIED: ${
          sweepError instanceof Error ? sweepError.message : String(sweepError)
        }`
      );
    }
    if (invalidIndexes) {
      recorder.setInvalidIndexes(invalidIndexes.map((index) => index.name));
    }

    return { didReset, cloneFailed, invalidIndexes };
  } catch (error) {
    caught = error;
    throw error;
  } finally {
    recorder.finish(classifyMigrateOutcome(caught));
  }
}

/**
 * Shared migration pipeline: ensure schema → register → migrate → clone → seed.
 * Used by both DATABASE_URL (password) and IAM auth paths.
 *
 * Returns the ISS-4601 sweep result so the caller can qualify its terminal
 * success line: `null` means the sweep did not run (state unverified), `[]` means
 * verified clean, and a non-empty list means the deploy left invalid indexes.
 */
export async function runMigrationPipeline(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  overrides: Partial<MigrationPipelineDeps> = {}
): Promise<{ invalidIndexes: InvalidIndex[] | null }> {
  const deps = { ...DEFAULT_PIPELINE_DEPS, ...overrides };

  console.log("↪ Ensuring schema exists...");
  const isNew = await deps.ensureSchemaExists(databaseUrl, schema);
  /**
   * Ordering invariant: ensureSchemaExists → upsertSchemaRegistry → runMigrate → cloneDataFromPublic.
   * ensureSchemaExists must run first so the schema row exists before we write the registry entry.
   * upsertSchemaRegistry must complete before runMigrate so that any mid-migration failure
   * leaves a registered (reapable) orphan rather than a silent unregistered one.
   * If all retries are exhausted, runMigrationPipeline throws, the deploy fails loudly, and the
   * schema created by ensureSchemaExists is left unregistered — the FEA-1082 orphan reaper will
   * clean it up on its next run.
   * IAM token note: retries reuse the original IAM-signed databaseUrl; the 15-minute RDS token
   * validity is the implicit upper bound on total retry time (irrelevant at zero-delay/3 attempts,
   * but relevant if delay or attempt count is increased in future).
   */
  await deps.withRetry(
    () => deps.upsertSchemaRegistry(databaseUrl, schema, branch),
    isTransientConnectionError,
    { attempts: 3 }
  );

  // Probe → serialize gate (prestamp + migrate) → clone. Fail-open gate (user
  // deploys must not be blocked). Shared verbatim with the migrator walk.
  const { invalidIndexes } = await applyMigrationsToSchema(
    databaseUrl,
    schema,
    branch,
    { isNew, serializeMode: "run" },
    overrides
  );

  // Seed preview schemas with synthetic data (FEA-1715). Intentionally OUTSIDE
  // the (isNew || didReset) gate above: the seed is idempotent and non-blocking,
  // so running it after every successful migration makes a prior non-blocking
  // seed failure recoverable on the next deploy (review: shafty023). No-op for
  // non-preview schemas.
  //
  // ISS-5285: the seed spawns a subprocess whose DATABASE_URL is built from the
  // URL passed here, so it needs the same post-clone re-mint the index build
  // gets. No-op when the dep is absent.
  const seedUrl = await refreshedOrOriginalUrl(
    databaseUrl,
    deps.refreshDatabaseUrl
  );
  deps.runPreviewSeed(seedUrl, schema);

  return { invalidIndexes };
}

/**
 * Returns a freshly-minted connection URL, or the original when no re-mint is
 * configured. ISS-5285: a re-mint failure must NOT fail the deploy on its own —
 * it degrades to the existing URL and lets the downstream step report the real
 * error, so this never masks the failure it is meant to prevent.
 */
async function refreshedOrOriginalUrl(
  databaseUrl: string,
  refreshDatabaseUrl: (() => Promise<string>) | undefined,
  logger: Pick<Console, "warn"> = console
): Promise<string> {
  if (!refreshDatabaseUrl) {
    return databaseUrl;
  }
  try {
    return await refreshDatabaseUrl();
  } catch (error) {
    logger.warn(
      `⚠️  Could not re-mint the database URL, reusing the existing one: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return databaseUrl;
  }
}

/**
 * Absolute path of the bundled Prisma CLI entrypoint, for a caller that cannot
 * reach the CLI through `PATH`. Read here and set by
 * `apps/api/app/preview-schemas/ensure` — the env var is the contract between
 * them, so neither side spells it as a literal.
 */
export const PRISMA_CLI_ENTRY_ENV = "PRISMA_CLI_ENTRY";

/**
 * How to spawn the Prisma CLI: found on `PATH` (the build), or run as an
 * explicit entrypoint under the current `node` (a deployed function).
 *
 * ISS-6403. The build has pnpm's `.bin` on `PATH`, so a bare `prisma` resolves.
 * A deployed serverless bundle only LOOKS like it does: Next file tracing copies
 * the `.bin/prisma` shim and the CLI's files in the pnpm store, but not the
 * symlink between them, so the shim's `<bin>/../prisma/build/index.js` is
 * MODULE_NOT_FOUND and the CLI dies before it opens a connection. A caller that
 * has located the real entrypoint in its own bundle passes it here instead.
 *
 * BOTH `prisma` spawns in this module route through this helper deliberately.
 * The rolled-back recovery has to run wherever the migrate itself does — a
 * migrate that can spawn and a recovery that cannot is the worse failure, since
 * it strands `_prisma_migrations` mid-migration.
 *
 * ISS-6781: an entrypoint spawn also takes `cli.preload` as node's `--import`.
 * `NODE_PATH` (ISS-6728) makes the CLI's CommonJS `require`s resolve out of the
 * symlink-free bundle; its config loader then `import`s ES modules, which node
 * resolves without ever consulting `NODE_PATH`. The preload is the ESM half of
 * that bridge. Passed as an argument, not through `NODE_OPTIONS`: it belongs to
 * this spawn, and the env would carry it into every child of this process. The
 * PATH spawn ignores it — the build's install has its symlinks.
 */
function prismaCliInvocation(
  args: string[],
  cli: PrismaCliOptions
): {
  command: string;
  args: string[];
  cwd: string | undefined;
} {
  // Empty/whitespace reads as unset: a blank cwd names no directory, and
  // spawning into one would only guarantee the CLI fails.
  const cwd = cli.cwd?.trim() || undefined;
  const entry = process.env[PRISMA_CLI_ENTRY_ENV];
  if (!entry) {
    return { command: "prisma", args, cwd };
  }
  const preload = cli.preload?.trim();
  const preloadArgs = preload ? ["--import", pathToFileURL(preload).href] : [];
  return {
    command: process.execPath,
    args: [...preloadArgs, entry, ...args],
    cwd,
  };
}

/**
 * How to spawn the Prisma CLI for ONE pipeline run.
 *
 * `cwd` is the directory the CLI discovers `prisma.config.mjs` from (Prisma 7
 * reads `datasource.url` only from a config file), for a caller whose OWN cwd is
 * not where that config lives — today `apps/api/app/preview-schemas/ensure`.
 * Absent → the child inherits this process's cwd, which is what the build and
 * the migrator walk want.
 *
 * ISS-6403 Finding 5. That caller first `process.chdir()`d into the config
 * directory, then passed it through a `PRISMA_CLI_CWD` env var. Neither is
 * per-invocation: `chdir` moved the cwd of every OTHER request on a warm Fluid
 * Compute instance for the rest of its life, and an env var is the same
 * process-global reach one indirection later — every build and migrator caller
 * reads whatever was last written to it, so a stale inherited value silently
 * runs Prisma from the wrong config directory. A value that belongs to one run
 * travels as an argument of that run (review: shafty023).
 */
export type PrismaCliOptions = {
  cwd?: string;
  /**
   * Absolute path of an ES module for node's `--import`, honored only on an
   * entrypoint spawn (`PRISMA_CLI_ENTRY`). Today the ensure route's
   * `esm-store-resolver.mjs`; see `prismaCliInvocation`.
   */
  preload?: string;
  /**
   * ISS-6810: the migrations directory THIS run's in-process readers use — the
   * at-head probe, the pre-stamp (and its recovery re-run), the plain-index
   * build and the ownership preflight all read `prisma/migrations` themselves,
   * off `process.cwd()` by default. The CLI finds the same directory through
   * `prisma.config.mjs`; these readers have no config, so a caller whose cwd is
   * not the Prisma project names it here. Absent → cwd-relative, as the build.
   */
  migrationsDir?: string;
};

/**
 * The migration-file readers a run's `migrationsDir` implies, or nothing when
 * it is unset so every callee keeps its own cwd-relative default.
 */
export type MigrationFileReaders = {
  readMigrationSql?: (migrationName: string) => string;
  listMigrationDirs?: () => string[];
};

function migrationFileReaders(cli: PrismaCliOptions): MigrationFileReaders {
  const migrationsDir = cli.migrationsDir?.trim();
  if (!migrationsDir) {
    return {};
  }
  return {
    readMigrationSql: (migrationName) =>
      readMigrationSql(migrationName, migrationsDir),
    listMigrationDirs: () => defaultListMigrationDirs(migrationsDir),
  };
}

/**
 * What both CLI wrappers branch on: the child's exit status, the spawn error if
 * it never started, and its drained output.
 */
type PrismaCliResult = {
  status: number | null;
  error: Error | undefined;
  stdout: string;
  stderr: string;
};

/**
 * Ceiling on the CLI output held in memory, across both streams, per spawn.
 *
 * ISS-6403: `spawnSync` enforced a 1 MB `maxBuffer` by default and killed the
 * child past it; the async drain that replaced it accumulated into JS strings
 * with no bound at all, so a verbose or runaway migration could grow the SHARED
 * api process heap until unrelated requests died with it — and overlapping
 * ensure requests multiply that (review: shafty023). Counted in UTF-16 units
 * rather than bytes, which bounds the heap by construction and is the same
 * number for the CLI's ASCII output.
 */
const MAX_PRISMA_CLI_OUTPUT_CHARS = 1_000_000;

/** Kept in the bounded output so an operator sees diagnostics END, not stop. */
const PRISMA_CLI_OUTPUT_TRUNCATED_MARKER =
  "\n[output truncated: exceeded the Prisma CLI output ceiling]\n";

/** Forwards the CLI's captured output to this process's streams, as before. */
function writeCliOutput(result: PrismaCliResult): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

/**
 * Spawns the Prisma CLI and resolves once it has exited and its output is
 * drained.
 *
 * ISS-6403 Finding 4: this was `spawnSync`. Correct for the build script it was
 * written for, and wrong once `apps/api` reached it from a REQUEST HANDLER —
 * `spawnSync` blocks the Node event loop for the child's entire lifetime, so a
 * `migrate deploy` froze every other request Fluid Compute had multiplexed onto
 * that instance. This is the BFF that serves all product traffic.
 *
 * Resolves rather than rejects on failure: the callers above own the error
 * shapes (recovery classifies P3009/P3018 off `stdout`/`stderr` attached to the
 * thrown error), and a rejection here would flatten that distinction. `close`
 * fires after the stdio streams end, so nothing is lost by resolving on it; a
 * process that never starts emits `error` instead and reports a null status.
 *
 * Output is bounded — see `MAX_PRISMA_CLI_OUTPUT_CHARS`. Past the ceiling the
 * child is terminated and the run FAILS, carrying the output captured up to
 * that point plus a truncation marker: the diagnostics are the whole reason
 * this output is captured (recovery classifies off them, and the sanitizer
 * exists to let them reach an operator), so the ceiling truncates them rather
 * than discarding them.
 */
function runPrismaCli(
  args: string[],
  databaseUrl: string,
  cli: PrismaCliOptions
): Promise<PrismaCliResult> {
  const invocation = prismaCliInvocation(args, cli);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "pipe",
      cwd: invocation.cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    let stdout = "";
    let stderr = "";
    let overflow: Error | undefined;

    // One budget across both streams: the heap is what is being bounded, and it
    // does not care which stream filled it.
    const capture = (append: (text: string) => void) => (chunk: string) => {
      if (overflow) {
        return;
      }
      const remaining =
        MAX_PRISMA_CLI_OUTPUT_CHARS - (stdout.length + stderr.length);
      if (chunk.length <= remaining) {
        append(chunk);
        return;
      }
      append(chunk.slice(0, Math.max(0, remaining)));
      append(PRISMA_CLI_OUTPUT_TRUNCATED_MARKER);
      overflow = new Error(
        `prisma ${args[0] ?? "cli"} produced more than ${MAX_PRISMA_CLI_OUTPUT_CHARS} characters of output and was terminated`
      );
      child.kill();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      capture((text) => {
        stdout += text;
      })
    );
    child.stderr.on(
      "data",
      capture((text) => {
        stderr += text;
      })
    );

    child.on("error", (error) => {
      resolve({ status: null, error: overflow ?? error, stdout, stderr });
    });
    // An overflow is a FAILURE however the killed child exits: the output the
    // callers classify off is incomplete, so it must not be reported as success.
    child.on("close", (status) => {
      resolve({ status, error: overflow, stdout, stderr });
    });
  });
}
