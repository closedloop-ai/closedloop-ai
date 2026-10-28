import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import type { PrismaClient } from "../../generated/client";
import { isLocalhostUrl, resolveSslOption } from "../db-utils";
import {
  applyBootstrapTarget,
  type BootstrapResult,
  ensureBootstrapUser,
} from "./bootstrap";
import { evaluateSeedGuards, parseSeedCliArgs } from "./cli";
import { resolveSeedConnectionTarget } from "./connection-target";
import {
  detectOrgConflicts,
  SeedOrgPreflightStatus,
} from "./non-empty-org-guard";
import { resolveSeedRunPlan } from "./profiles";
import {
  collectResetVerificationSnapshot,
  countResettableOrgRows,
  formatResetSummary,
  resetOrgData,
  SeedResetFailureReason,
  verifyResetComplete,
} from "./reset";
import { confirmResetIfNeeded } from "./reset-confirmation";
import { assertEffectiveSchema } from "./schema-guard";
import { resolveAuditMode, resolveSeedTarget } from "./target-resolution";

/**
 * ISS-6804: the seed as a FUNCTION. `scripts/seed.ts` used to be one `main()`
 * that read `process.argv`/`process.env` and called `process.exit`, which is
 * fine for `pnpm --filter=@repo/database seed` and unusable anywhere else — the
 * preview pipeline's `runPreviewSeed` spawns that CLI through `pnpm`, and a
 * Vercel function has no `pnpm`, so previews bootstrapped through the ensure
 * route (ISS-6802) come back without the FEA-1715 Seed Sandbox.
 *
 * Everything the CLI did is here, taking `argv` and `env` as ARGUMENTS and
 * returning an exit code instead of exiting. The CLI is a thin wrapper; the
 * `/preview-schemas/seed` route calls this in-process with the same argv and an
 * env it composes itself, so no process-global is read or written for one
 * request's sake (the same discipline as ISS-6403 Finding 5).
 */

export type SeedProgramSummary = {
  organizationId: string;
  userId: string;
  elapsedMs: number;
};

export type SeedProgramResult = {
  /** 0 on success or `--help`; 1 on any guard, preflight, or seeding failure. */
  exitCode: 0 | 1;
  summary?: SeedProgramSummary;
  /** Present when `exitCode` is 1: the same text the CLI would have printed. */
  error?: string;
};

export type SeedProgramOptions = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Replaces the local-part of an email and any host-shaped string with a
 * deterministic redaction marker. Keeps the domain so log lines still
 * communicate "which env" without leaking the principal.
 */
function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    return "<redacted>";
  }
  return `<redacted>${email.slice(at)}`;
}

/**
 * Never rejects: a failure anywhere — argument parsing, a guard, building the
 * client, the seed itself — comes back as `exitCode: 1` with its message, the
 * way the CLI would have printed it and exited. Callers that want an exception
 * have `error` to throw.
 */
export async function runSeedProgram(
  options: SeedProgramOptions
): Promise<SeedProgramResult> {
  const logger = options.logger ?? console;
  try {
    return await executeSeedProgram({ ...options, logger });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Seed failed: ${message}`);
    return { exitCode: 1, error: message };
  }
}

async function executeSeedProgram({
  argv,
  env,
  logger = console,
}: SeedProgramOptions): Promise<SeedProgramResult> {
  const startedAt = Date.now();
  const cliResult = parseSeedCliArgs([...argv]);
  if (!cliResult.ok) {
    if (cliResult.helpText) {
      logger.log(cliResult.helpText);
    }
    if (cliResult.reason === "help_requested") {
      return { exitCode: 0 };
    }
    const error = `[seed] ERROR ${cliResult.reason}: ${cliResult.message}`;
    logger.error(error);
    return { exitCode: 1, error };
  }

  for (const warning of cliResult.warnings) {
    logger.warn(`[seed] WARN: ${warning}`);
  }

  const guardResult = evaluateSeedGuards({
    profile: cliResult.options.profile,
    allowSharedStage: cliResult.options.allowSharedStage,
    databaseUrl: env.DATABASE_URL,
    pgHost: env.PGHOST,
    stagePgHost: env.STAGE_PGHOST,
    seedAllowRemote: env.SEED_ALLOW_REMOTE,
    resetRequested: cliResult.options.reset.requested,
    seedResetAllowRemote: env.SEED_RESET_ALLOW_REMOTE,
  });
  if (!guardResult.ok) {
    const error = `[seed] ERROR ${guardResult.reason}: ${guardResult.message}`;
    logger.error(error);
    return { exitCode: 1, error };
  }

  // Load the seed phase graph now — after CLI parsing and the production guards
  // have passed, but BEFORE any DB connection, destructive reset, or seeding.
  // Loading it here (not after the reset block) ensures a module-load failure
  // cannot occur AFTER a destructive `--reset` has wiped the target org but
  // before it is reseeded.
  const { runSeed } = await import("./index");
  const { seedCuratedCatalogItems } = await import("./curated-catalog");

  const url = guardResult.url;
  const urlForLocalhostCheck = new URL(url.toString());
  urlForLocalhostCheck.hostname = guardResult.targetHost.toLowerCase();
  const isLocalhost = isLocalhostUrl(urlForLocalhostCheck);

  logger.log(
    `[seed] Initializing PrismaClient for profile=${cliResult.options.profile} targetHostSource=${guardResult.targetHostSource}...`
  );

  const { prisma, pool, targetSchema } = await createSeedPrisma(
    url,
    isLocalhost,
    env
  );

  try {
    // Safety: refuse to seed if the connection does not resolve to the intended
    // schema (e.g. a search_path mishap that would write into `public` on the
    // shared RDS). Runs before any write.
    await assertEffectiveSchema(prisma, targetSchema);

    let bootstrapResult: BootstrapResult | undefined;
    if (cliResult.options.bootstrapUser) {
      logger.log(
        "[seed] Bootstrapping synthetic user/org (preview precondition)..."
      );
      bootstrapResult = await ensureBootstrapUser(prisma, env);
    }

    logger.log("[seed] Resolving user and organization from database...");

    // Explicit CLI target wins; otherwise seed INTO the synthetic bootstrap
    // identity (not the legacy oldest-user lookup, which could pick a different
    // pre-existing org in a stale schema).
    const effectiveTarget = applyBootstrapTarget(
      cliResult.options.target,
      bootstrapResult
    );
    const target = await resolveSeedTarget(prisma, {
      resetRequested: cliResult.options.reset.requested,
      organizationId: effectiveTarget.organizationId,
      userId: effectiveTarget.userId,
    });

    // Audit log: do NOT print live user emails or organization names/slugs.
    // CI logs, shared terminals, and incident artifacts retain stdout — and
    // PLN-664 / PRD-153 require synthetic-only data with no real PII. We
    // print just the org/user UUIDs (which are not credentials) and an
    // email-domain redaction so the operator can still confirm "which env".
    logger.log(`[seed] Resolved organization: ${target.organizationId}`);
    logger.log(
      `[seed] Resolved user: ${target.userId} (${redactEmail(target.userEmail)})`
    );

    const context = {
      organizationId: target.organizationId,
      userId: target.userId,
    };

    // ---------------------------------------------------------------------------
    // Preflight: refuse to seed into an org that already has substantive data.
    //
    // The seed uses deterministic IDs as the upsert idempotency key, but the
    // underlying schema enforces several global / per-org unique constraints
    // (GitHubInstallation.installationId, LinearIntegration.organizationId,
    // SlackIntegration.organizationId, all `(organizationId, slug)` pairs,
    // ...). If a real org already has any of those rows with non-seed
    // identifiers, the seed's `create` block would either fail loudly with
    // a unique-constraint violation OR partially mutate real integration
    // metadata while preserving real secrets — both unacceptable.
    //
    // Fail closed here. Set `SEED_FORCE_OVERWRITE=1` to opt into seeding
    // against a non-empty org; that is intended for staging restoration
    // workflows where the operator has accepted the risk of clobbering
    // existing data. Per PR review comment #3.
    // ---------------------------------------------------------------------------
    const forceOverwrite = env.SEED_FORCE_OVERWRITE === "1";
    const { conflicts, seedOwnedRows, status } = cliResult.options.reset
      .requested
      ? {
          conflicts: [],
          seedOwnedRows: [],
          status: SeedOrgPreflightStatus.Clean,
        }
      : await detectOrgConflicts(prisma, target.organizationId);

    const auditMode = resolveAuditMode({
      conflicts,
      status,
      forceOverwrite,
    });

    if (conflicts.length > 0 && !forceOverwrite) {
      throw new Error(
        `Refusing to seed: organization ${target.organizationId} already has data:\n` +
          conflicts.map((c) => `   - ${c}`).join("\n") +
          "\n\n" +
          "The seed assumes a near-empty organization (Organization + User row, nothing else).\n" +
          "Running against a non-empty org risks unique-constraint failures and unintended\n" +
          "mutation of real integration metadata.\n\n" +
          "Set SEED_FORCE_OVERWRITE=1 to override — only do this on a disposable database\n" +
          "(staging restore, preview env) where you accept the risk of clobbering data."
      );
    }

    const plan = resolveSeedRunPlan({
      profile: cliResult.options.profile,
      multiplier: cliResult.options.multiplier,
      rngSeed: cliResult.options.rngSeed,
      allowSharedStage: cliResult.options.allowSharedStage,
      auditMode,
      orgPreflight: { conflicts },
      target: {
        organizationId: target.organizationId,
        userId: target.userId,
        source: target.source,
      },
      reset: cliResult.options.reset,
    });

    if (conflicts.length > 0) {
      logger.warn(
        "⚠️  Seeding into non-empty org (SEED_FORCE_OVERWRITE=1 set). Existing rows:\n" +
          conflicts.map((c) => `    - ${c}`).join("\n")
      );
    } else if (seedOwnedRows.length > 0) {
      logger.log(
        "[seed] Existing deterministic seed-owned rows detected; rerunning idempotently."
      );
    }

    if (cliResult.options.reset.requested) {
      const preResetSnapshot = await collectResetVerificationSnapshot(
        prisma,
        target.organizationId
      );
      const preResetSummary = await countResettableOrgRows(
        prisma,
        target.organizationId,
        preResetSnapshot
      );
      await confirmResetIfNeeded({
        force: cliResult.options.reset.force,
        organizationId: target.organizationId,
        userId: target.userId,
        targetSource: target.source,
        profile: cliResult.options.profile,
        totalRows: preResetSummary.totalRows,
      });
      const resetSummary = await resetOrgData(
        prisma,
        target.organizationId,
        plan.profile
      );
      const verification = await verifyResetComplete(
        prisma,
        target.organizationId,
        preResetSnapshot
      );
      if (!verification.ok) {
        throw new Error(
          `${SeedResetFailureReason.ResetVerificationFailed}: ${verification.remaining
            .map(({ name, count }) => `${name}=${count}`)
            .join(", ")}`
        );
      }
      for (const line of formatResetSummary(resetSummary)) {
        logger.log(line);
      }
    }

    // Seed global/curated items first (organizationId IS NULL, never org-reset).
    // T-22.4: registers the bundled Token Coach as a curated CatalogItem.
    await seedCuratedCatalogItems(prisma);

    await runSeed(prisma, context, plan);

    const elapsedMs = Date.now() - startedAt;
    logger.log(
      `[seed] Summary: seeded data for organizationId=${target.organizationId} userId=${target.userId}`
    );
    logger.log(`[seed] Elapsed time: ${elapsedMs}ms`);
    return {
      exitCode: 0,
      summary: {
        organizationId: target.organizationId,
        userId: target.userId,
        elapsedMs,
      },
    };
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

/**
 * Builds the seed's PrismaClient with explicit schema targeting and returns the
 * pool so the caller can close it.
 *
 * Resolves the target schema (from the DSN `?schema=`, which libpq ignores, or
 * PGSCHEMA / Vercel preview resolution) and applies it BOTH as a pool
 * `search_path` and as the PrismaPg schema — mirroring index.ts getPool() — so
 * writes land in the intended (preview) schema rather than `public`.
 *
 * The generated client is imported lazily here (not statically at the top): a
 * top-level value import would load the build-fragile generated client at
 * process startup, before any guard runs, crashing with MODULE_NOT_FOUND
 * instead of the intended rejection (the 2026-06-05 api-stage failure). The
 * type-only import at the top still provides the PrismaClient type.
 */
async function createSeedPrisma(
  url: URL,
  isLocalhost: boolean,
  env: NodeJS.ProcessEnv
): Promise<{
  prisma: PrismaClient;
  pool: pg.Pool;
  targetSchema: string | null;
}> {
  const { PrismaClient } = await import("../../generated/client");

  // Reads sslmode/schema and strips them from the URL; see
  // scripts/seed/connection-target.ts for the resolution order and why the
  // empty-schema fall-through is `||` and not `??`.
  const { sslmode, targetSchema, searchPath } = resolveSeedConnectionTarget(
    url,
    {
      pgSchema: env.PGSCHEMA,
      vercelEnv: env.VERCEL_ENV,
      vercelGitCommitRef: env.VERCEL_GIT_COMMIT_REF,
    }
  );

  const ssl = resolveSslOption({
    isLocalhost,
    sslmode,
    allowInsecure: env.ALLOW_INSECURE_SSL === "1",
  });

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: SEED_POOL_MAX_CONNECTIONS,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });

  const adapter = new PrismaPg(
    pool,
    targetSchema ? { schema: targetSchema } : undefined
  );
  const prisma = new PrismaClient({ adapter });

  return { prisma, pool, targetSchema };
}

/**
 * Connection cap for one seed run. pg's default `max` is 10, so several
 * concurrent seeds against the shared stage instance could hold 10 connections
 * each — the starvation ISS-6804's admission gate bounds from the other side
 * (review: davetho). The seed's phases run sequentially, so a small pool only
 * queues within a run; it does not slow one down.
 */
const SEED_POOL_MAX_CONNECTIONS = 4;
