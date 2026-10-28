import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Advertise the SQLite filter contract and the writer revision used by pageData. */
export async function readSqliteSessionCompactFilterCapabilities(
  prisma: DesktopPrisma
) {
  const revision = await readSqliteSessionStoreRevision(prisma);
  return {
    cursor: SESSION_COMPACT_FILTER_VERSION,
    count: SESSION_COMPACT_FILTER_VERSION,
    usage: SESSION_COMPACT_FILTER_VERSION,
    analytics: SESSION_COMPACT_FILTER_VERSION,
    storeRevision: revision,
  };
}

/** Best-effort writer change signal for the combined list and usage read. */
export async function readSqliteSessionStoreRevision(
  prisma: DesktopPrisma
): Promise<number> {
  const [row] = await prisma.client.$queryRawUnsafe<
    { revision: number | bigint }[]
  >("SELECT total_changes() AS revision");
  return Number(row?.revision ?? 0);
}
