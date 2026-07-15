#!/usr/bin/env node

/**
 * CLI entry point for the database seed script.
 *
 * Initializes a PrismaClient via DATABASE_URL, resolves an authenticated user
 * and their organization from the database, invokes runSeed(), logs a summary,
 * and disconnects the client.
 *
 * Usage:
 *   DATABASE_URL=<url> pnpm --filter=@repo/database seed
 *
 * Environment variables inspected at startup:
 *   DATABASE_URL      — required; the pg connection string. Seeding is
 *                       restricted to localhost targets by default. Set
 *                       SEED_ALLOW_REMOTE=1 to enable staging/preview runs;
 *                       production hostnames are always rejected regardless.
 *   SEED_ALLOW_REMOTE — set to "1" to allow non-localhost DATABASE_URL
 *                       (staging, preview). Production denylist still applies.
 *   SEED_RESET_ALLOW_REMOTE — set to "1" to allow destructive --reset against a
 *                          non-localhost DATABASE_URL. SEED_ALLOW_REMOTE alone
 *                          is NOT sufficient because --reset --force skips the
 *                          only interactive confirmation. Production denylist
 *                          still applies.
 *   SEED_FORCE_OVERWRITE — set to "1" to seed into a non-empty org (staging
 *                          restore). Risks clobbering existing integration rows.
 *   ALLOW_INSECURE_SSL — set to "1" to skip TLS certificate verification for
 *                        self-signed dev/RDS endpoints. Default: verify.
 *
 * Full production-guard tracking: FEA-1328.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import type { PrismaClient } from "../generated/client";
import {
  formatSearchPath,
  normalizeExplicitSchemaName,
  resolveSchemaName,
} from "../schema-utils";
import { isLocalhostUrl, resolveSslOption } from "./db-utils";
import {
  applyBootstrapTarget,
  type BootstrapResult,
  ensureBootstrapUser,
} from "./seed/bootstrap";
import { evaluateSeedGuards, parseSeedCliArgs } from "./seed/cli";
import {
  detectOrgConflicts,
  SeedOrgPreflightStatus,
} from "./seed/non-empty-org-guard";
import { resolveSeedRunPlan, SeedAuditMode } from "./seed/profiles";
import {
  collectResetVerificationSnapshot,
  countResettableOrgRows,
  formatResetSummary,
  resetOrgData,
  SeedResetFailureReason,
  verifyResetComplete,
} from "./seed/reset";
import { confirmResetIfNeeded } from "./seed/reset-confirmation";
import { assertEffectiveSchema } from "./seed/schema-guard";

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

async function main() {
  const startedAt = Date.now();
  const cliResult = parseSeedCliArgs(process.argv.slice(2));
  if (!cliResult.ok) {
    if (cliResult.helpText) {
      console.log(cliResult.helpText);
    }
    if (cliResult.reason === "help_requested") {
      process.exit(0);
    }
    console.error(`[seed] ERROR ${cliResult.reason}: ${cliResult.message}`);
    process.exit(1);
  }

  for (const warning of cliResult.warnings) {
    console.warn(`[seed] WARN: ${warning}`);
  }

  const guardResult = evaluateSeedGuards({
    profile: cliResult.options.profile,
    allowSharedStage: cliResult.options.allowSharedStage,
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    stagePgHost: process.env.STAGE_PGHOST,
    seedAllowRemote: process.env.SEED_ALLOW_REMOTE,
    resetRequested: cliResult.options.reset.requested,
    seedResetAllowRemote: process.env.SEED_RESET_ALLOW_REMOTE,
  });
  if (!guardResult.ok) {
    console.error(`[seed] ERROR ${guardResult.reason}: ${guardResult.message}`);
    process.exit(1);
  }

  // Load the seed phase graph now — after CLI parsing and the production guards
  // have passed, but BEFORE any DB connection, destructive reset, or seeding.
  // Loading it here (not after the reset block) ensures a module-load failure
  // cannot occur AFTER a destructive `--reset` has wiped the target org but
  // before it is reseeded.
  const { runSeed } = await import("./seed/index");
  const { seedCuratedCatalogItems } = await import("./seed/curated-catalog");

  const url = guardResult.url;
  const urlForLocalhostCheck = new URL(url.toString());
  urlForLocalhostCheck.hostname = guardResult.targetHost.toLowerCase();
  const isLocalhost = isLocalhostUrl(urlForLocalhostCheck);

  console.log(
    `[seed] Initializing PrismaClient for profile=${cliResult.options.profile} targetHostSource=${guardResult.targetHostSource}...`
  );

  const { prisma, pool, targetSchema } = await createSeedPrisma(
    url,
    isLocalhost
  );

  try {
    // Safety: refuse to seed if the connection does not resolve to the intended
    // schema (e.g. a search_path mishap that would write into `public` on the
    // shared RDS). Runs before any write.
    await assertEffectiveSchema(prisma, targetSchema);

    let bootstrapResult: BootstrapResult | undefined;
    if (cliResult.options.bootstrapUser) {
      console.log(
        "[seed] Bootstrapping synthetic user/org (preview precondition)..."
      );
      bootstrapResult = await ensureBootstrapUser(prisma);
    }

    console.log("[seed] Resolving user and organization from database...");

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
    console.log(`[seed] Resolved organization: ${target.organizationId}`);
    console.log(
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
      forceOverwrite: process.env.SEED_FORCE_OVERWRITE === "1",
    });

    if (conflicts.length > 0 && process.env.SEED_FORCE_OVERWRITE !== "1") {
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
      console.warn(
        "⚠️  Seeding into non-empty org (SEED_FORCE_OVERWRITE=1 set). Existing rows:\n" +
          conflicts.map((c) => `    - ${c}`).join("\n")
      );
    } else if (seedOwnedRows.length > 0) {
      console.log(
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
        console.log(line);
      }
    }

    // Seed global/curated items first (organizationId IS NULL, never org-reset).
    // T-22.4: registers the bundled Token Coach as a curated CatalogItem.
    await seedCuratedCatalogItems(prisma);

    await runSeed(prisma, context, plan);

    console.log(
      `[seed] Summary: seeded data for organizationId=${target.organizationId} userId=${target.userId}`
    );
    console.log(`[seed] Elapsed time: ${Date.now() - startedAt}ms`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "❌ Seed failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

type ResolvedSeedTarget = {
  organizationId: string;
  userId: string;
  userEmail: string;
  source: "legacy-default" | "explicit-flags" | "inferred";
};

async function resolveSeedTarget(
  prisma: PrismaClient,
  options: {
    resetRequested: boolean;
    organizationId?: string;
    userId?: string;
  }
): Promise<ResolvedSeedTarget> {
  const hasExplicitTarget = Boolean(options.organizationId || options.userId);
  if (!(options.resetRequested || hasExplicitTarget)) {
    return resolveLegacySeedTarget(prisma);
  }

  const organization = options.organizationId
    ? await prisma.organization.findUnique({
        where: { id: options.organizationId },
        select: { id: true },
      })
    : await resolveOnlyOrganization(prisma);
  if (!organization) {
    throw new Error(
      `${SeedResetFailureReason.ResetTargetNotFound}: target organization was not found.`
    );
  }

  const user = options.userId
    ? await prisma.user.findFirst({
        where: { id: options.userId, organizationId: organization.id },
        select: { id: true, organizationId: true, email: true },
      })
    : await resolveOnlyUser(prisma, organization.id);
  if (!user) {
    throw new Error(
      `${SeedResetFailureReason.ResetUserNotInOrg}: target user was not found in the target organization.`
    );
  }

  return {
    organizationId: organization.id,
    userId: user.id,
    userEmail: user.email,
    source: hasExplicitTarget ? "explicit-flags" : "inferred",
  };
}

async function resolveLegacySeedTarget(
  prisma: PrismaClient
): Promise<ResolvedSeedTarget> {
  const user = await prisma.user.findFirst({
    select: {
      id: true,
      organizationId: true,
      email: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!user) {
    throw new Error(
      "No users found in the database. Ensure at least one user exists before seeding."
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { id: true },
  });

  if (!organization) {
    throw new Error(
      `Organization not found for resolved user (organizationId=${user.organizationId})`
    );
  }

  return {
    organizationId: organization.id,
    userId: user.id,
    userEmail: user.email,
    source: "legacy-default",
  };
}

async function resolveOnlyOrganization(
  prisma: PrismaClient
): Promise<{ id: string } | null> {
  const organizations = await prisma.organization.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (organizations.length > 1) {
    throw new Error(
      `${SeedResetFailureReason.ResetTargetAmbiguous}: multiple organizations exist; pass --organization-id.`
    );
  }
  return organizations[0] ?? null;
}

function resolveAuditMode({
  conflicts,
  status,
  forceOverwrite,
}: {
  conflicts: readonly string[];
  status: SeedOrgPreflightStatus;
  forceOverwrite: boolean;
}): SeedAuditMode {
  if (conflicts.length > 0 && forceOverwrite) {
    return SeedAuditMode.ForceOverwriteNonEmpty;
  }
  if (status === SeedOrgPreflightStatus.SeedOwned) {
    return SeedAuditMode.IdempotentSeedOrg;
  }
  return SeedAuditMode.CleanOrg;
}

async function resolveOnlyUser(
  prisma: PrismaClient,
  organizationId: string
): Promise<{ id: string; email: string } | null> {
  const users = await prisma.user.findMany({
    where: { organizationId },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (users.length > 1) {
    throw new Error(
      `${SeedResetFailureReason.ResetUserAmbiguous}: multiple users exist in the target organization; pass --user-id.`
    );
  }
  return users[0] ?? null;
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
  isLocalhost: boolean
): Promise<{
  prisma: PrismaClient;
  pool: pg.Pool;
  targetSchema: string | null;
}> {
  const { PrismaClient } = await import("../generated/client");

  // Honor the caller's `sslmode` before stripping it off the URL (explicit ssl
  // config is provided to the Pool instead).
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  const rawUrlSchema = url.searchParams.get("schema");
  const targetSchema =
    // Normalize the DSN `?schema=` the same way PGSCHEMA is (via
    // resolveSchemaName → normalizeExplicitSchemaName), so a mixed-case or
    // special-char value can't produce a quoted search_path identifier that
    // mismatches the lowercased schema (a false-positive guard abort).
    // `||` (not `??`): an explicit empty/blank `?schema=` normalizes to "" and
    // falls through to env resolution — otherwise targetSchema="" would disable
    // both the search_path and the schema guard, routing writes to `public`.
    (rawUrlSchema ? normalizeExplicitSchemaName(rawUrlSchema) : "") ||
    resolveSchemaName({
      pgSchema: process.env.PGSCHEMA,
      vercelEnv: process.env.VERCEL_ENV,
      vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
    });
  url.searchParams.delete("schema");
  const searchPath =
    targetSchema && targetSchema.length > 0
      ? formatSearchPath(targetSchema)
      : null;

  const ssl = resolveSslOption({
    isLocalhost,
    sslmode,
    allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
  });

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
  });

  const adapter = new PrismaPg(
    pool,
    targetSchema ? { schema: targetSchema } : undefined
  );
  const prisma = new PrismaClient({ adapter });

  return { prisma, pool, targetSchema };
}
