/**
 * @file backfill-existing-sessions.ts
 * @description Typed helper for the transcript backfills: bulk-load the set of
 * imported `sessions.id`s so a backfill can skip transcripts whose session row
 * does not exist yet (no FK parent / derivation target). A read failure degrades
 * to `null` (the caller treats that as "unknown — don't skip"), never a throw.
 *
 * Used by the activity-segment backfill. The artifact-link backfill carries an
 * identical block over `$queryRawUnsafe` that can adopt this once its
 * string-level SQL test mock is reworked (out of FEA-2267's scope).
 */
import type { DesktopPrisma } from "../../database/prisma-client.js";

export async function loadExistingSessionIds(
  prisma: DesktopPrisma
): Promise<Set<string> | null> {
  try {
    const rows = await prisma.client.session.findMany({ select: { id: true } });
    return new Set(rows.map((row) => row.id));
  } catch {
    return null;
  }
}
