import "server-only";

import { withDb } from "@repo/database";

export const desktopBootstrapSchemaReadinessService = {
  async isReady(): Promise<boolean> {
    // Probe the same database/schema used by bootstrap operations. Even an
    // empty table resolves this projection, so no bootstrap row is required.
    // Do not cache: stage migrates after promotion, and the next retry must
    // observe completion (or a database/schema change) without a cold start.
    return await withDb(async (db) => {
      await db.desktopBootstrapCode.findFirst({
        select: {
          consumedAt: true,
          organizationClerkId: true,
          completedAt: true,
        },
      });
      return true;
    }).catch(() => false);
  },
};
