/**
 * @file session-sync-watermark.ts
 * @description The `sessions.updated_at` sync-watermark helpers, extracted from
 * `write-core.ts` (ISS-6003). They are a cohesive pair used by the boot-heal /
 * analytics-maintenance passes rather than by the import write path itself, and
 * `session-analytics-maintenance.ts` already imported both across the module
 * boundary. Moving them here keeps the grandfathered `write-core.ts` shrinking
 * (see AGENTS.md -> "File Size and Organization").
 */
import type { Prisma } from "./generated/client.js";

/**
 * SYNC INVARIANT helper: advance `sessions.updated_at` for the given ids inside
 * the caller's transaction. Cloud sync selects sessions by `sessions.updated_at`
 * (`listUpdatedSessionCursorRows` in `sync-source.ts`), so a boot heal that
 * rewrites a cloud-synced snapshot (`session_analytics.is_human` / `.est_cost`,
 * `sessions.cost_usd_estimated`, …) but leaves `updated_at` untouched keeps an
 * already-uploaded session showing its stale value in the cloud dashboard until
 * some unrelated mutation touches the row. Mirrors the FEA-3226 /
 * `healCacheCostSplit` pattern. No-op for an empty id list. The bump only
 * advances (the timestamp derives from the boot wall-clock), so it never
 * regresses the watermark, and every caller is convergent (re-selects nothing on
 * the next boot), so a healed session is re-bumped at most once.
 *
 * CURSOR-GROUP BOUND (FEA-3485): a heal that spans several chunks must pass a
 * PER-CHUNK-DISTINCT, strictly-increasing timestamp (see `chunkWatermark`), NOT
 * one shared `now` for the whole pass. The sync cursor persists every session id
 * sharing the top `updated_at` into `observedIdsAtTopUpdatedAt`
 * (`agent-session-sync-service.ts`), uncapped, in the SyncState JSON column. A
 * single shared `now` would fold an O(stale-corpus) set into that top group,
 * the same cursor blow-up the `backfillSessionAnalytics` SYNC NOTE rejects.
 * Staggering per chunk keeps the top group bounded to the last chunk.
 *
 * Callers must be BOUNDED to the actually-stale set (as the heal passes are).
 * The unbounded `backfillSessionAnalytics` deliberately does NOT call this — see
 * its SYNC NOTE for why a whole-corpus single-`now` bump is a regression.
 *
 * The bumped value MUST be an ISO 'T'-form timestamp (as `Date#toISOString` /
 * `chunkWatermark` produce). The cursor compares `updated_at` as a raw string and
 * SQLite's `datetime('now')` space form sorts BEFORE any same-date ISO stamp,
 * which would make a healed bump invisible to the cursor (FEA-3232 review).
 */
export async function bumpSessionsUpdatedAt(
  tx: Prisma.TransactionClient,
  ids: string[],
  now: string
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
  await tx.$executeRawUnsafe(
    `UPDATE sessions SET updated_at = $1 WHERE id IN (${placeholders})`,
    now,
    ...ids
  );
}

/**
 * FEA-3485: derive a per-chunk sync watermark from the pass's base `now` by
 * offsetting `chunkIndex` milliseconds. Strictly increasing across chunks and
 * always >= the base boot wall-clock, so it never regresses the cursor while
 * giving each chunk its OWN `updated_at`. That bounds the sync cursor's
 * top-timestamp group (`observedIdsAtTopUpdatedAt`) to a single chunk even when a
 * heal repairs an O(corpus) stale set spread over many chunks, avoiding the
 * uncapped cursor blow-up documented on `bumpSessionsUpdatedAt`. Millisecond ISO
 * precision matches `Date#toISOString`, so lexical `updated_at` comparison in the
 * cursor query (`sinceUpdatedAt` >=) orders these exactly as numeric time.
 */
export function chunkWatermark(now: string, chunkIndex: number): string {
  if (chunkIndex === 0) {
    return now;
  }
  return new Date(new Date(now).getTime() + chunkIndex).toISOString();
}
