import { withDb } from "@repo/database";

const DAY_MS = 86_400_000;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

/** Cron-only cross-tenant sweep. Every deletion retains the selected org predicate. */
export const sessionMeshRetentionService = {
  async sweep(now = new Date()) {
    const presenceCutoff = new Date(now.getTime() - 30 * DAY_MS);
    // Keep event history for the complete maximum reporting window.
    const contentCutoff = new Date(now.getTime() - 90 * DAY_MS);
    const metricsCutoff = new Date(now.getTime() - 90 * DAY_MS);
    const deleted = { presences: 0, messages: 0, metrics: 0 };
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const counts = await withDb(async (db) => {
        const [presences, messages, metrics] = await Promise.all([
          db.sessionMeshPresence.findMany({
            where: { expiresAt: { lt: presenceCutoff } },
            select: { id: true, organizationId: true },
            orderBy: { expiresAt: "asc" },
            take: BATCH_SIZE,
          }),
          db.sessionMeshMessage.findMany({
            where: { expiresAt: { lt: contentCutoff } },
            select: { id: true, organizationId: true },
            orderBy: { expiresAt: "asc" },
            take: BATCH_SIZE,
          }),
          db.sessionMeshMetricEvent.findMany({
            where: { createdAt: { lt: metricsCutoff } },
            select: { id: true, organizationId: true },
            orderBy: { createdAt: "asc" },
            take: BATCH_SIZE,
          }),
        ]);
        // Separate committed statements; expiry guards protect a concurrent
        // presence refresh. Message deletion cascades the private inbox rows.
        const results = await Promise.all([
          presences.length === 0
            ? { count: 0 }
            : db.sessionMeshPresence.deleteMany({
                where: { OR: presences, expiresAt: { lt: presenceCutoff } },
              }),
          messages.length === 0
            ? { count: 0 }
            : db.sessionMeshMessage.deleteMany({
                where: { OR: messages, expiresAt: { lt: contentCutoff } },
              }),
          metrics.length === 0
            ? { count: 0 }
            : db.sessionMeshMetricEvent.deleteMany({
                where: { OR: metrics, createdAt: { lt: metricsCutoff } },
              }),
        ]);
        return {
          results,
          full: [presences, messages, metrics].some(
            (rows) => rows.length === BATCH_SIZE
          ),
        };
      });
      deleted.presences += counts.results[0].count;
      deleted.messages += counts.results[1].count;
      deleted.metrics += counts.results[2].count;
      if (!counts.full) {
        return { ...deleted, hasMore: false };
      }
    }
    return { ...deleted, hasMore: true };
  },
};
