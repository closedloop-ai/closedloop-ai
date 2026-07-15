import "server-only";

import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { withDb } from "@repo/database";

/**
 * Resolves the display identity for a signed-in desktop session: the user's
 * name/email plus their organization's name. Org-scoped to the authenticated
 * user so a token can only ever read its own identity.
 */
export const desktopIdentityService = {
  async get(
    userId: string,
    organizationId: string
  ): Promise<DesktopIdentity | null> {
    const user = await withDb((db) =>
      db.user.findFirst({
        where: { id: userId, organizationId },
        select: {
          id: true,
          organizationId: true,
          email: true,
          firstName: true,
          lastName: true,
          organization: { select: { name: true } },
        },
      })
    );

    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationName: user.organization?.name ?? null,
    };
  },
};
