import { ArtifactType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { purgeTranscriptObjectsBestEffort } from "@/lib/transcript-object-purge";

/**
 * Deletes a compute target the caller owns, plus everything the foreign keys
 * will not remove on their own.
 *
 * Split out of `service.ts` by ISS-8674 rather than grown in place: that file
 * is over the repo's 1,000-line ceiling and grandfathered shrink-only, and this
 * teardown is a self-contained unit with a single caller.
 *
 * Three phases, and the boundary between them is the point: an ownership read
 * and a chunked command drain BEFORE the transaction, the ordered deletes
 * inside it under a row lock, and a best-effort object purge after it commits.
 * The ORDER within each phase is the entire content of this function, and each
 * step is ordered for a different reason. They are stated at each step.
 */
export async function deleteOwnedComputeTarget(
  id: string,
  organizationId: string,
  userId: string,
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
): Promise<boolean> {
  // Ownership is checked HERE, before the chunked drain below, because that
  // drain deletes rows and must never run for a caller who does not own the
  // target. It is not the authoritative check — the transaction re-reads under
  // a row lock — it only gates the drain.
  const owned = await withDb((db) =>
    db.computeTarget.findFirst({
      where: { id, organizationId, userId },
      select: { id: true },
    })
  );
  if (!owned) {
    return false;
  }

  await drainQueuedCommandsInChunks(id);

  const outcome = await withDb.tx(
    async (tx) => {
      // FOR UPDATE, and FIRST. Two things depend on this row lock, and neither
      // is the ownership read it replaces.
      //
      // It is the LOCK ORDER that closes the delete-vs-enqueue deadlock
      // (davetho, review of #6414). An enqueue takes the FK's KEY SHARE on
      // this row and then, through the ISS-8674 trigger, a FOR NO KEY UPDATE on
      // it. KEY SHARE does not conflict with FOR NO KEY UPDATE, so without this
      // line the two transactions interleave into a cycle: the teardown holds
      // the counter's FOR NO KEY UPDATE and waits on the parent DELETE's key
      // lock, while the enqueue holds KEY SHARE and waits for the counter —
      // 40P01, which `withDb.tx` does not retry. Taking FOR UPDATE up front
      // makes a concurrent enqueue block before it acquires anything, so it can
      // hold no lock this transaction will later need.
      //
      // It also makes the residual `desktopCommand.deleteMany` below bounded:
      // nothing new can be enqueued for this target once the lock is held, so
      // that statement only sweeps what landed between the drain and here.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM "compute_targets"
         WHERE "id" = ${id}::uuid
           AND "organization_id" = ${organizationId}::uuid
           AND "user_id" = ${userId}::uuid
         FOR UPDATE`;
      if (locked.length === 0) {
        return { deleted: false, transcriptKeys: [] as string[] };
      }
      // SESSION artifacts reference the compute target with onDelete: Restrict
      // (FEA-1699), so the parent artifacts must be removed first — that cascades
      // to session_detail and its event/token-usage children. Deleting the
      // artifacts here also removes the user-facing session records, which is the
      // intended behavior when a compute target is deleted.
      await tx.artifact.deleteMany({
        where: {
          organizationId,
          type: ArtifactType.Session,
          session: { is: { computeTargetId: id } },
        },
      });
      // Collect the transcript objects' storage keys before dropping the rows
      // that carry them: the raw JSONL bytes live in the transcripts bucket,
      // separate from the row metadata, so once these rows are gone there is no
      // DB record of which objects to purge. The best-effort purge runs after
      // the transaction commits (below) so an S3 failure can never roll back or
      // corrupt the FK-ordering delete.
      const transcripts = await tx.sessionTranscript.findMany({
        where: { computeTargetId: id },
        select: { objectStorageKey: true },
      });
      // session_transcript rows reference the compute target with
      // onDelete: Restrict, so they must be removed explicitly before the
      // target row. Deleting the SESSION artifacts above only NULLs their
      // sessionDetailId (that FK is SetNull) — the transcript rows survive
      // with the RESTRICT link intact, which would otherwise make the final
      // computeTarget delete throw a P2003 and leave the target undeletable.
      await tx.sessionTranscript.deleteMany({
        where: { computeTargetId: id },
      });
      // desktop_commands is onDelete: Cascade, so this is not needed for FK
      // ordering like the two deletes above. It sweeps whatever was enqueued
      // between the chunked drain above and the FOR UPDATE — bounded by that
      // window, not by the backlog, which is what keeps the trigger's per-row
      // fan-out out of this transaction. The bulk of the queue is already gone.
      await tx.desktopCommand.deleteMany({ where: { computeTargetId: id } });
      // deleteMany keeps deletion idempotent under concurrency: a parallel
      // delete that wins the race yields count 0 here (-> 404) instead of the
      // P2025 a singular delete would throw.
      const deleted = await tx.computeTarget.deleteMany({ where: { id } });
      if (deleted.count > 0) {
        await recordWrite?.(tx, { changed: true });
      }
      return {
        deleted: deleted.count > 0,
        transcriptKeys: transcripts
          .map((t) => t.objectStorageKey)
          .filter((key): key is string => key.length > 0),
      };
    },
    // Explicit, because the 5s default is not this transaction's budget
    // (marisolashgrove, review of #6414). The command drain that used to dominate
    // it now runs outside, but the SESSION artifact deleteMany and the
    // transcript read remain O(sessions on the target) and this change does not
    // bound them. A P2028 here rolls back the whole teardown and leaves the
    // target undeletable, which is worst on exactly the targets an operator is
    // trying to tear down during an incident.
    { timeout: 30_000 }
  );

  // Purge the transcript objects only after the row delete has committed, so
  // the RESTRICT-FK ordering fix (the reason this function deletes transcripts
  // before the target) is never rolled back by a storage failure. Best-effort:
  // an S3 error is logged with the orphaned keys for follow-up cleanup rather
  // than turned into a delete failure — the target is already gone. The shared
  // helper defers the `@repo/aws/transcript-storage` import (which begins
  // with `import "server-only"`) so the caller — statically imported by the
  // desktop gateway socket server and loaded under tsx by
  // `server:import-smoke` — keeps the S3 dependency off its eager load graph.
  if (outcome.deleted) {
    await purgeTranscriptObjectsBestEffort(
      outcome.transcriptKeys,
      "[compute-targets] failed to purge transcript objects after target delete",
      { computeTargetId: id, organizationId }
    );
  } else if (outcome.transcriptKeys.length > 0) {
    // Transcript rows were deleted (e.g. in a concurrent race that already
    // removed the compute-target row) but the target row itself was already
    // gone when deleteMany ran, so deleted=false. The transcript S3 objects
    // were NOT purged — log them so orphaned objects are observable.
    log.warn(
      "[compute-targets] transcript rows deleted but compute target row was already gone; S3 objects may be orphaned",
      {
        computeTargetId: id,
        organizationId,
        objectStorageKeys: outcome.transcriptKeys,
      }
    );
  }

  return outcome.deleted;
}

/**
 * Rows one drain statement removes before committing.
 *
 * The size matters because the cost is not linear in it. The ISS-8674 trigger
 * fires per command row and writes the SAME `compute_targets` row every time,
 * so within one statement each write extends that row's update chain and the
 * next write walks further down it. Measured on Postgres 16 against this
 * migration, one statement: 1k rows 233ms, 2k 738ms, 4k 2.5s, 8k 9.2s, 16k
 * 36.4s — a doubling of rows costs ~3.5x the time. Committing between chunks
 * ends each chain, so the same 16k rows drain in 4.0s.
 *
 * 1,000 keeps a chunk well inside a statement timeout while paying the
 * round-trip cost only once per thousand rows.
 */
const COMMAND_DRAIN_CHUNK = 1000;

/**
 * Chunks a target may need before the residual sweep inside the transaction
 * takes over.
 *
 * Only a live enqueue stream can keep this loop fed, and the FOR UPDATE in the
 * transaction is what actually stops that. This bound exists so an unbounded
 * external write rate cannot spin here forever — the leftovers are correct
 * either way, just deleted under the lock instead.
 */
const MAX_COMMAND_DRAIN_CHUNKS = 1000;

/**
 * Empties a target's command queue in committed chunks, outside any transaction.
 *
 * Split out of the teardown transaction by ISS-8674 review (marisolashgrove). It
 * used to be one `deleteMany` inside it, which the counter trigger turned into
 * one single-row UPDATE per command against one target row — superlinear, and
 * past `withDb.tx`'s 5s default at ~8,000 queued rows. A P2028 there rolls back
 * the artifact and transcript deletes too and leaves the target undeletable,
 * and a deep queue is the state ISS-8686 reports never drains, so the failure
 * lands on precisely the targets an operator needs to remove.
 *
 * The trade this makes: the drain is no longer atomic with the rest of the
 * teardown, so a later failure leaves the target present with its queue
 * emptied. That is recoverable — the delete is idempotent and retryable — where
 * the previous behavior was not recoverable at all on a deep target.
 *
 * Deletes the whole queue, not just `queued` rows: the transaction removes the
 * target, so every command row goes regardless of status, and narrowing the
 * predicate here would only leave more for the in-transaction sweep.
 */
async function drainQueuedCommandsInChunks(
  computeTargetId: string
): Promise<void> {
  for (let chunk = 0; chunk < MAX_COMMAND_DRAIN_CHUNKS; chunk++) {
    const deleted = await withDb(
      (db) =>
        db.$executeRaw`
          DELETE FROM "desktop_commands"
           WHERE "id" IN (
             SELECT "id"
               FROM "desktop_commands"
              WHERE "compute_target_id" = ${computeTargetId}::uuid
              LIMIT ${COMMAND_DRAIN_CHUNK}
           )`
    );
    if (deleted === 0) {
      return;
    }
  }
}
