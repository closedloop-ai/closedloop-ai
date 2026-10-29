/**
 * ISS-12165: invocation sync state is derived from a local session. Once that
 * parent is gone, retaining its templates/deliveries only manufactures retries.
 * This is maintenance deletion, never an acknowledgement or delivered watermark.
 */
import {
  AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import type { Prisma } from "./generated/client.js";
import { INVOCATION_SYNC_CANONICALIZATION_SESSION_ID } from "./invocation-sync-canonicalization-repair.js";
import { INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID } from "./invocation-sync-validation-redrive.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Bounds the number of parent identities repaired in one prepare transaction. */
export const INVOCATION_ORPHAN_REPAIR_SESSION_LIMIT = 100;

const laneSentinelIds = [
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
  INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
  INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
];

/** Caller owns the parent deletion transaction; remove every target's copies. */
export async function deleteInvocationSyncStateForSessions(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  const where = { externalSessionId: { in: sessionIds } };
  await tx.agentComponentInvocationSyncOutbox.deleteMany({ where });
  await tx.agentComponentInvocationSyncCursor.deleteMany({ where });
}

/**
 * Recurring rather than sentinel-guarded: converge an old backlog over ticks and
 * also heal any later orphan. Selection and deletion share the serialized writer
 * transaction, so a concurrent import cannot race the parent absence check.
 */
export function purgeOrphanedInvocationSyncState(
  prisma: Pick<DesktopPrisma, "write">
): Promise<number> {
  return prisma.write((client) =>
    client.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ externalSessionId: string }[]>(
        `SELECT external_session_id AS externalSessionId
           FROM (
             SELECT external_session_id
               FROM agent_component_invocation_sync_outbox
              WHERE NOT EXISTS (
                SELECT 1 FROM sessions
                 WHERE sessions.id = external_session_id
              )
             UNION
             SELECT external_session_id
               FROM agent_component_invocation_sync_cursors
              WHERE external_session_id NOT IN ($1, $2, $3, $4, $5)
                AND NOT EXISTS (
                  SELECT 1 FROM sessions
                   WHERE sessions.id = external_session_id
                )
           )
          ORDER BY external_session_id
          LIMIT $6`,
        ...laneSentinelIds,
        INVOCATION_ORPHAN_REPAIR_SESSION_LIMIT
      );
      if (rows.length > 0) {
        await deleteInvocationSyncStateForSessions(
          tx,
          rows.map((row) => row.externalSessionId)
        );
      }
      return rows.length;
    })
  );
}
