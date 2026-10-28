/**
 * ISS-8619 (PRD-699 §7.6): the ingest slice's IDENTITY phase — the locks this
 * write takes and the stored row it resolves — split out of
 * `upsert-session-slice.ts`.
 *
 * The two are one phase because the lookup is only meaningful UNDER the locks:
 * `acquireSessionAdvisoryLocks` is what makes the row this read returns stable
 * against every other concurrent INGEST writer for the same
 * `externalSessionId`, and every later phase reasons about `existing` as though
 * that were true. Splitting the read from the locks would leave two call sites
 * a caller could order wrongly, and the wrong order is silent — the read still
 * returns a row, it is just no longer the row the upsert will land on.
 *
 * A deleter that does not take that lock (retention, phantom retention) can
 * still commit inside the window, which is the READ COMMITTED race
 * `upsert-arm-detail.ts` and `create-arm-race-repair.ts` exist to absorb. This
 * module does not close it; it is the phase that DEFINES the snapshot those two
 * are correcting against.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import {
  type IndexKeyProjection,
  resolveStoredIndexKey,
} from "@/lib/index-key-projection";
import { acquireSessionAdvisoryLocks } from "./advisory-locks";
import { withProseDerivedPrRefs } from "./artifact-links/prose-pr-refs";
import { acquireSessionPullRequestProviderLocks } from "./artifact-links/session-pull-request-provider-locks";
import type { AgentSessionUpsertTx } from "./records";
import { findSessionDetailByAnyIndexKey } from "./session-detail-lookup";

/** The stored columns `session-detail-lookup.ts` declares the write path may read. */
export type StoredSessionDetail = NonNullable<
  Awaited<ReturnType<typeof findSessionDetailByAnyIndexKey>>["detail"]
>;

export type SessionSliceIdentity = {
  /** The stored row as the pre-upsert read saw it, or `null` for a new session. */
  existing: StoredSessionDetail | null;
  /** The `external_session_id` this slice writes under, plus whether it bound. */
  externalSessionIdKey: IndexKeyProjection;
};

export async function resolveSessionSliceIdentity(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    computeTargetId: string;
    organizationId: string;
    session: SyncedAgentSession;
  }>
): Promise<SessionSliceIdentity> {
  await acquireSessionPullRequestProviderLocks(tx, {
    organizationId: input.organizationId,
    artifactRefs: input.session.artifactRefs,
    prRefs: withProseDerivedPrRefs(input.session),
  });
  await acquireSessionAdvisoryLocks(
    tx,
    input.session.externalSessionId,
    IndexKeyOrigin.Wire
  );

  // ISS-8069: `external_session_id` is half of the
  // `(compute_target_id, external_session_id)` UNIQUE btree, so an over-long id
  // does not store — it throws at the write and the desktop re-sends the same
  // session forever. Projected here, at the column, and NOT at the wire: the ack
  // echo is keyed on the id the DESKTOP sent (`session.externalSessionId`,
  // untouched), because echoing a projected id back would leave the outbox row
  // uncleared and recreate the infinite retry from the other side. The
  // projection is a pure function of the original, so every re-sync of this
  // session resolves to this same row.
  const found = await findSessionDetailByAnyIndexKey(
    tx,
    input.computeTargetId,
    input.session.externalSessionId
  );
  return {
    existing: found.detail,
    externalSessionIdKey: resolveStoredIndexKey(
      input.session.externalSessionId,
      found.storedExternalSessionId
    ),
  };
}
