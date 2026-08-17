/**
 * @file durable-outbox.ts
 * @description The shared MECHANICS for every desktop→cloud sync lane that owns a
 * durable outbox (PLN-1562 WS1). The status vocabulary these operate on lives in
 * the node-free `shared/sync-lane-contract.ts`; this module is the main-process
 * half that turns it into queries, row fields, and the failure decision.
 *
 * WHY THIS EXISTS. Two lanes persist an outbox — the per-session metadata lane
 * (`agent_session_sync_outbox`, FEA-3473) and the invocation parts lane
 * (`agent_component_invocation_sync_outbox`) — and both were written to
 * `TranscriptSyncState`'s crash-correct discipline (FEA-2714/2715) by COPY. That
 * propagated the discipline through review vigilance alone, and it had already
 * drifted: two hand-rolled exponential-backoff ladders re-derived what the shared
 * `exponentialBackoffMs` (FEA-3795) already computes, and each lane declared its
 * own copy of the identical status union. These helpers make the mechanics
 * code-enforced instead, and they are the MANDATORY substrate for the next
 * outbox-shaped lane.
 *
 * WHAT THIS IS NOT. This is not a generic sync framework and must not grow into
 * one. Each lane keeps its own table, identity arity, payload/protocol columns,
 * and per-reason retry budgets — the deliberate non-goals recorded in PLN-1562 and
 * in `AGENTS.md` next door. These are PURE functions over the queue-mechanics
 * columns every outbox row shares (`status`, `attempt_count`, `next_attempt_at`,
 * `last_error`, `updated_at`); they take no Prisma delegate and hold no state, so
 * a lane composes them into its own store rather than inheriting a runtime.
 *
 * Anything cross-lane (shared upload budgets, ordering, coordinated backpressure)
 * is out of scope by design and re-opens the framework question instead of
 * growing this file.
 */

import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";

/**
 * The READY predicate shared by every outbox drain: rows for one `sourceKey` that
 * are still `pending` AND whose backoff deadline has elapsed (a row that has never
 * been deferred has a null `next_attempt_at` and is immediately ready).
 *
 * Returned as a plain object so a lane spreads it into its own `where` alongside
 * whatever else it filters on. `sourceKey` scoping is NOT optional and is baked in
 * here on purpose: it is the invariant that stops one account/machine from
 * draining another's queue (see the sourceKey-scoping rule in `AGENTS.md`).
 */
export function readyOutboxWhere(
  sourceKey: string,
  nowIso: string
): {
  sourceKey: string;
  status: OutboxStatus;
  OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: string } }];
} {
  return {
    sourceKey,
    status: OutboxStatus.Pending,
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: nowIso } }],
  };
}

/** The row fields written when an outbox row is terminally abandoned. */
export type OutboxDeadLetterFields = {
  status: OutboxStatus;
  nextAttemptAt: null;
  lastError: string;
  updatedAt: string;
  attemptCount?: number;
};

/**
 * The fields that mark a row `dead_lettered`: record WHY, clear the scheduled
 * retry (the row is no longer awaiting one), and stamp `updated_at`.
 *
 * `attemptCount` is optional because the two callers know different things. A
 * lane that exhausted a retry budget passes the real burned count so the row does
 * not misreport `0` (FEA-3659); the invocation lane's payload-parse quarantine has
 * no attempt to report and omits it, leaving the persisted count untouched.
 *
 * Deliberately does NOT clear `attempt_count` — a dead-letter is evidence, and the
 * count is the evidence of how hard the lane tried before giving up.
 */
export function outboxDeadLetterFields(input: {
  reason: string;
  nowIso: string;
  attemptCount?: number;
}): OutboxDeadLetterFields {
  const fields: OutboxDeadLetterFields = {
    status: OutboxStatus.DeadLettered,
    nextAttemptAt: null,
    lastError: input.reason,
    updatedAt: input.nowIso,
  };
  if (input.attemptCount !== undefined) {
    fields.attemptCount = input.attemptCount;
  }
  return fields;
}

/**
 * The fields that record a transient retry-with-backoff: the incremented attempt
 * count, the deadline before which the row must not be re-drained, and the reason.
 *
 * `status` is deliberately ABSENT from the returned fields. A retry write must
 * never resurrect a `dead_lettered` row as `pending` (FEA-3659) — omitting the
 * column leaves whatever the row already had, which is `pending` on every path
 * that legitimately records a retry. Callers must not add it back.
 */
export function outboxRetryFields(input: {
  attemptCount: number;
  nextAttemptAt: string;
  reason: string;
  nowIso: string;
}): {
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string;
  updatedAt: string;
} {
  return {
    attemptCount: input.attemptCount,
    nextAttemptAt: input.nextAttemptAt,
    lastError: input.reason,
    updatedAt: input.nowIso,
  };
}

/**
 * The fields that flip a RECOVERED dead-letter back to `pending` and restart its
 * bounded budget from scratch — the durable twin of a lane's in-memory
 * failure-state reset (FEA-3697).
 *
 * Callers must scope the write to rows that are currently `dead_lettered`, so a
 * re-pend can never reset the budget of an in-flight `pending` retry out from
 * under it.
 */
export function outboxRePendFields(nowIso: string): {
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: null;
  lastError: null;
  updatedAt: string;
} {
  return {
    status: OutboxStatus.Pending,
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: nowIso,
  };
}

/** What a lane should do with a row after a failed delivery attempt. */
export const OutboxFailureOutcome = {
  Retry: "retry",
  DeadLetter: "dead_letter",
} as const;
export type OutboxFailureOutcome =
  (typeof OutboxFailureOutcome)[keyof typeof OutboxFailureOutcome];

/**
 * The decision a lane makes after one failed delivery attempt, carrying the
 * post-increment `attemptCount` both branches must persist.
 */
export type OutboxFailureDecision =
  | {
      outcome: typeof OutboxFailureOutcome.Retry;
      attemptCount: number;
      nextAttemptAtMs: number;
    }
  | {
      outcome: typeof OutboxFailureOutcome.DeadLetter;
      attemptCount: number;
    };

/**
 * Charge one failed delivery against a row's budget and decide what happens next:
 * retry on the shared exponential ladder, or dead-letter once a PERMANENT failure
 * class has exhausted `maxAttempts`.
 *
 * `attemptCount` is the count BEFORE this failure (what the row currently
 * persists); the returned `attemptCount` is post-increment and is what both
 * branches write.
 *
 * `permanent` is the caller's classification and is load-bearing: only a failure
 * the lane attributes to the ROW ITSELF (a validation rejection, a part conflict)
 * may exhaust the budget. A lane-wide condition — auth loss, transport error, rate
 * limit, 5xx — must be classified transient, or an outage dead-letters healthy
 * rows wholesale. This mirrors the `ComponentSyncSendOutcome.LaneFailure` split
 * (ISS-4542) and the session lane's untouched-budget defers for `unauthenticated`
 * / `target_not_owned` (FEA-3425).
 *
 * Backoff comes from the shared {@link exponentialBackoffMs} ladder so this and
 * every other desktop retry schedule stay one source of truth (FEA-3795).
 */
export function decideOutboxFailure(input: {
  attemptCount: number;
  maxAttempts: number;
  permanent: boolean;
  nowMs: number;
  baseMs: number;
  maxMs: number;
}): OutboxFailureDecision {
  const attemptCount = input.attemptCount + 1;
  if (input.permanent && attemptCount >= input.maxAttempts) {
    return { outcome: OutboxFailureOutcome.DeadLetter, attemptCount };
  }
  return {
    outcome: OutboxFailureOutcome.Retry,
    attemptCount,
    nextAttemptAtMs:
      input.nowMs +
      exponentialBackoffMs(attemptCount, input.baseMs, input.maxMs),
  };
}
