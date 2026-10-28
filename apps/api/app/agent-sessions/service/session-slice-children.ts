/**
 * ISS-8619 (PRD-699 §7.6): the ingest slice's CHILDREN phase — everything keyed
 * to the session's own `artifactId` that a row must exist before it can be
 * written, split out of `upsert-session-slice.ts`.
 *
 * The three steps are one phase because each depends on the previous one's
 * writes, not merely on their order: the tiling clear is knowable only once
 * tiling rows have ACTUALLY been persisted, and the reopen's synthesized anchor
 * is `maxEventCreatedAt`, which is what the children write produces. Nothing
 * outside this phase consumes `maxEventCreatedAt`, so it never leaves the
 * module.
 *
 * The edge that is load-bearing is the one BEFORE it, and only that one: the
 * upsert has to have decided the `artifactId`, and `maybeReopenTerminalSession`
 * clears `session_ended_at` as its own legitimate job — so the refusal
 * diagnostic that reads that column is taken in the write phase, before this one
 * runs. Nothing here is ordered against the LINKS phase; this simply settles the
 * session row itself, which is why the orchestrator runs it first.
 */

import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import {
  normalizeSessionStatus,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { ActivityTilingSkipReason } from "./activity-segment-persistence";
import { clearRecordedTilingStripIfRepaired } from "./activity-tiling-strip";
import { toDate } from "./coercion";
import { persistSessionChildren } from "./persist-session-children";
import type { AgentSessionUpsertTx } from "./records";
import { maybeReopenTerminalSession } from "./session-reopen";
import type { SessionSliceIdentity } from "./session-slice-identity";

export type PersistedSessionChildren = {
  /**
   * ISS-8603: why this slice's tiling append was refused, or `null`. Passes
   * straight through; the batch is what counts it.
   */
  activityTilingSkipReason: ActivityTilingSkipReason | null;
  /** ISS-8881: rollup counters this payload could not store. */
  unstorableCounterFields: readonly string[];
};

export async function persistSessionSliceChildren(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    artifactId: string;
    existing: SessionSliceIdentity["existing"];
    guardedSessionEndedAt: Date | null;
    /**
     * The lifecycle status this slice is writing to `artifacts.status`, AFTER
     * terminal-wins. The rollup's own status column mirrors the same desktop
     * source, so it is guarded against this rather than folded alone — without
     * it a straggler batch stamps `active` on the rollup of a session whose
     * artifact row the guard is holding at `inactive`.
     */
    guardedStatus: SessionStatus;
    normalizedTokenUsage: SyncedAgentSessionTokenUsage[];
    organizationId: string;
    session: SyncedAgentSession;
    shouldReplace: boolean;
    shouldUpdateTokenEventCosts: boolean;
  }>
): Promise<PersistedSessionChildren> {
  const { artifactId, existing, session } = input;
  const {
    activityTilingPersisted,
    activityTilingSkipReason,
    maxEventCreatedAt,
    unstorableCounterFields,
  } = await persistSessionChildren(
    tx,
    artifactId,
    input.organizationId,
    session,
    input.normalizedTokenUsage,
    {
      guardedStatus: input.guardedStatus,
      shouldReplace: input.shouldReplace,
      shouldUpdateTokenEventCosts: input.shouldUpdateTokenEventCosts,
    }
  );

  // ISS-7265: clear a recorded strip only once tiling rows have ACTUALLY been
  // written — knowable only here, after the children persist, and not from the
  // payload the detail upsert already committed. Rare by construction, so the
  // common sync issues no extra write.
  await clearRecordedTilingStripIfRepaired(tx, {
    activityTilingPersisted,
    artifactId,
    recordedStripped: existing?.activitySegmentRowsStripped,
    watermarkAllowsWrite: input.shouldUpdateTokenEventCosts,
  });

  // ISS-5981: the RAW status, deliberately — this is the one place downstream of
  // the fold that must still see the spelling the producer sent.
  //
  // `maybeReopenTerminalSession` is an INPUT-tolerance surface: it folds at its
  // own write (`normalizeSessionStatus(action.incomingStatus)`), so nothing
  // unfolded reaches a column. Both of its reads of this value need the raw
  // form, and threading the folded one broke each:
  //   • `shouldReopenSession` compares it RAW against `active`/`waiting`. Folded,
  //     every unmodelled spelling and `running` arrive as `active` and pass a
  //     predicate that used to reject them — resurrecting a finished run,
  //     clearing its `session_ended_at`, and restarting its duration.
  //   • `resolveReopenAwaitingInputSince` synthesizes the anchor from
  //     `maxEventCreatedAt` only when the status IS `waiting` (ISS-5974). Folded,
  //     that branch is unreachable, and the stored fallback cannot cover it: a
  //     reopen only fires on a TERMINAL row, whose anchor both writers have
  //     already nulled. The run reopens Active with no anchor, then ages Stale.
  // The anchor is the RAW declared value for the same reason. A reopen resolves
  // its own fallback from `maxEventCreatedAt` — the moment the run actually
  // resumed — which is a better anchor for a reopened run than this write's
  // activity-clock synthesis, and is unavailable at the ingest write (it comes
  // from `persistSessionChildren`, above). Handing it the already-resolved value
  // would pre-empt that with a staler timestamp.
  await maybeReopenTerminalSession(
    tx,
    {
      persistedStatus: toReopenPersistedStatus(existing?.artifact?.status),
      incomingStatus: session.status,
      maxEventCreatedAt,
      persistedSessionEndedAt: input.guardedSessionEndedAt,
    },
    {
      artifactId,
      incomingStatus: session.status,
      incomingAwaitingInputSince: toDate(session.awaitingInputSince),
    }
  );

  return { activityTilingSkipReason, unstorableCounterFields };
}

/**
 * The stored session status as the reopen predicate takes it: NORMALIZED at
 * this read boundary, so `shouldReopenSession` reasons in the vocabulary rather
 * than about strings, and `null` when there is no stored row.
 *
 * This is the STORED value, deliberately, not the `guardedStatus` this write
 * resolves to. `resolveGuardedStatus` returns the incoming status whenever the
 * stored one is non-terminal, so the guarded value would report an `active` row
 * receiving an incoming `inactive` as having already finished.
 */
function toReopenPersistedStatus(
  status: string | null | undefined
): SessionStatus | null {
  return status ? normalizeSessionStatus(status) : null;
}
