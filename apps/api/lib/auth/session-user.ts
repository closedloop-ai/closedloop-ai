import "server-only";

import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";

export type SessionUserContext = {
  user: User;
  clerkUserId: string;
  clerkOrgId: string;
};

/**
 * Resolves the active Clerk browser session to an internal user record.
 * Returns null when no session is present or the resolved user is inactive.
 */
export async function resolveSessionUser(): Promise<SessionUserContext | null> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!(clerkUserId && clerkOrgId)) {
    return null;
  }

  const organization =
    await organizationsService.findOrCreateByClerkId(clerkOrgId);

  let user = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );

  if (!user) {
    const clerkUser = await clerkService.getUser(clerkUserId);
    user = await usersService.upsertByClerkIdAndOrg({
      clerkId: clerkUserId,
      organizationId: organization.id,
      email: clerkUser.email,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      avatarUrl: clerkUser.imageUrl,
      phoneNumber: clerkUser.phoneNumber,
    });
  }

  if (!user.active) {
    return null;
  }

  return { user, clerkUserId, clerkOrgId };
}
