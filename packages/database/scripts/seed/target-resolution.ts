import type { PrismaClient } from "../../generated/client";
import { SeedOrgPreflightStatus } from "./non-empty-org-guard";
import { SeedAuditMode } from "./profiles";
import { SeedResetFailureReason } from "./reset";

/**
 * Resolves WHICH organization and user a seed run targets, and which audit mode
 * the run is recorded under.
 *
 * Extracted from `scripts/seed.ts` for the same reason
 * `non-empty-org-guard.ts` and `connection-target.ts` were: `seed.ts` is a CLI
 * entry point with no exports, so this logic could only be reached by running
 * the whole CLI. Every function here already took `prisma` as a parameter, so
 * the move is a relocation rather than a redesign — `seed.ts` still owns the
 * CLI, the guards, and client construction.
 *
 * The ambiguity refusals are the point. When no explicit `--organization-id` /
 * `--user-id` is given, the run infers the target — and an inference that
 * silently picked the first of several organizations could seed (or, with
 * `--reset`, WIPE) the wrong one. Both resolvers therefore read `take: 2` and
 * refuse when a second row exists, rather than ordering and taking the first.
 */

export type ResolvedSeedTarget = {
  organizationId: string;
  userId: string;
  userEmail: string;
  source: "legacy-default" | "explicit-flags" | "inferred";
};

export async function resolveSeedTarget(
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

export async function resolveLegacySeedTarget(
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

export async function resolveOnlyOrganization(
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

export function resolveAuditMode({
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

export async function resolveOnlyUser(
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
