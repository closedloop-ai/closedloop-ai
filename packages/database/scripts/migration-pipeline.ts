/**
 * The `prisma migrate deploy` pipeline, extracted from migrate.ts so the branch
 * logic is unit-testable via injected dependencies (migrate.ts self-invokes
 * `main()` at import, so it cannot be imported by a test without side effects).
 *
 * Pipeline order: ensureSchemaExists → upsertSchemaRegistry → [FEA-3071 at-head
 * probe] → serialize gate (prestamp → migrate) → seed. An empty non-merge-queue
 * preview schema is migrated around a clone of `public` instead (ISS-11785,
 * `preview-clone-first.ts`), unless it is a vibe environment, which is migrated
 * empty and never seeded here (ISS-12056, `vibe-environment-build.ts`).
 */

import { CloneFailedError, cloneDataFromPublic } from "./clone-schema";
import { type InvalidIndex, sweepInvalidIndexes } from "./invalid-index-sweep";
import {
  type PreviewResetMode,
  recoverMigrateDeployFailure,
} from "./migrate-deploy-recovery";
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
  MigrateExecutor,
  MigrateGateOutcome,
  MigrateOutcome,
  type MigrateResetKind,
  readMigrateTelemetryEnv,
  type TerminalMigrateOutcome,
} from "./migrate-telemetry";
import {
  type SerializeLockContendedMode,
  type SerializeLockOutcome,
  withMigrationSerializeLock,
} from "./migration-lock";
import { assertMigrateRoleOwnsSchema } from "./ownership-preflight";
import { probePreviewSchemaAtHead } from "./preview-at-head";
import {
  clearIncompletePreviewBuild,
  PreviewBuildState,
  readIncompletePreviewBuild,
} from "./preview-build-state";
import {
  isCloneFirstSchema,
  populateEmptySchema,
  replayResetSchema,
  withPreviewBuildLock,
} from "./preview-clone-first";
import { plainBuildPreviewConcurrentIndexes } from "./preview-plain-index";
import {
  type PrestampDeps,
  prestampSkippableMigrationsViaSql,
} from "./preview-prestamp";
import { selectPreviewResetMode } from "./preview-reset-policy";
import {
  dropSchema,
  ensureSchemaExists,
  isPreviewSchema,
  resetSchema,
  upsertSchemaRegistry,
} from "./preview-schema";
import { runPreviewSeed } from "./preview-seed";
import { replayPendingMigrationsViaSql } from "./preview-sql-replay";
import {
  type MigrationFileReaders,
  migrationFileReaders,
  type PrismaCliOptions,
  runPrismaCli,
  writeCliOutput,
} from "./prisma-cli";
import {
  readVibeEnvironmentMarker,
  type VibeEnvironmentMarker,
  type VibeEnvironmentMode,
  writeVibeEnvironmentMarker,
} from "./vibe-environment";
import { ensureSchemaForBuild } from "./vibe-environment-build";
import { isVibeEnvironmentSchema } from "./vibe-environment-retention";

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
function classifyMigrateOutcome(caught: unknown): TerminalMigrateOutcome {
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
 * - Ordinary preview schemas: P3005/P3009/P3018 reset and retry. Retained vibe
 *   schemas refuse destructive recovery unless an explicit build just recreated
 *   them empty. Recovery for ephemeral previews covers cases like a
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
  cli: PrismaCliOptions = {},
  // ISS-12135: omission uses retention policy; explicit builders pass a chosen mode.
  previewReset?: PreviewResetMode
): Promise<boolean> {
  const deploy = (url: string) => runMigrateDeploy(url, cli);
  const resetMode = previewReset ?? selectPreviewResetMode({ schema, branch });
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
          previewReset: resetMode,
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
      lockKey?: number;
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
  // ISS-8039: on a schema created in THIS run, apply the pending migrations
  // directly over one pg connection instead of spawning `prisma migrate deploy`.
  // Same files, same order, so the resulting schema is identical; what goes away
  // is the per-migration CLI round trip, which is what had grown `migrate_ms` to
  // 258s of a 290s route budget. Returns false to fall back to the CLI.
  replayPendingMigrationsViaSql: (
    databaseUrl: string,
    schema: string | null,
    // ISS-11785: `appliedInSchema` limits the replay to `public`'s level.
    readers?: MigrationFileReaders & { appliedInSchema?: string }
  ) => Promise<boolean>;
  runMigrate: (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined,
    // ISS-4392: optional telemetry hooks; 3-arg mocks stay assignable.
    hooks?: RunMigrateHooks,
    // ISS-6403: the Prisma CLI spawn options for THIS run; 4-arg mocks stay
    // assignable.
    cli?: PrismaCliOptions,
    // Omission uses retention-aware policy; ordinary previews retain Remigrate.
    previewReset?: PreviewResetMode
  ) => Promise<boolean>;
  // Resolves on a complete clone; rejects with a `CloneFailedError` carrying the
  // cause when it failed, which fails the run (ISS-11785, ISS-11867).
  cloneDataFromPublic: (databaseUrl: string, schema: string) => Promise<void>;
  // ISS-11785: drops a preview schema whose clone failed, so the next deploy
  // creates it anew instead of finding it empty and at head.
  dropSchema: (databaseUrl: string, schema: string | null) => Promise<void>;
  runPreviewSeed: (databaseUrl: string, schema: string | null) => void;
  // ISS-12056: the schema-comment marker that makes a preview a vibe environment.
  readVibeEnvironmentMarker: (
    databaseUrl: string,
    schema: string | null
  ) => Promise<VibeEnvironmentMarker | null>;
  writeVibeEnvironmentMarker: (
    databaseUrl: string,
    schema: string,
    marker: VibeEnvironmentMarker
  ) => Promise<void>;
  readIncompletePreviewBuild: typeof readIncompletePreviewBuild;
  clearIncompletePreviewBuild: typeof clearIncompletePreviewBuild;
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
  replayPendingMigrationsViaSql: (databaseUrl, schema, readers) =>
    replayPendingMigrationsViaSql(databaseUrl, schema, readers),
  plainBuildPreviewConcurrentIndexes,
  sweepInvalidIndexes,
  // Adapter so the telemetry `hooks` (4th dep arg) map to runMigrateWithRetry's
  // 5th arg without displacing its `recoveryUpsert` default (4th arg).
  runMigrate: (databaseUrl, schema, branch, hooks, cli, previewReset) =>
    runMigrateWithRetry(
      databaseUrl,
      schema,
      branch,
      undefined,
      hooks,
      cli,
      previewReset
    ),
  cloneDataFromPublic,
  dropSchema,
  runPreviewSeed,
  readVibeEnvironmentMarker: (databaseUrl, schema) =>
    readVibeEnvironmentMarker(databaseUrl, schema),
  writeVibeEnvironmentMarker: (databaseUrl, schema, marker) =>
    writeVibeEnvironmentMarker(databaseUrl, schema, marker),
  readIncompletePreviewBuild,
  clearIncompletePreviewBuild,
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
 * Returns `didReset` plus `invalidIndexes` from the ISS-4601 post-deploy sweep
 * (`null` = sweep did not run). A failed clone throws (ISS-11785).
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
    /**
     * ISS-12056: the schema carries a vibe environment marker, so it is never
     * cloned from `public`. The caller reads the marker under the build lock.
     */
    vibeEnvironment?: boolean;
    /** Only the explicit mode-request builder sets this after recreating the schema. */
    vibeEnvironmentRebuilt?: boolean;
  },
  overrides: Partial<MigrationPipelineDeps> = {}
): Promise<{
  didReset: boolean;
  invalidIndexes: InvalidIndex[] | null;
}> {
  const deps = { ...DEFAULT_PIPELINE_DEPS, ...overrides };
  const { isNew } = opts;
  const vibeEnvironment = opts.vibeEnvironment ?? false;
  const serializeMode = opts.serializeMode ?? "run";
  const cloneFirst = isCloneFirstSchema(schema, branch) && !vibeEnvironment;

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
  const emptySchemaContext = schema && {
    databaseUrl,
    schema,
    branch,
    deps,
    readers,
    recorder,
    serializeMode,
    serializeBudgetMs: opts.serializeBudgetMs,
    postCloneUrl: () =>
      refreshedOrOriginalUrl(databaseUrl, deps.refreshDatabaseUrl),
    vibeEnvironment,
  };

  try {
    await assertExistingPreviewBuildComplete(
      databaseUrl,
      schema,
      branch,
      isNew,
      deps
    );
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
    // run in runMigrationPipeline; the clone runs outside it).
    //
    // `didReset` stays false when the at-head probe skipped the migrate: no reset
    // happened, so no clone runs (the existing preview keeps its data). An empty
    // clone-first preview skips this block; `populateEmptySchema` migrates it.
    let didReset = false;
    if (!(previewAtHead || (cloneFirst && isNew))) {
      // ISS-5952: ownership preflight BEFORE the gate and before any DDL. For a
      // non-preview schema with foreign-owned tables AND pending migrations this
      // throws — a clean pre-DDL failure instead of a mid-file 42501 partial
      // commit. Outside the serialize gate on purpose: it is one read-only
      // catalog query and must not extend the lock hold. No-op for previews.
      await deps.assertMigrateRoleOwnsSchema(databaseUrl, schema, readers);
      // ISS-8039: the gate FAILS OPEN by default (`onContended: "run"`), so the
      // callback below can run with no serialize lock held. `migrate deploy`
      // survives that because Prisma takes its OWN per-database migration lock
      // (72707369) underneath; the direct SQL replay takes no lock at all, so on
      // a fail-open it must not run — see where this is read below.
      let gateOutcome: SerializeLockOutcome | null = null;
      didReset = await deps.withMigrationSerializeLock(
        {
          databaseUrl,
          onContended: serializeMode,
          budgetMs: opts.serializeBudgetMs,
          onOutcome: (outcome, waitMs) => {
            gateOutcome = outcome;
            recorder.setGate(outcome, waitMs);
          },
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
            // ISS-8039: a schema created in THIS run has no history worth
            // preserving and no data to protect, so its migrations are applied
            // over one connection rather than through 344 CLI round trips.
            // Bracketed by the same telemetry marks, so `migrate_ms` stays
            // comparable across both paths; `migrate_executor` is what tells
            // them apart afterwards. Fail-open: `false` falls through to the CLI.
            //
            // REQUIRES THE GATE TO HAVE BEEN ACQUIRED. Two first deployments of
            // one preview otherwise replay the same DDL and history rows into
            // the same schema concurrently, and one of them then falls into the
            // CLI/reset path while the other is still building it. `migrate
            // deploy` is safe on that path only because Prisma's own migration
            // lock serializes it underneath; this replay holds no lock, so on a
            // fail-open it declines and leaves the CLI to run instead.
            if (
              isNew &&
              gateOutcome === MigrateGateOutcome.Acquired &&
              (await deps.replayPendingMigrationsViaSql(
                databaseUrl,
                schema,
                readers
              ))
            ) {
              recorder.setMigrateExecutor(MigrateExecutor.SqlReplay);
              return false;
            }
            recorder.setMigrateExecutor(MigrateExecutor.PrismaCli);
            const reset = await deps.runMigrate(
              databaseUrl,
              schema,
              branch,
              {
                onAttempts: (attempt) => recorder.setAttempts(attempt),
                onResetKind: (kind) => recorder.setResetKind(kind),
              },
              deps.prismaCli,
              selectPreviewResetMode({
                schema,
                branch,
                cloneFirst,
                isNew,
                vibeEnvironmentRebuilt: opts.vibeEnvironmentRebuilt,
              })
            );
            if (reset && cloneFirst && emptySchemaContext) {
              await replayResetSchema(emptySchemaContext, gateOutcome);
            }
            return reset;
          } finally {
            // Capture migrate_ms even when the migrate throws — the P1002/failed
            // cohort is exactly what this telemetry exists to analyze.
            recorder.markMigrateDone();
          }
        }
      );
    }

    if ((isNew || didReset) && emptySchemaContext) {
      await populateEmptySchema(emptySchemaContext, didReset);
    }

    // ISS-4437: plain-build the CONCURRENTLY correctness indexes a preview needs
    // (FEA-3857's search_document unique upsert key + its perf indexes), which the
    // prestamp above skipped. OUTSIDE the serialize gate (raw pg, no Prisma lock).
    //
    // AFTER the clone (not before): if this throws after a fresh/reset migrate, the
    // clone has already persisted, so an ordinary preview retry at head keeps its
    // data and rebuilds the index. Retained incomplete candidates require explicit
    // rebuild instead (ISS-12135).
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

    await completePreviewBuild(postCloneUrl, schema, branch, isNew, deps);
    return { didReset, invalidIndexes };
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
 *
 * ISS-12056: `request.vibeEnvironment` builds the schema as an empty vibe
 * environment of that mode (`vibe-environment-build.ts`); the result reports
 * the schema's marker and whether it was rebuilt.
 */
export async function runMigrationPipeline(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  overrides: Partial<MigrationPipelineDeps> = {},
  request: { vibeEnvironment?: VibeEnvironmentMode } = {}
): Promise<{
  invalidIndexes: InvalidIndex[] | null;
  vibeEnvironment: VibeEnvironmentMarker | null;
  rebuilt: boolean;
}> {
  const deps = { ...DEFAULT_PIPELINE_DEPS, ...overrides };

  // ISS-11785: the build lock covers the ensure, so a run that finds the schema
  // already created waits until the run that created it has built it.
  const { invalidIndexes, vibeEnvironment, rebuilt } =
    await withPreviewBuildLock(
      deps.withMigrationSerializeLock,
      { databaseUrl, schema, branch },
      async () => {
        console.log("↪ Ensuring schema exists...");
        const built = await ensureSchemaForBuild(
          deps,
          databaseUrl,
          schema,
          request.vibeEnvironment
        );
        const { isNew } = built;
        /**
         * Ordering invariant: ensureSchemaExists → upsertSchemaRegistry → runMigrate → cloneDataFromPublic.
         * ensureSchemaExists must run first so the schema row exists before we write the registry entry.
         * upsertSchemaRegistry must complete before runMigrate so that any mid-migration failure
         * leaves a registered (reapable) orphan rather than a silent unregistered one.
         * If all retries are exhausted, runMigrationPipeline throws, the deploy fails loudly, and the
         * schema created by ensureSchemaExists is left unregistered. FEA-1082 reaps ordinary
         * orphans; ISS-12135 retains vibe-prefix candidates until explicit cleanup.
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
        const applied = await applyMigrationsToSchema(
          databaseUrl,
          schema,
          branch,
          {
            isNew,
            serializeMode: "run",
            vibeEnvironment: built.vibeEnvironment !== null,
            vibeEnvironmentRebuilt:
              request.vibeEnvironment !== undefined && built.rebuilt,
          },
          overrides
        );
        return {
          invalidIndexes: applied.invalidIndexes,
          vibeEnvironment: built.vibeEnvironment,
          rebuilt: built.rebuilt,
        };
      }
    );

  // Seed preview schemas with synthetic data (FEA-1715). Intentionally OUTSIDE
  // the (isNew || didReset) gate above: the seed is idempotent and non-blocking,
  // so running it after every successful migration makes a prior non-blocking
  // seed failure recoverable on the next deploy (review: davetho). No-op for
  // non-preview schemas.
  //
  // ISS-5285: the seed spawns a subprocess whose DATABASE_URL is built from the
  // URL passed here, so it needs the same post-clone re-mint the index build
  // gets. No-op when the dep is absent.
  //
  // ISS-12056: never into a vibe environment, which is seeded by its own
  // workflow or deliberately left blank.
  if (vibeEnvironment === null) {
    const seedUrl = await refreshedOrOriginalUrl(
      databaseUrl,
      deps.refreshDatabaseUrl
    );
    deps.runPreviewSeed(seedUrl, schema);
  }

  return { invalidIndexes, vibeEnvironment, rebuilt };
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

/** ISS-12135: retained partial clones cannot take the at-head success shortcut. */
async function assertExistingPreviewBuildComplete(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  isNew: boolean,
  deps: MigrationPipelineDeps
): Promise<void> {
  if (
    isNew ||
    !schema ||
    !isPreviewSchema(schema) ||
    !isVibeEnvironmentSchema(schema, branch)
  ) {
    return;
  }
  if (await deps.readIncompletePreviewBuild(databaseUrl, schema)) {
    throw new CloneFailedError(schema, new Error(PreviewBuildState.Incomplete));
  }
}

/** Completion is durable only after clone, branch migration and correctness indexes succeed. */
async function completePreviewBuild(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined,
  isNew: boolean,
  deps: MigrationPipelineDeps
): Promise<void> {
  if (
    schema &&
    isPreviewSchema(schema) &&
    isVibeEnvironmentSchema(schema, undefined) &&
    (isNew || !isVibeEnvironmentSchema(schema, branch))
  ) {
    await deps.clearIncompletePreviewBuild(databaseUrl, schema);
  }
}
