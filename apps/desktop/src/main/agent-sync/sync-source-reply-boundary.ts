/**
 * @file sync-source-reply-boundary.ts
 * @description ISS-8115 — the boundary schemas for the sync lane's DURABLE
 * replies, and what each one degrades to when the peer answers a shape this
 * build cannot read.
 *
 * ## Why these replies need a schema at all
 *
 * In the FEA-2038 build `syncSource.*` is the db-host forwarding Proxy: the call
 * is an `invoke` message, and the reply is whatever the child structured-cloned
 * back. `db-host-invoke-dispatch` delivers that value VERBATIM — no validation —
 * and the main-process Proxy is a single `as DbHostAgentDatabase` cast. So the
 * static type of every reply below is an ASSERTION about the peer, not a fact
 * about the bytes, and TypeScript does not constrain IPC payloads at runtime.
 *
 * ## Why LOOSE, never `.strict()`
 *
 * Same reason `telemetryDiagnosticsBoundarySchema` and the ISS-7957
 * `outboxClearResultBoundarySchema` are: a `.strict()` schema at a cross-process
 * boundary rejects the ENTIRE payload over one key it was never taught, which
 * converts a newer peer's richer reply into a total loss and re-drops it on every
 * retry. Loose type-checks the fields both halves agree on and lets an unknown
 * one travel.
 *
 * LOOSE IS ABOUT UNKNOWN KEYS, NOT WEAK FIELDS. The two are independent, and
 * conflating them is what a boundary schema is most likely to get wrong: a key
 * this build has never heard of is a newer peer and must ride through, while a
 * key this build DOES claim to understand must hold the invariant the readers
 * downstream actually depend on. So the known fields are validated to their
 * DOMAIN, not merely to their JS `typeof` — a canonical instant rather than any
 * string, a bounded id set rather than any array, a nonnegative integer rather
 * than any number. Each of those three is annotated at its field (the first two
 * in `persisted-sync-state-reply-boundary.ts`) with the concrete downstream
 * failure a `typeof`-only check would have let through.
 *
 * ## Why the degradations are not symmetric
 *
 * Each reader below answers with the value that is SAFE to act on when nothing
 * was established, and the three differ because the cost of being wrong differs:
 *
 *  - {@link readSessionPresenceIds} → `undefined` (absence NOT established), so
 *    the caller RETRIES. A wrong retry costs one more read; a wrong disposal
 *    costs the only copy of the data.
 *  - `readPersistedSyncState` → `null` (no cursor), so the lane falls back
 *    to a full backfill. That costs a corpus re-walk and loses nothing, whereas
 *    a half-trusted watermark silently skips rows that were never uploaded.
 *  - {@link readPendingSessionOutboxEngineState} → `undefined` (the budget was NOT
 *    read), so the resume FAILS and the lane abandons the pass. ISS-8594
 *    replaced its old `[]`: that degradation was indistinguishable from a
 *    healthy empty outbox, and continuing on it re-ran a mid-backoff row
 *    immediately, resetting the count and dodging the dead-letter cap.
 *
 * None of them throws, and none fabricates a value. Every rejection is reported
 * to `reportRejectedDbHostReply`, so a degradation that would otherwise be
 * indistinguishable from a healthy peer reaches the monitored facet — at most
 * once per op per throttle window, NOT once per rejection, because the resume
 * path re-issues its failing read on every 5s sync tick. That module's Cadence
 * section owns the reasoning and states what the window costs.
 *
 * ## The keys-covered guards
 *
 * {@link SESSION_OUTBOX_ENGINE_STATE_SHAPE} here and
 * `PERSISTED_SYNC_STATE_SHAPE` (the durable cursor reply, which ISS-10053 moved
 * with `readPersistedSyncState` into `persisted-sync-state-reply-boundary.ts`)
 * each carry `satisfies Record<keyof T, z.ZodTypeAny>`. That annotation is
 * load-bearing rather than decoration: it is what makes the NEXT field added to
 * either type a compile error here instead of a field that silently travels
 * unvalidated. `findExistingSessionIds` has no such guard because its reply is a
 * `string[]` — there are no keys to cover, and inventing an object wrapper to
 * have one would misdescribe the contract.
 */

import { z } from "zod";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { reportRejectedDbHostReply } from "../telemetry/db-host-reply-rejection.js";
import { DbHostRejectedReplyOp } from "../telemetry/telemetry-protocol.js";
import type {
  LocallyOversizedSessionRow,
  SessionOutboxEngineState,
} from "./agent-session-sync-source.js";

/**
 * One validator per field of {@link SessionOutboxEngineState}. The `satisfies` is what
 * makes an unmapped new field a compile error — see this file's header.
 *
 * The ISS-8617 durable counters default to zero so older db-host peers can omit
 * them, while the nullable fields stay nullable in the contract too: a row can
 * carry a budget with no scheduled deadline, no recorded reason class, and no
 * lane-wide stall in progress.
 *
 * `attemptCount` is an INTEGER, not merely a number: the column is
 * `attemptCount Int` (`prisma/schema.prisma`), and the retry budget is compared
 * against integer thresholds (`MAX_CONSECUTIVE_*`) and then incremented. A bare
 * `z.number()` admits `4.5`, which the next increment turns into `5.5` — enough
 * to cross a `>= 5` budget a whole attempt early and dead-letter a live row —
 * and admits a negative count, which seeds a budget that never reaches its
 * threshold at all. Both are silent: nothing downstream re-checks the shape.
 * `z.int()` also refuses NaN and any magnitude past `Number.MAX_SAFE_INTEGER`,
 * where `+ 1` stops changing the value. No upper DOMAIN bound is imposed: a
 * count above every threshold is not malformed, it is a row that has genuinely
 * exhausted its budget, and dead-lettering it is the correct terminal state.
 */
export const SESSION_OUTBOX_ENGINE_STATE_SHAPE = {
  id: z.string(),
  status: z.enum(Object.values(OutboxStatus)).optional(),
  attemptCount: z.int().nonnegative(),
  permanentAttemptCount: z.int().nonnegative().default(0),
  deadLetterRecoveryCount: z.int().nonnegative().default(0),
  ackOmittedCycleCount: z.int().nonnegative().default(0),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  laneStalledSince: z.string().nullable(),
} satisfies Record<keyof SessionOutboxEngineState, z.ZodTypeAny>;

/** Loose on purpose — see this file's header. */
const sessionOutboxEngineStateBoundarySchema = z.array(
  z.looseObject(SESSION_OUTBOX_ENGINE_STATE_SHAPE)
);

/** The ids reply is a bare `string[]`; there are no keys to cover. */
const sessionPresenceIdsBoundarySchema = z.array(z.string());

/**
 * Read the local-presence probe's answer out of whatever the delegate returned.
 *
 * Returns `undefined` — ABSENCE NOT ESTABLISHED — for every input that is not a
 * believable id list, and that is the whole point of the function. The caller
 * (`probeSessionPresence`) turns `undefined` into `ok: false`, which routes every
 * queued id to RETRY; an empty array, by contrast, is a positive claim that the
 * rows are gone and takes them down the disposal path.
 *
 * The two must never be conflated, and before this schema they could be. The
 * caller's own `presentIds === undefined` check did not catch `null`, and
 * `new Set(null)` is an EMPTY SET rather than a throw — so a peer that answered
 * `null` where this build expects `string[]` was read as "a probe ran and found
 * no row for any of them", which is `ConfirmedAbsent`, which dead-letters and
 * drops the rows. A non-iterable reply (`42`, `{}`) threw `TypeError` out of
 * `decideHydrationAbsence` instead, outside the probe's own try/catch. A string
 * reply was worse than both: `new Set("abc")` yields `{"a","b","c"}`, a silent
 * wrong answer with no fault at all.
 *
 * Never throws: a probe that could not be read must degrade to "unknown", which
 * is the answer that preserves the data.
 */
export function readSessionPresenceIds(
  value: unknown
): readonly string[] | undefined {
  const parsed = sessionPresenceIdsBoundarySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportRejectedDbHostReply({
    op: DbHostRejectedReplyOp.FindExistingSessionIds,
  });
  return undefined;
}

/**
 * Read the persisted retry budget out of whatever the delegate returned.
 *
 * Answers `undefined` — THE BUDGET WAS NOT READ — for every reply that is not a
 * believable row list, exactly as {@link readPendingOutboxIds} does for the
 * sibling read (ISS-8135). `[]` stays a POSITIVE answer: a healthy outbox with
 * nothing mid-backoff, which seeds nothing because there is nothing to seed.
 *
 * ISS-8594 overturned this reader's previous conclusion — that degrading an
 * unreadable reply to `[]` "costs a reset backoff, not data". It costs both,
 * because `[]` and "unreadable" were indistinguishable at the only caller. A row
 * that was mid-backoff at `attempt_count = 4` then carries no deadline to defer
 * it, is selected immediately, and its next rejection recomputes the count as
 * `1` — bypassing the persisted backoff AND the dead-letter cap, which is the
 * FEA-3659 bug shape reached through the error path. `resumeSessionOutboxEngineState`
 * now reports `undefined` as a failed read and the pass is abandoned.
 *
 * Rejects the WHOLE array rather than filtering to the rows that parse. A
 * partially-seeded retry budget is a worse answer than an unseeded one: the rows
 * that dropped out would resume on a fresh budget while their siblings resumed on
 * the persisted one, and nothing downstream could tell the two populations apart.
 *
 * Never throws. Before this schema the caller's try/catch covered only the
 * `await`, so a non-array reply threw out of `rehydrateSessionOutboxEngineState`'s
 * `for...of` — outside the guard — and took identity hydration down with it.
 */
export function readPendingSessionOutboxEngineState(
  value: unknown
): SessionOutboxEngineState[] | undefined {
  const parsed = sessionOutboxEngineStateBoundarySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportRejectedDbHostReply({
    op: DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState,
  });
  return undefined;
}

/* ================================================================== *
 * ISS-8135 — the three remaining sync-lane replies that SELECT or
 * CONDEMN durable work.
 *
 * Same criterion as the three ISS-8115 readers: a reply the main process branches on
 * to make a durable or destructive decision, where a wrong value is not
 * visible on any screen. Same loose-never-strict rule, same
 * never-throw rule, and the same asymmetric degradations — each reader
 * answers with the value that is safe to act on when nothing was
 * established, and "nothing was established" is deliberately NOT the
 * same value as a healthy empty answer wherever the caller can tell
 * them apart.
 * ================================================================== */

/** The pending-ids reply is a bare `string[]`; there are no keys to cover. */
const pendingOutboxIdsBoundarySchema = z.array(z.string());

/**
 * One validator per field of {@link LocallyOversizedSessionRow}. The `satisfies`
 * is what makes an unmapped new field a compile error — see this file's header.
 *
 * `payloadBytes` is validated to its DOMAIN rather than its `typeof`, the same
 * discipline the cursor and retry fields are held to: it is a
 * `TextEncoder`/`byteLength` COUNT, so a nonnegative integer is the only thing it
 * can be. That matters because this value is the sole input to a DESTRUCTIVE
 * decision and is then spent twice more — `formatBytes` puts it in the drop's log
 * line and `emitDeadLetterTelemetry` puts it on the wire as `payloadBytes`. A
 * negative or fractional size cannot describe a payload, so acting on one means
 * condemning a session on a number that was never a measurement (root AGENTS.md,
 * "Handling Bad or Nonsensical Data"). `z.int()` also refuses `NaN`, both
 * infinities, and any magnitude past `Number.MAX_SAFE_INTEGER`.
 *
 * No upper bound is imposed: a size above the cap is not malformed, it is
 * precisely the row this proof exists to name.
 */
export const LOCALLY_OVERSIZED_SESSION_ROW_SHAPE = {
  id: z.string(),
  payloadBytes: z.int().nonnegative(),
} satisfies Record<keyof LocallyOversizedSessionRow, z.ZodTypeAny>;

/** Loose on purpose — see this file's header. */
const locallyOversizedSessionsBoundarySchema = z.array(
  z.looseObject(LOCALLY_OVERSIZED_SESSION_ROW_SHAPE)
);

/** The re-enqueue verdict is a bare `boolean`; there are no keys to cover. */
const deadLetterReEnqueueBoundarySchema = z.boolean();

/**
 * Read the durable pending-outbox id list out of whatever the delegate returned.
 *
 * Returns `undefined` — THE OUTBOX WAS NOT READ — for every input that is not a
 * believable id list, and the distinction from `[]` is the whole point. `[]` is a
 * positive claim that nothing is owed to the cloud, and on the resume path that
 * claim COMPLETES the once-per-identity read: `requeueResumeOutboxIds` reports
 * success, the caller leaves the identity hydrated, and the un-acked prefix is
 * never selected again for the life of the process. Its only other door,
 * `reconcilePendingOutboxIfIdle`, is gated on `historicalBackfillEnabled` and so
 * is absent under `start({ historicalBackfill: false })`.
 *
 * Both callers already have a correct "not established" path and neither could
 * reach it before. The resume caller's `?? []` turned a `null` reply into that
 * completing empty claim, and a non-array reply reached
 * `feedIdsIntoBackfillQueue`'s `for...of` OUTSIDE the try that guards the await —
 * so the read that exists to un-strand rows threw out of hydration instead.
 *
 * Never throws: an outbox that could not be read must degrade to "unknown", which
 * is the answer that keeps the rows selectable.
 */
export function readPendingOutboxIds(value: unknown): string[] | undefined {
  const parsed = pendingOutboxIdsBoundarySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportRejectedDbHostReply({
    op: DbHostRejectedReplyOp.LoadPendingOutboxIds,
  });
  return undefined;
}

/**
 * Read the "is this row confirmed off `dead_lettered`" verdict out of whatever
 * the delegate returned.
 *
 * Degrades to `false` — NOT CONFIRMED — which is the answer the caller already
 * handles: the id stays in `deadLetteredIds` with its deadline and escalation
 * counters intact, and the next cap pass retries the hand-off. Nothing is
 * dropped and nothing is retried twice.
 *
 * ONLY `true` and `false` are accepted, and that is not pedantry. The consumer
 * is `releaseEvictedId`, whose gate is `if (!handedOff)` — a TRUTHINESS test. So
 * every truthy non-boolean the peer could answer (`{}`, `1`, `"ok"`, and `[]`,
 * which is truthy in JavaScript) read as a CONFIRMED hand-off and deleted the id
 * from `deadLetteredIds` plus its three counter maps. That map is the last
 * in-memory record of the session; if the durable row is in fact still
 * `dead_lettered` it is invisible to `loadPendingOutboxIds`, to stranded-row
 * adoption, and to the incremental scan, so the session is stranded for good.
 *
 * The dangerous direction here is the OPPOSITE of the ISS-8115 presence probe: a
 * `null` or `undefined` reply is falsy and was always safe. It is the truthy
 * non-boolean that destroyed data, so the schema refuses everything that is not
 * literally a boolean rather than merely coercing.
 *
 * Never throws: this sits inside a hand-off whose failure must stay recoverable.
 */
export function readDeadLetterReEnqueueConfirmation(value: unknown): boolean {
  const parsed = deadLetterReEnqueueBoundarySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportRejectedDbHostReply({
    op: DbHostRejectedReplyOp.ReEnqueueRecoveredDeadLetter,
  });
  return false;
}

/**
 * Read the local oversize proof out of whatever the delegate returned.
 *
 * Degrades to `[]` — NO SESSION IS PROVEN OVERSIZED — and here that genuinely is
 * the same value a healthy empty answer carries, because the caller does the
 * same thing with both: hydrate every candidate. Saying so is the point rather
 * than an omission. This reader's job is not an emptiness distinction the caller
 * cannot act on; it is refusing a malformed ROW, because a row is what condemns
 * a session. A `payloadBytes` of `null` passed the caller's own
 * `payloadBytes === undefined` "not oversized" test and went straight to
 * `deadLetterOversized`, which dequeues the session, marks it dead-lettered, and
 * emits the drop telemetry — a destructive decision taken on a value the peer
 * never actually measured.
 *
 * Rejects the WHOLE array rather than filtering to the rows that parse, for the
 * same reason {@link readPendingSessionOutboxEngineState} does: a partially-read proof
 * would condemn some sessions on trusted sizes while silently hydrating others
 * whose row was dropped, and nothing downstream could tell the two populations
 * apart. Degrading whole costs one hydrate per genuinely-large session, which the
 * downstream byte cap then dead-letters anyway — bounded, and on a measurement
 * this build made itself.
 *
 * `maxBytes` is the cap the caller ASKED about, and a row must clear it to be a
 * proof (codex review, #6041). The shape alone cannot establish that: the
 * producer's relation is `payloadBytes > maxBytes`
 * (`findSqliteLocallyOversizedSessions`) and the delegate contract says an
 * implementation "must only return an ID when the old full hydrate path would
 * also have locally dead-lettered it", so a row at or below the cap is a peer
 * contradicting its own contract, not a session to condemn. Without this check a
 * skewed peer answering `{ id, payloadBytes: 0 }` was condemned by the consumer,
 * which only tests whether the id is PRESENT in the returned map.
 *
 * Never throws.
 */
export function readLocallyOversizedSessions(
  value: unknown,
  maxBytes: number
): LocallyOversizedSessionRow[] {
  const parsed = locallyOversizedSessionsBoundarySchema.safeParse(value);
  if (
    parsed.success &&
    parsed.data.every((row) => row.payloadBytes > maxBytes)
  ) {
    return parsed.data;
  }
  reportRejectedDbHostReply({
    op: DbHostRejectedReplyOp.FindLocallyOversizedSessions,
  });
  return [];
}
