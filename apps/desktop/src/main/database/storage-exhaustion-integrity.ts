/**
 * @file storage-exhaustion-integrity.ts
 * @description ISS-6337 — the store-integrity half of the disk-full signal: the
 * clone-safe read, its wire boundary, and the check the probe wiring registers.
 *
 * Split from `storage-exhaustion.ts` on the same seam every sibling uses
 * (`database-integrity/store-integrity-reads.ts` vs the check modules): the
 * classifier and tally sit on the WRITE path and on the boot-adjacent
 * fire-and-forget path, and must not drag `zod` and the store-integrity probe
 * graph in with them.
 *
 * The tally rides the ALREADY-MONITORED `Observability.storeIntegrityResult`
 * event, exactly as the ISS-4818 WAL-probe health does, so it inherits that
 * event's detected / persistent / recovered emit cadence and needs no rate
 * limiter, no new transport, and no new monitor.
 */
import { z } from "zod";
import {
  type StorageExhaustionHealth,
  StorageExhaustionReason,
} from "../../shared/storage-exhaustion.js";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** The clone-safe read surface, optional so a test fake need not implement it. */
export type StorageExhaustionReader = {
  readStorageExhaustionHealth?(): Promise<StorageExhaustionHealth>;
};

/**
 * Runtime boundary for a version-skewed db-host response. The OUTPUT stays the
 * closed enum because `lastReason` becomes an issue's `object`, which reaches
 * Datadog: an arbitrary string from an older or newer host must never get there.
 *
 * An UNRECOGNIZED reason folds to `unattributed` rather than failing the parse.
 * Failing it would drop the whole check — and the child's read has already
 * CONSUMED its failure window by then, so the drop is permanent: a real
 * exhaustion event would be turned into a healthy probe and lost, which is the
 * "unknown reasons map to a generic fallback, never crash the consumer" rule.
 * The count is the part that must survive; a reason this build cannot name is
 * exactly what `unattributed` means.
 *
 * `active` is `.default(false)` so an older host that predates the latch still
 * parses — it degrades to the windowed-count behavior, never to a fabricated
 * "still full".
 */
export const STORAGE_EXHAUSTION_HEALTH_SCHEMA = z.object({
  failures: z.number().int().nonnegative().safe(),
  lastReason: z
    .enum(Object.values(StorageExhaustionReason))
    .nullable()
    .default(null)
    .catch(StorageExhaustionReason.Unattributed),
  active: z.boolean().default(false),
});

/**
 * ISS-6337 store-health read: the disk-full tally for the window since the
 * previous read. The counters live in the child, next to the write boundary
 * that produced them (see `prisma-client.ts`'s `write`).
 */
export function readStorageExhaustionHealth(
  prisma: DesktopPrisma
): Promise<StorageExhaustionHealth> {
  return Promise.resolve(prisma.readStorageExhaustionHealth());
}

/**
 * Turn a non-empty window into ONE content-free issue.
 *
 * `object` carries the bounded reason enum rather than a path, mirroring
 * `classifyWalProbeHealth`: the identifier slot is what reaches Datadog, and the
 * reason is the actionable detail. When the window recorded no reason the field
 * is OMITTED rather than guessed — a fabricated failure mode would mislead
 * exactly the person debugging it.
 *
 * A window with no NEW failures but a still-`active` latch is still an issue:
 * the store was refusing writes and nothing has proven it stopped. Reporting
 * healthy there would emit `store.integrity.recovered` off an idle interval
 * rather than off a recovery.
 */
export function classifyStorageExhaustionHealth(
  health: StorageExhaustionHealth,
  issues: StoreIntegrityIssue[]
): void {
  if (health.failures <= 0 && !health.active) {
    return;
  }
  issues.push({
    check: "storage_exhaustion",
    category: "storage_exhausted",
    ...(health.lastReason
      ? { object: health.lastReason, objectType: "unknown" as const }
      : {}),
  });
}

/** Compose the clone-safe read, its validation, and the classifier for wiring. */
export function storageExhaustionCheck(
  reader: StorageExhaustionReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "storage_exhaustion",
    label: "storage exhaustion health read",
    // A closure, NOT `reader.readStorageExhaustionHealth?.bind(reader)` —
    // detaching a method off the db-host proxy is never valid (ISS-4620).
    read: reader.readStorageExhaustionHealth
      ? () => Promise.resolve(reader.readStorageExhaustionHealth?.())
      : undefined,
    schema: STORAGE_EXHAUSTION_HEALTH_SCHEMA,
    classify: classifyStorageExhaustionHealth,
    // The read is an in-memory counter — no table, no PRAGMA, no contention —
    // so the boot-import skip that protects the first-launch backfill has
    // nothing to protect against here. Skipping it would be worst exactly where
    // this feature matters most: the disk filling DURING that import is the
    // ISS-6337 scenario, and the tally is memory-only, so a quit before the
    // next full tick loses the event permanently.
    runsDuringBootImport: true,
  });
}
