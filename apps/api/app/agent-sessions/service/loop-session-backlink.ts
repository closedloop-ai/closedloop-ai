import { type TransactionClient, withDb } from "@repo/database";
import { isUuid } from "./coercion";

/**
 * FEA-1718 back-link: `Loop.sessionArtifactId` -> the SESSION artifact that
 * materialized that loop.
 *
 * The live lineage is recorded the OTHER way round — `SessionDetail.sourceLoopId`,
 * written at ingest from the desktop's session attribution — so until this module
 * existed the column had a schema declaration, a unique index, and no production
 * writer at all. Anything reading `loop.sessionArtifactId` therefore rendered a
 * dead link outside seeded data.
 *
 * WINNER POLICY — EARLIEST `sessionStartedAt`, TIE-BROKEN BY `artifactId`.
 * This is the load-bearing detail, and it is deliberately identical to the
 * backfill migration's `DISTINCT ON (source_loop_id) ORDER BY source_loop_id,
 * session_started_at, artifact_id`. An earlier draft claimed only when the loop
 * was unclaimed, which made ARRIVAL ORDER the winner — so the same history
 * produced a different back-link depending on rollout timing, and live and
 * backfill could disagree about which session materialized a loop (wongk,
 * review). Arrival order is not reproducible in SQL, so the reproducible rule
 * wins on both sides: whichever session actually STARTED first.
 *
 * The write deliberately lives OUTSIDE the per-session ingest transaction. Two
 * reasons, both load-bearing:
 *
 *   1. `loops_session_artifact_id_key` is UNIQUE (at most one Session per Loop),
 *      so this write can be rejected by a constraint. AGENTS.md forbids catching
 *      a failed write and continuing to issue queries inside a Prisma interactive
 *      transaction — recoverable unique-race handling belongs after rollback or
 *      outside the transaction entirely.
 *   2. The back-link is a derived convenience edge. Losing a whole session's
 *      ingest (events, links, usage) because a cosmetic pointer lost a race would
 *      be a strictly worse outcome than an unlinked loop, which the next sync of
 *      that session re-attempts for free.
 */

export type LoopSessionBacklink = {
  loopId: string;
  organizationId: string;
  sessionArtifactId: string;
};

/**
 * The back-link a just-materialized session implies, or `null` when there is
 * nothing to link.
 *
 * `sourceLoopId` must be the value read back from the COMMITTED row, not the
 * incoming payload: the upsert's update arm writes only non-null attribution, so
 * a delivery that omits the field preserves the stored loop, and the two sources
 * disagree exactly when it matters.
 *
 * The value is free text on the wire (a version-skewed desktop can send
 * anything) while `Loop.id` is a `uuid` column, so a non-UUID is dropped here
 * rather than handed to Postgres, where the cast would raise 22P02 instead of
 * quietly not matching. Same `isUuid` gate the sibling project-resolution path
 * already applies to this exact field.
 */
export function resolveLoopSessionBacklink(input: {
  organizationId: string;
  sessionArtifactId: string;
  sourceLoopId: string | null;
}): LoopSessionBacklink | null {
  if (!isUuid(input.sourceLoopId)) {
    return null;
  }
  return {
    loopId: input.sourceLoopId,
    organizationId: input.organizationId,
    sessionArtifactId: input.sessionArtifactId,
  };
}

/**
 * Release any OTHER loop still pointing at this session artifact.
 *
 * Needed because the unique index is on `session_artifact_id` globally, not per
 * loop: when a session's attribution moves from loop A to loop B, A's pointer is
 * both stale (the session no longer claims A) and the reason B's claim would
 * raise 23505. Reconciling both sides is what keeps `Loop.sessionArtifactId` and
 * `SessionDetail.sourceLoopId` from telling two different stories (wongk,
 * review).
 *
 * The `EXISTS` guard is a safety property, not an optimisation: `sourceLoopId`
 * is caller-supplied, so without it a payload naming a nonexistent or foreign
 * loop would release a real link and put nothing in its place. Org-scoped on
 * both sides, and expressed as ONE statement so it is never a read-then-write.
 */
function releaseSupersededLoops(
  tx: TransactionClient,
  backlink: LoopSessionBacklink
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "loops" AS stale
    SET "session_artifact_id" = NULL
    WHERE stale."session_artifact_id" = ${backlink.sessionArtifactId}::uuid
      AND stale."organization_id" = ${backlink.organizationId}::uuid
      AND stale."id" <> ${backlink.loopId}::uuid
      AND EXISTS (
        SELECT 1
        FROM "loops" target
        WHERE target."id" = ${backlink.loopId}::uuid
          AND target."organization_id" = ${backlink.organizationId}::uuid
      )
  `;
}

/**
 * Claim the loop for this session when this session is the earliest one that
 * names it.
 *
 * ONE statement, never read-then-write: the claim and the "am I the earliest?"
 * comparison are the same atomic `UPDATE`. The incumbent's start time is read
 * from `session_detail` INSIDE the statement rather than passed in, so the
 * comparison uses the persisted value and needs no timestamp round-tripping.
 * `mine` is joined for the same reason — this session's own committed
 * `session_started_at`, not a client-supplied one.
 *
 * `organization_id` is in the predicate because `sourceLoopId` is
 * caller-supplied: without it a skewed or hostile desktop could point a session
 * at another organization's loop and mutate a row it cannot otherwise reach.
 */
function claimLoopForEarliestSession(
  tx: TransactionClient,
  backlink: LoopSessionBacklink
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "loops" AS l
    SET "session_artifact_id" = mine."artifact_id"
    FROM "session_detail" AS mine
    WHERE mine."artifact_id" = ${backlink.sessionArtifactId}::uuid
      AND l."id" = ${backlink.loopId}::uuid
      AND l."organization_id" = ${backlink.organizationId}::uuid
      AND (
        l."session_artifact_id" IS NULL
        OR EXISTS (
          SELECT 1
          FROM "session_detail" incumbent
          WHERE incumbent."artifact_id" = l."session_artifact_id"
            AND (mine."session_started_at", mine."artifact_id")
              < (incumbent."session_started_at", incumbent."artifact_id")
        )
      )
  `;
}

/**
 * Apply the back-link: release superseded holders, then claim the loop.
 *
 * Both statements run in ONE transaction so the pair is atomic — a release that
 * committed without its claim would drop a link and put nothing back. Neither
 * statement reads before it writes, and nothing is caught INSIDE the
 * transaction: a unique race raises and rolls the pair back together, and the
 * caller decides what to do with it.
 *
 * @returns whether this call left the loop pointing at this session artifact.
 */
export async function linkLoopSessionArtifact(
  backlink: LoopSessionBacklink
): Promise<boolean> {
  const claimed = await withDb.tx(async (tx) => {
    await releaseSupersededLoops(tx, backlink);
    return await claimLoopForEarliestSession(tx, backlink);
  });
  return claimed > 0;
}
