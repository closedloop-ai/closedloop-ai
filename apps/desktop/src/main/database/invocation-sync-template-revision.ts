/**
 * @file invocation-sync-template-revision.ts
 * @description The invocation-parts lane's TEMPLATE REVISION bump — the one
 * statement that tells every target-scoped delivery queue it has work to re-read.
 *
 * `prepareInvocationSyncTarget` gates its whole sweep on
 * `targetRevision >= templateRevision`, so a writer that changes what the
 * templates owe MUST advance this counter or the change is invisible: the target
 * cursors it cleared are never even looked at. Three writers need it —
 * materialization (`enqueueInvocationGeneration`), ISS-6889's canonicalization
 * repair, and ISS-6909's one-shot re-drive — and they carried three verbatim
 * copies of the same SQL, which is one edit away from a store where the guard
 * never opens and a one-shot pass has already spent its sentinel.
 *
 * The increment is expressed as an atomic `ON CONFLICT ... source_sequence + 1`
 * rather than a read-then-write, so concurrent writers inside the lane's single
 * write queue compose instead of clobbering.
 */

import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../agent-sync/agent-component-invocation-sync-constants.js";

/**
 * The minimal write surface this needs. Structural rather than
 * `Prisma.TransactionClient` because all three callers run it inside a different
 * transaction shape.
 */
export type InvocationSyncRevisionWriter = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * Advance the template state revision by one, creating the sentinel row at 1 when
 * this store has never had it.
 */
export async function bumpInvocationSyncTemplateRevision(
  tx: InvocationSyncRevisionWriter,
  nowIso: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO agent_component_invocation_sync_cursors
       (source_key, external_session_id, external_generation_id,
        source_sequence, updated_at)
     VALUES ($1, $2, $2, 1, $3)
     ON CONFLICT (source_key, external_session_id) DO UPDATE SET
       source_sequence = agent_component_invocation_sync_cursors.source_sequence + 1,
       updated_at = excluded.updated_at`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
    nowIso
  );
}
