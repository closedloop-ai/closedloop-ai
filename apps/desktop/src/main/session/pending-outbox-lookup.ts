/**
 * @file pending-outbox-lookup.ts
 * @description PRD-536 E6 — the metadata lane's half of the local Sessions
 * `cloudSyncState` disclosure: which sessions are enqueued for cloud sync but not
 * yet server-acked.
 *
 * Extracted from `shared-agent-sessions-api.ts` (ISS-8135), which is a
 * grandfathered over-ceiling file that must not grow. The sibling lane —
 * transcript blobs — already lives on its own in `local-transcript-cloud-sync.ts`
 * and the two are folded together by the caller, so this is that file's peer
 * rather than a new seam.
 */

import type { ReadSessionDeadLetterState } from "../agent-sync/agent-session-dead-letter-sync-state.js";
import {
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
} from "../agent-sync/agent-session-sync-source.js";
import { readPendingOutboxIds } from "../agent-sync/sync-source-reply-boundary.js";
import type { OutboxDisclosureInput } from "./local-transcript-cloud-sync.js";

const EMPTY_PENDING_OUTBOX_IDS: ReadonlySet<string> = new Set<string>();

/**
 * #4150: the outcome of the page's pending-outbox lookup, discriminated so a
 * failed read (`available: false`) is distinguishable from a never-consulted /
 * proven-empty one (`available: true`, empty `ids`).
 */
export type PendingOutboxLookup =
  | {
      available: true;
      ids: ReadonlySet<string>;
      /** ISS-11427: the session lane's verdict on a row it has set aside. */
      readDeadLetterState?: ReadSessionDeadLetterState;
    }
  | { available: false };

/**
 * #4150: the never-consulted lookup the by-id / detail reads pass — an
 * `available` result with an empty set, so those rows keep the honest `synced`
 * default (no lane failed; no lane was consulted).
 */
export const DEFAULT_PENDING_OUTBOX_LOOKUP: PendingOutboxLookup = {
  available: true,
  ids: EMPTY_PENDING_OUTBOX_IDS,
};

/**
 * PRD-536 E6: load the still-`pending` outbox id set for the current identity —
 * the sessions enqueued for cloud sync but not yet server-acked. Best-effort and
 * never throwing into the list read.
 *
 * #4150 (davetho review): the result is discriminated so a FAILED read is not
 * confused with a proven-empty one. A source with no `loadPendingOutboxIds`
 * delegate (fake/legacy sources) means the lane was never consulted —
 * `available: true` with an empty set, so a row degrades to the honest `synced`
 * default. A lookup that was attempted and THREW returns `available: false`: the
 * metadata lane's state is unknown, and `.has(...)` on an empty set would
 * otherwise misread that as "proven absent → synced", stamping an
 * outbox-acked-unknown row `synced` (the exact false state ISS-4647 fixes).
 *
 * ISS-9004: a NULL compute target belongs to that UNKNOWN case, not the
 * never-consulted one. With no target there is no source key, so the outbox is
 * never read — and the rows sitting in it under the target we can no longer name
 * are exactly the ones most likely to still be local-only. `synced` is a claim
 * about durability, so publishing it off a read that never happened converts "I
 * could not find out" into "there is nothing to worry about". Joining
 * `available: false` reuses the representation #4150 already defined for that
 * meaning rather than inventing a fourth: publish no disclosure.
 *
 * A source with no delegate stays proven-empty, and that is a different fact
 * rather than the same one respelled: it owns no outbox, so there is nothing it
 * can be behind on. Only a source that HAS the lane and cannot be asked is
 * unknown. The change is also one-directional — with a null target the set was
 * empty, so no row could ever have read `pending` — so it can only withdraw a
 * false `synced`, never manufacture a false `pending`.
 *
 * ISS-8135: a reply that ARRIVED but could not be read joins that unknown case
 * rather than the never-consulted one, and is reported on the monitored path.
 * That report is throttled per OP, and this lane shares its window with the sync
 * lane's resume read of the same `loadPendingOutboxIds` op, so a rejection here
 * can be suppressed by one there within five minutes. Nothing is lost to it: the
 * event carries the op and nothing else, and a peer that refuses the op refuses
 * it for both readers.
 */
export async function loadPendingOutboxIdSet(
  source: AgentSessionSyncSource,
  computeTargetId: string | null,
  readDeadLetterState?: ReadSessionDeadLetterState
): Promise<PendingOutboxLookup> {
  if (!computeTargetId) {
    return { available: false };
  }
  if (!source.loadPendingOutboxIds) {
    return {
      available: true,
      ids: EMPTY_PENDING_OUTBOX_IDS,
      readDeadLetterState,
    };
  }
  try {
    const sourceKey = buildAgentSessionSyncSourceKey(computeTargetId);
    // ISS-8135 (davetho, #6041): this is the SAME structured-cloned db-host
    // reply the sync lane's resume read consumes, so it gets the same boundary.
    // Read raw, a `null` was swallowed here as an ordinary unavailable lookup and
    // `"abc"` / `[1, 2]` flowed into `new Set(...)` intact — a covered op with a
    // production bypass that emitted no `desktop.db_host.reply_rejected` event.
    const ids = readPendingOutboxIds(
      await source.loadPendingOutboxIds(sourceKey)
    );
    if (!ids) {
      // The lane's state is UNKNOWN, which is exactly what `available: false`
      // means here — never the proven-empty set, which would stamp an
      // outbox-acked-unknown row `synced`.
      return { available: false };
    }
    return {
      available: true,
      ids: ids.length > 0 ? new Set(ids) : EMPTY_PENDING_OUTBOX_IDS,
      readDeadLetterState,
    };
  } catch {
    return { available: false };
  }
}

/**
 * The metadata-lane input {@link buildLocalCloudSyncDisclosure} folds for one
 * row: unknown when the lookup failed, otherwise whether the row is pending and
 * — ISS-11427 — the session lane's dead-letter verdict on it, when it has one.
 */
export function resolveOutboxDisclosureInput(
  lookup: PendingOutboxLookup,
  externalSessionId: string
): OutboxDisclosureInput {
  if (!lookup.available) {
    return { known: false };
  }
  const deadLetter = lookup.readDeadLetterState?.(externalSessionId);
  return {
    known: true,
    pending: lookup.ids.has(externalSessionId),
    ...(deadLetter ? { deadLetter } : {}),
  };
}

/**
 * ISS-11427: a lookup that consulted no outbox — every row reads not-pending —
 * carrying the session lane's dead-letter verdict, which costs no read. For the
 * detail read, and for the main-process half of the list projection, whose
 * pending rows were already settled in the DB host.
 */
export function outboxLookupWithoutPendingRead(
  readDeadLetterState: ReadSessionDeadLetterState | undefined
): PendingOutboxLookup {
  return {
    available: true,
    ids: EMPTY_PENDING_OUTBOX_IDS,
    readDeadLetterState,
  };
}
