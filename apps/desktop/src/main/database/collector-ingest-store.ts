/**
 * @file collector-ingest-store.ts
 * @description ISS-9838: the `collector_ingest_stores` table — the durable home
 * for the collector ingest stores that used to be best-effort JSON files (the
 * per-collector catchup cache, the per-collector parse quarantine, and the Codex
 * rollout-linkage cache).
 *
 * One table, one module, every function takes the `DesktopPrisma` handle
 * explicitly — the `compute-target-environment-store.ts` conventions. Writes
 * route through `prisma.write`; reads use `prisma.client`.
 *
 * One row per STORE (ISS-9837 R3, whole-store discard): `formatVersion` names a
 * FORMAT, and a format is a property of the store, never of a row. `payload` is
 * opaque here — the reading store owns and validates its own entry shape.
 */
import type { DesktopPrisma } from "./prisma-client.js";
import { WriteQueueClass } from "./write-queue.js";

/** One persisted ingest store, exactly as the table holds it. */
export type CollectorIngestStoreRow = {
  storeKey: string;
  formatVersion: number;
  payload: string;
};

/**
 * Every persisted ingest store, read in one pass.
 *
 * Read ONCE at boot, before the collectors are constructed (ISS-9837 R1), which
 * is what lets every store constructor stay synchronous. The table holds one row
 * per collector store — a dozen at most — so a full read is cheaper than a seek
 * per store and needs no pagination.
 */
export async function loadCollectorIngestStores(
  prisma: DesktopPrisma
): Promise<CollectorIngestStoreRow[]> {
  return await prisma.client.collectorIngestStore.findMany({
    select: { storeKey: true, formatVersion: true, payload: true },
  });
}

/**
 * Replace one store's snapshot. Latest write wins wholesale — these stores flush
 * their entire map, so a merge would be wrong as well as slower.
 */
export async function saveCollectorIngestStore(
  prisma: DesktopPrisma,
  storeKey: string,
  formatVersion: number,
  payload: string
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write(
    (client) =>
      client.collectorIngestStore.upsert({
        where: { storeKey },
        create: { storeKey, formatVersion, payload, updatedAt: now },
        update: { formatVersion, payload, updatedAt: now },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}
