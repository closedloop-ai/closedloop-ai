/**
 * @file session-created-at-sync-obligation.ts
 * @description ISS-12251: a re-import that moves only `sessions.created_at`
 * leaves `updated_at` alone, so the incremental cursor never re-selects the
 * row. Its re-send is owed as a pending outbox row, written on the caller's
 * transaction so the obligation commits or rolls back with the value.
 *
 * The import cannot see the live source key: the compute target and the
 * negotiated payload revision are sync-service state in main. The row is keyed
 * under the session lane's most recently written `sync_state` key, which is the
 * live key in steady state, where the lane's idle outbox reconcile drains it.
 * Any other session-lane key is one the hydration-time partition pass
 * (`outbox-environment-partition.ts`) re-homes: a pending row under a retired
 * compute target or a superseded payload revision is adopted onto the live key
 * when the signed-in identity owns the session, and parked under its owner's
 * org otherwise. With no session-lane `sync_state` row the lane has never
 * synced, and its first-run walk sends every row, so nothing is written.
 */
import { AgentSessionSyncClass } from "../agent-sync/agent-session-sync-contract.js";
import {
  AGENT_SESSION_SYNC_SOURCE_KIND,
  splitAgentSessionSyncSourceKey,
} from "../agent-sync/agent-session-sync-source.js";
import type { Prisma } from "./generated/client.js";
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";
import {
  buildOutboxUpsertParams,
  buildOutboxUpsertSql,
} from "./sync-outbox-store.js";

/**
 * Upsert a pending `backfill` outbox row for `sessionId` on `tx`. The upsert
 * never resets an existing row's status, as `sqliteEnqueueOutboxEntries`.
 */
export async function enqueueCreatedAtResyncInTx(
  tx: Pick<Prisma.TransactionClient, "$executeRawUnsafe" | "$queryRawUnsafe">,
  args: { sessionId: string; now: string }
): Promise<void> {
  const sourceKey = await readSessionLaneOutboxKey(tx);
  if (sourceKey === null) {
    return;
  }
  await tx.$executeRawUnsafe(
    buildOutboxUpsertSql(1),
    ...buildOutboxUpsertParams(sourceKey, args.now, [
      {
        externalSessionId: args.sessionId,
        syncClass: AgentSessionSyncClass.Backfill,
      },
    ])
  );
}
const SESSION_LANE_KEY_PREFIX = `${AGENT_SESSION_SYNC_SOURCE_KIND}:`;

/** `sync_state.updated_at` ranked as an instant across every candidate row. */
const SYNC_STATE_RECENCY_SQL = allOrNothingCanonicalSortSql(
  canonicalRankingKeySql("s.updated_at"),
  "s.updated_at",
  ""
);

async function readSessionLaneOutboxKey(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">
): Promise<string | null> {
  const [row] = await tx.$queryRawUnsafe<{ source_key: string }[]>(
    `SELECT ranked.source_key AS source_key
       FROM (
         SELECT s.source_key AS source_key,
                ${SYNC_STATE_RECENCY_SQL} AS recency
           FROM sync_state s
          WHERE substr(s.source_key, 1, $1) = $2
       ) ranked
      ORDER BY ranked.recency DESC, ranked.source_key DESC
      LIMIT 1`,
    SESSION_LANE_KEY_PREFIX.length,
    SESSION_LANE_KEY_PREFIX
  );
  return row && splitAgentSessionSyncSourceKey(row.source_key)
    ? row.source_key
    : null;
}
