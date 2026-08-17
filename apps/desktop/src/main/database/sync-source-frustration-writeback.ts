/**
 * FEA-4022 / ISS-6273: the local frustration write-back.
 *
 * Split out of `sync-source.ts` (a grandfathered over-ceiling file) because it
 * is the one WRITE on that module's read/hydration path and answers to a
 * different concern than the reads around it: it is a best-effort local cache,
 * not part of assembling the sync payload.
 */
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * Cache each session's sync-time frustration signal back into the local
 * `sessions.frustration_raw` / `frustration_score_version` columns so the
 * desktop's own surfaces can read it without recomputing. Best-effort and
 * idempotent — the authoritative value already ships in the sync payload, so this
 * is a local cache, not the source of truth. Routed through `prisma.write` so it
 * serializes on the single-connection write queue like every other SQLite write.
 */
export async function persistLocalFrustration(
  prisma: DesktopPrisma,
  sessions: readonly SyncedAgentSession[]
): Promise<void> {
  const updates = sessions.filter(
    (session) =>
      typeof session.frustrationRaw === "number" &&
      typeof session.frustrationScoreVersion === "number"
  );
  if (updates.length === 0) {
    return;
  }
  await prisma.write(async (client) => {
    for (const session of updates) {
      // ISS-6273: `updateMany`, not `update`, because the result is discarded.
      // Prisma's `update` emits `RETURNING` over every scalar column — 26 of them
      // here, `metadata` included — so this cache write handed the whole row back
      // across the driver boundary on the READ path, on the Sessions 2-second
      // poll, only to throw it away (13.5 MB / 12.6% of `pageData`'s gross
      // allocation). `updateMany` returns a count, so the narrowing is
      // output-identical for a `Promise<void>` caller. It also stops one missing
      // row abandoning the sessions after it in the loop (`update` throws P2025;
      // `updateMany` matches nothing). That is not a correctness fix — these
      // statements never shared a transaction, so partial success was always
      // possible; it just makes the best-effort cache reach more of the batch.
      await client.session.updateMany({
        where: { id: session.externalSessionId },
        data: {
          frustrationRaw: session.frustrationRaw,
          frustrationScoreVersion: session.frustrationScoreVersion,
        },
      });
    }
  });
}
