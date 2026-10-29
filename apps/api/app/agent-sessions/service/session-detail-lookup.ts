/**
 * ISS-8515: the stored-row LOOKUP for the session ingest, split out of
 * `upsert-session-slice.ts`.
 *
 * Extracted because that file crossed the 1,000-line ceiling and this is a real
 * seam rather than a line-count slice: finding the row a slice is about to write
 * is a separate responsibility from deciding what to write to it. The select here
 * is the single place that declares WHICH stored columns the write path is allowed
 * to reason about — the regression guards, the erase guard, and the metadata merge
 * all consume this one shape.
 */

import { indexKeyCandidates } from "@/lib/index-key-projection";
import type { AgentSessionUpsertTx } from "./records";

/**
 * The session row for this external id under EITHER index key, plus the key it
 * was actually found under (`null` when the session is new).
 *
 * ISS-8069 (review, whitlockk): asking only for the projected key would miss a
 * session whose raw id is over `INDEX_KEY_MAX_BYTES` but still inside the 2704
 * byte btree tuple budget — storable before this ticket, sitting in the database
 * under its raw value today. The upsert beside this lookup would then mint a
 * SECOND `SessionDetail` for a session that already has one, and keep minting a
 * divergent row on every later sync.
 *
 * Two lookups, never one `in`: the projected key WINS when both rows somehow
 * exist, and a single `findFirst` over both candidates would pick between them
 * unordered. The second lookup is reached only when the budget actually bound,
 * so ordinary traffic pays exactly the one `findUnique` this replaced.
 */
export async function findSessionDetailByAnyIndexKey(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  externalSessionId: string
): Promise<{
  detail: Awaited<ReturnType<typeof findSessionDetailByIndexKey>>;
  storedExternalSessionId: string | null;
}> {
  const candidates = indexKeyCandidates(externalSessionId);
  for (const candidate of candidates) {
    const detail = await findSessionDetailByIndexKey(
      tx,
      computeTargetId,
      candidate
    );
    if (detail) {
      return { detail, storedExternalSessionId: candidate };
    }
  }
  return { detail: null, storedExternalSessionId: null };
}

function findSessionDetailByIndexKey(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  externalSessionId: string
) {
  return tx.sessionDetail.findUnique({
    where: {
      computeTargetId_externalSessionId: { computeTargetId, externalSessionId },
    },
    select: {
      artifactId: true,
      agents: true,
      // ISS-11427: WHEN the cloud's monitored-activity hold on this session
      // began, or NULL when it is not held — the floor the hold ceiling
      // measures from. The session row's own `createdAt` is deliberately NOT
      // read for it (#8064 review): an old session's first held candidate would
      // clear that floor immediately and be abandoned with zero retries. Read
      // here rather than fetched separately, so the ceiling costs no extra
      // statement inside the sync transaction.
      monitoredActivityHeldSince: true,
      // ISS-12031: the split marker the hold writer needs alongside it.
      monitoredActivityHoldPartRetained: true,
      dataRevision: true,
      // ISS-8604: the staged sequence, read by the UPDATE arm's chunk gate only.
      // The CREATE arm re-runs that gate with all three forced absent — see
      // `resolveCreateArmChunkColumns` — because a marker read off a swept row
      // can otherwise acknowledge a one-chunk row as a complete `dataRevision`.
      pendingChunkRevision: true,
      pendingChunkTotal: true,
      pendingChunkReceived: true,
      // ISS-11427: what the sequence-assembling hold ceiling reads — the staged
      // sequence's last write, and whether the producer that opened it can
      // absorb a freed marker (`sequence-assembling-hold-ceiling.ts`).
      lastSyncedAt: true,
      pendingChunkAckContract: true,
      // ISS-11427: whether the ceiling left children the revision does not
      // describe, so the next payload at that revision replaces them.
      dataRevisionDiverged: true,
      sessionStartedAt: true,
      sessionUpdatedAt: true,
      sessionEndedAt: true,
      // ISS-7265: the recorded strip, so the clear below can be a rare targeted
      // write rather than a column refresh on every sync.
      activitySegmentRowsStripped: true,
      // ISS-5981: the STORED awaiting-input anchor. The UPDATE arm rewrites
      // this column on every sync, so the write has to see the value it is about
      // to overwrite — see `resolveIngestAwaitingInputSince` in
      // `upsert-arm-detail.ts`. ISS-8604: the CREATE arm deliberately does NOT
      // read it, because the row it came from may already have been swept.
      awaitingInputSince: true,
      // ISS-7229 (review of #6406): the STORED authoritative cost, read ONLY as
      // the monotonic guard's input. This column is deliberately outside the
      // `sessionUpdatedAt` watermark that gates its siblings, so without the
      // value it is about to overwrite, an at-least-once redelivery of an older
      // sync replaces a newer figure with a smaller one.
      authoritativeCostUsd: true,
      // ISS-8515: the STORED cost, read ONLY as the erase guard's input — the
      // rollup-side write must never replace a numeric cost with a null or with a
      // total this payload could not compute. The authoritative writer's own
      // behaviour is unchanged.
      estimatedCost: true,
      // ISS-9859: the STORED `pullRequests` blob, read ONLY so a continuation
      // part of a paginated PR sequence can append its page to it
      // (`session-pull-requests-blob.ts`). Read under the advisory locks that
      // serialize every ingest writer for this session, so no other sync can
      // change it between this read and the upsert.
      pullRequests: true,
      // ISS-7821: the STORED token rollup, read ONLY to decide whether this
      // row's `estimatedCost` already carries a token component that the
      // web-search cost-only patch must not overwrite. See `hasStoredTokenCost`.
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      artifact: {
        select: {
          status: true,
        },
      },
    },
  });
}
