import "server-only";

import type { User } from "@repo/api/src/types/user";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Resolves a Clerk user plus organization into the corresponding internal user.
 *
 * If the user has not been synced into the current org yet, this helper pulls
 * the profile from Clerk and upserts the missing row before returning it.
 */
export async function findOrCreateUser(
  clerkUserId: string,
  clerkOrgId: string
): Promise<User | null> {
  const organization =
    await organizationsService.findOrCreateByClerkId(clerkOrgId);

  const existingUser = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );

  if (existingUser) {
    return existingUser;
  }

  log.info("User not found, fetching from Clerk", { clerkUserId });

  const clerkUser = await clerkService.getUser(clerkUserId);

  const user = await usersService.upsertByClerkIdAndOrg({
    clerkId: clerkUserId,
    organizationId: organization.id,
    email: clerkUser.email,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    avatarUrl: clerkUser.imageUrl,
    phoneNumber: clerkUser.phoneNumber,
  });

  log.info("Created/updated user from Clerk", {
    userId: user.id,
    clerkUserId,
    organizationId: organization.id,
  });

  return user;
}
