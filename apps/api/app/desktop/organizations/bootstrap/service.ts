import "server-only";

import type { DesktopBootstrapOrganizationHttpRequest } from "@repo/api/src/types/desktop-bootstrap";
import { Result } from "@repo/api/src/types/result";
import { verifyDesktopBootstrapToken } from "@repo/auth/desktop-bootstrap-jwt";
import { withDb } from "@repo/database";
import {
  type DesktopSessionTokens,
  issueDesktopSessionCredentials,
} from "@/app/desktop/session/service";
import { organizationsService } from "@/app/organizations/service";
import { clerkService } from "@/lib/auth/clerk-service";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { desktopBootstrapLogoService } from "./logo-service";

type BootstrapOrganizationError =
  | "invalid"
  | "already_used"
  | "organization_exists";

export const desktopBootstrapOrganizationService = {
  async create(
    input: DesktopBootstrapOrganizationHttpRequest & {
      bootstrapToken: string;
      now?: Date;
    }
  ): Promise<Result<DesktopSessionTokens, BootstrapOrganizationError>> {
    const claims = await verifyDesktopBootstrapToken(
      input.bootstrapToken
    ).catch(() => null);
    if (!claims) {
      return Result.err("invalid");
    }
    const now = input.now ?? new Date();
    const row = await withDb((db) =>
      db.desktopBootstrapCode.findUnique({
        where: { id: claims.bootstrapId },
        select: {
          id: true,
          clerkUserId: true,
          gatewayId: true,
          boundPublicKey: true,
          redeemedAt: true,
          consumedAt: true,
          organizationClerkId: true,
          completedAt: true,
        },
      })
    );
    if (
      !row?.redeemedAt ||
      row.clerkUserId !== claims.clerkUserId ||
      row.gatewayId !== claims.gatewayId
    ) {
      return Result.err("invalid");
    }
    if (row.completedAt) {
      return Result.err("already_used");
    }
    const logoFile = input.logo
      ? await desktopBootstrapLogoService.read(row.id, input.logo)
      : undefined;
    if (logoFile === null) {
      return Result.err("invalid");
    }
    let clerkOrganization = await recoverOrganization(row, input.slug);
    if (row.consumedAt && !clerkOrganization) {
      return Result.err("already_used");
    }
    if (
      !clerkOrganization &&
      (await clerkService.userHasOrganization(claims.clerkUserId))
    ) {
      return Result.err("organization_exists");
    }
    const claimAt = nextClaimTime(now, row.consumedAt);
    const claimed = await withDb((db) =>
      db.desktopBootstrapCode.updateMany({
        where: {
          id: row.id,
          completedAt: null,
          consumedAt: row.consumedAt,
        },
        data: { consumedAt: claimAt },
      })
    );
    if (claimed.count !== 1) {
      return Result.err("already_used");
    }
    if (!clerkOrganization) {
      try {
        clerkOrganization = await clerkService.createOrganization({
          name: input.name,
          slug: input.slug,
          createdBy: claims.clerkUserId,
        });
      } catch (error) {
        await releaseUnprovisionedClaim(row.id, claimAt);
        throw error;
      }
    }
    const recorded = await withDb((db) =>
      db.desktopBootstrapCode.updateMany({
        where: { id: row.id, consumedAt: claimAt, completedAt: null },
        data: { organizationClerkId: clerkOrganization.id },
      })
    );
    if (recorded.count !== 1) {
      return Result.err("already_used");
    }
    // Upload before issuing the session. A provider failure leaves the recorded
    // organization available for the existing retry path, not a second create.
    if (logoFile) {
      await clerkService.updateOrganizationLogo({
        organizationId: clerkOrganization.id,
        uploaderUserId: claims.clerkUserId,
        file: logoFile,
      });
      await desktopBootstrapLogoService.remove(row.id);
    }
    const provisioned = await withDb.tx(async (tx) => {
      const locked = await tx.desktopBootstrapCode.updateMany({
        where: { id: row.id, consumedAt: claimAt, completedAt: null },
        data: { consumedAt: claimAt },
      });
      if (locked.count !== 1) {
        return null;
      }
      const organization = await organizationsService.findOrCreateByClerkId(
        clerkOrganization.id,
        { name: clerkOrganization.name, slug: clerkOrganization.slug }
      );
      const user = await findOrCreateUser(
        claims.clerkUserId,
        clerkOrganization.id
      );
      if (!user?.active) {
        return { kind: "invalid" } as const;
      }
      const tokens = await issueDesktopSessionCredentials({
        userId: user.id,
        organizationId: organization.id,
        gatewayId: claims.gatewayId,
        boundPublicKey: row.boundPublicKey,
        metadata: {},
        now,
      });
      await tx.desktopBootstrapCode.update({
        where: { id: row.id },
        data: { completedAt: now },
        select: { id: true },
      });
      return { kind: "success", tokens } as const;
    });
    if (!provisioned) {
      return Result.err("already_used");
    }
    return provisioned.kind === "invalid"
      ? Result.err("invalid")
      : Result.ok(provisioned.tokens);
  },
};

function nextClaimTime(now: Date, previous: Date | null): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}

function recoverOrganization(
  row: {
    organizationClerkId: string | null;
    consumedAt: Date | null;
    clerkUserId: string;
  },
  slug: string
) {
  if (row.organizationClerkId) {
    return clerkService.getOrganization(row.organizationClerkId);
  }
  // PLN-2095 Slice 5: only a previously claimed attempt may recover an org.
  if (row.consumedAt) {
    return clerkService.findUserOrganizationBySlug(row.clerkUserId, slug);
  }
  return null;
}

async function releaseUnprovisionedClaim(
  bootstrapId: string,
  claimAt: Date
): Promise<void> {
  await withDb((db) =>
    db.desktopBootstrapCode.updateMany({
      where: {
        id: bootstrapId,
        consumedAt: claimAt,
        organizationClerkId: null,
        completedAt: null,
      },
      data: { consumedAt: null },
    })
  );
}
