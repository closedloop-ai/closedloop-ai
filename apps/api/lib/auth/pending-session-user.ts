import "server-only";

import { auth } from "@repo/auth/server";

export type PendingSessionPrincipal = {
  clerkUserId: string;
};

export async function resolvePendingSessionPrincipal(): Promise<PendingSessionPrincipal | null> {
  const { userId, orgId, sessionStatus } = await auth({
    treatPendingAsSignedOut: false,
  });
  if (!(userId && !orgId && sessionStatus === "pending")) {
    return null;
  }
  return { clerkUserId: userId };
}
