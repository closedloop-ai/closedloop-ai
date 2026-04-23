import "server-only";

import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { findOrCreateUser } from "./find-or-create-user";

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

  const user = await findOrCreateUser(clerkUserId, clerkOrgId);

  if (!user?.active) {
    return null;
  }

  return { user, clerkUserId, clerkOrgId };
}
