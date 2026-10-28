/**
 * @file invocation-sync-rejection-policy.ts
 * @description The invocation-parts lane's REJECTION POLICY: this lane's retry
 * ladder, and how each reject reason is charged — may it exhaust a row's budget at
 * all, and against what ceiling.
 *
 * Extracted from `agent-component-invocation-sync-service.ts` (ISS-5789) because
 * it is policy, not mechanism: the service decides WHEN to send and what to do
 * with an ack, this module decides what a failure COSTS. The service was already
 * past the 500-line smell before this ticket added to it, and the two concerns are
 * read against different contracts — the budgets against `main/sync/AGENTS.md`'s
 * invariants, the drain against the readiness gates.
 */

import {
  AgentComponentInvocationSyncRejectReason,
  type AgentComponentInvocationSyncRejectReason as InvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import {
  isSyncRetryBudgetSpent,
  SyncRetryBudgetKind,
} from "../../shared/sync-retry-budget.js";
import { AgentComponentInvocationSyncLocalError } from "./agent-component-invocation-sync-constants.js";
import { DEAD_LETTER_RETRY_MAX_MS } from "./agent-session-sync-backoff-policy.js";

/** This lane's retry ladder: the base delay and the ceiling one delay may reach. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 15 * 60_000;

export const PERMANENT_REJECTION_MAX_ATTEMPTS = 5;
export const INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES = 3;
export const INVOCATION_ACK_MISMATCH_REASON = "ack_mismatch" as const;
/** Legacy terminal causes recoverable by the durable dead-letter pass. */
export const InvocationRowRetryDeadLetterCause = {
  AckMismatch: INVOCATION_ACK_MISMATCH_REASON,
} as const;
export type InvocationRowRetryDeadLetterCause =
  (typeof InvocationRowRetryDeadLetterCause)[keyof typeof InvocationRowRetryDeadLetterCause];
export const InvocationDeadLetterRecoveryCause = {
  ValidationFailed: AgentComponentInvocationSyncRejectReason.ValidationFailed,
  PartConflict: AgentComponentInvocationSyncRejectReason.PartConflict,
  GenerationConflict:
    AgentComponentInvocationSyncRejectReason.GenerationConflict,
  AckMismatch: InvocationRowRetryDeadLetterCause.AckMismatch,
  EnvironmentalStallExhausted:
    AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted,
} as const;
export type InvocationDeadLetterRecoveryCause =
  (typeof InvocationDeadLetterRecoveryCause)[keyof typeof InvocationDeadLetterRecoveryCause];
export const INVOCATION_DEAD_LETTER_RECOVERY_CAUSES = Object.values(
  InvocationDeadLetterRecoveryCause
);

/**
 * ISS-5789 (PRD-634/PRD-635): how long a part may keep retrying a `session_missing`
 * rejection before the lane abandons it — the DISTINCT budget this one reason gets
 * instead of the ordinary permanent ceiling above.
 *
 * ## Why this reason needs its own budget
 *
 * `session_missing` is the one rejection in this enum that is NOT unambiguously
 * row-attributable, so `main/sync/AGENTS.md` invariant 4 forbids charging it like
 * `validation_failed`. Three different conditions produce it, and the lane cannot
 * tell them apart at the moment of the ack:
 *
 *  1. a genuine ORPHAN — the session lane deliberately withheld the parent (an
 *     FEA-3287 idle/phantom session), so the cloud will never have it. Permanent.
 *  2. an ORDERING RACE — the parent is substantive and on its way, but the two
 *     lanes tick independently and this part simply arrived first. Transient.
 *  3. the parent was dead-lettered upstream, and a later generation may still
 *     carry it.
 *
 * Only (1) is attributable to this row, so the budget is sized for the worst
 * TRANSIENT case rather than for (1).
 *
 * ## Why it is a DURATION and not an attempt count
 *
 * Two review findings, and one fix for both. It was an attempt count derived by
 * summing this lane's backoff ladder until the total passed the session lane's
 * `DEAD_LETTER_RETRY_MAX_MS`, and that construction was wrong twice over:
 *
 *  - it compared a duration to an attempt count through a hand-summed ladder, and
 *    the sum was off by one rung — `decideOutboxFailure` dead-letters ON attempt
 *    `N`, BEFORE scheduling attempt `N`'s backoff, so only delays `1 … N-1` are
 *    ever served. The 100-attempt budget therefore spanned 23h45m30s of real
 *    retrying, abandoning the part 14.5 minutes BEFORE the 24h horizon it existed
 *    to outlast (codex P2).
 *  - it charged that budget against the row's shared `attempt_count` column, which
 *    `recordRetry` also bumps on every TRANSIENT failure. Measured on this branch:
 *    a cloud too old to understand the protocol answering `unavailable` for 8.25
 *    hours drove `attempt_count` to 99, so the very FIRST `session_missing` —
 *    cause (2), the ordinary and entirely transient ordering race — dead-lettered
 *    a healthy part on attempt one of its 100-attempt budget. The age-budgeted
 *    path has no in-place recovery, so that part could be stranded.
 *
 * Expressing the budget as ROW AGE removes both. There is no ladder to sum, so
 * there is no off-by-one to make; and age is not the shared counter, so no amount
 * of lane-wide failure can pre-spend it — a row that first sees `session_missing`
 * ten minutes after it was created gets the full horizon no matter how many
 * transient attempts preceded it. Age is also monotone and nothing resets it,
 * which makes termination (invariant 5) unconditional rather than an argument.
 *
 * ## What it is sized against, and what it does NOT promise
 *
 * Cause (3)'s recovery clock belongs to the OTHER lane: a dead-lettered parent is
 * re-attempted by the session lane on its own progressive ladder
 * (`deadLetterRetryDelayMs`), doubling from 5 minutes and CAPPED at
 * {@link DEAD_LETTER_RETRY_MAX_MS} (24h).
 *
 * That constant caps ONE such delay — it is not a total recovery horizon (@whitlockk).
 * The session lane re-arms the ladder after every failed recovery cycle, so a
 * parent that keeps failing keeps being re-attempted, at up to 24h apart,
 * indefinitely; its cumulative horizon is UNBOUNDED. No finite budget can outlast
 * that, so this one deliberately does not claim to, and any comment saying
 * otherwise is wrong.
 *
 * What it DOES cover is the parent's whole ESCALATING ladder: three days spans the
 * parent's first ten recovery cycles (their delays sum to 66.6h), which is every
 * rung from the 5-minute first attempt through the first fully-capped 24h window.
 * A parent recovering at any rung of that escalation finds this part still trying.
 * Deriving the horizon from the other lane's cap — now in the SAME UNIT, which is
 * the confusion that produced the original bug — keeps the two from drifting apart
 * when either ladder is retuned. The "ISS-5789 session_missing horizon vs the
 * session lane's recovery ladder" describe block in
 * `test/invocation-sync-rejection-budget.test.ts` pins the relationship (that file
 * holds the block; there is no separate file named for it).
 *
 * What it does NOT cover, stated plainly: a parent that fails recovery past those
 * cycles outlives this budget, and the resulting age-budgeted dead letter is not
 * eligible for this lane's in-place recovery pass. Closing that gap belongs to the
 * re-materialization path, not to a larger constant. Bounded-and-terminating is
 * the deliberate trade invariant 5 requires — and three days is a real bound,
 * against the two weeks the jammed part in the incident had been retrying.
 */
export const SESSION_MISSING_MAX_RETRY_AGE_MS = 3 * DEAD_LETTER_RETRY_MAX_MS;

/**
 * `session_missing` is decided by row AGE, not by attempts, so once the horizon is
 * spent there is nothing left to count down: the next rejection is terminal.
 * `decideOutboxFailure` dead-letters when `attemptCount + 1 >= maxAttempts`, so 1
 * expresses exactly that, and the value is inert while the horizon holds because
 * `permanent` is false there.
 */
const SESSION_MISSING_TERMINAL_ATTEMPTS = 1;

/**
 * ISS-6209: how many attempts a row whose `created_at` is UNREADABLE gets before
 * the lane quarantines it — deliberately NOT
 * {@link SESSION_MISSING_TERMINAL_ATTEMPTS}.
 *
 * Terminal-on-the-first-ack is correct for `Outlived` because that row EARNED it:
 * it spent up to {@link SESSION_MISSING_MAX_RETRY_AGE_MS} — three real days —
 * retrying on the shared ladder while classified `Within`, and the horizon flipping
 * is the end of that grace, not the start. An unreadable timestamp has no such
 * history: the age simply cannot be computed, so collapsing both onto `1` would
 * give this row zero real retries and terminalize it on the very first
 * `session_missing` it ever sees.
 *
 * That matters because of WHICH cause is most common. Cause (2) above — the
 * ordering race, where a healthy part simply arrived before its substantive parent
 * — is the ordinary case, and it resolves on its own within a couple of backoff
 * rungs. A freshly-written part that races its parent AND happens to carry a
 * corrupt timestamp (a partial write, a hand-restored store) would otherwise be
 * dropped permanently on ack one, converting a self-healing transient into
 * unrecoverable loss. Under a SYSTEMIC corruption event — a bad migration touching
 * many rows at once, exactly what the header anticipates — that amplifies across
 * the whole affected set.
 *
 * Why an attempt count is acceptable here even though ISS-5789 removed one for
 * ordinary `session_missing`: that removal was possible because AGE is a strictly
 * better signal. For an unreadable row there IS no age to fall back on, so the
 * real choice is between "terminal now" and "terminal after up to this many more
 * row-local permanent attempts". The counter is separate from the environmental
 * retry ladder, so a lane-wide outage cannot pre-spend it. It stays bounded and
 * reachable while still buying the ordinary ordering race the grace it needs.
 *
 * Kept as its own constant rather than reusing `PERMANENT_REJECTION_MAX_ATTEMPTS`
 * by value so retuning the ordinary permanent ceiling cannot silently retune this
 * one — they are the same number today for different reasons.
 */
export const SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS = 5;

/**
 * How one rejection reason is charged: whether it may exhaust the row's budget at
 * all, and the ceiling it exhausts against.
 *
 * `sessionMissingHorizon` is carried ONLY for `session_missing` (it is `undefined`
 * for every other reason, whose classification is static). It exists so the caller
 * can tell the {@link SessionMissingRetryHorizon.InvalidTimestamp} quarantine apart
 * from an ordinary spent horizon — both are `permanent`, but only the first is a
 * BAD-DATA event that has to be reported rather than merely acted on (ISS-6209).
 */
export type InvocationRejectionBudget = {
  permanent: boolean;
  maxAttempts: number;
  sessionMissingHorizon?: SessionMissingRetryHorizon;
};

/**
 * What a reason costs when it is NOT attributable to the row: nothing. The
 * `maxAttempts` is inert on this branch — `decideOutboxFailure` reads it only
 * when `permanent` is true — but it is carried so the shape stays uniform.
 */
const TRANSIENT_REJECTION_BUDGET: InvocationRejectionBudget = {
  permanent: false,
  maxAttempts: PERMANENT_REJECTION_MAX_ATTEMPTS,
};

/**
 * Every reason, classified. A total `Record` rather than an if/else chain so that
 * adding an eighth member to `AgentComponentInvocationSyncRejectReason` fails
 * `tsc` until it is DELIBERATELY classified — the repo's exhaustive-mapper rule.
 * A silent fall-through to "transient" is precisely the defect ISS-5789 exists to
 * fix, and without this guard the next reason added would reintroduce it.
 *
 * `session_missing`'s entry is the STATIC half of its classification only; the
 * live decision is age-dependent and belongs to {@link rejectionBudgetForRow},
 * which is the only thing callers should use.
 */
const REJECTION_BUDGETS: Record<
  InvocationSyncRejectReason,
  InvocationRejectionBudget
> = {
  [AgentComponentInvocationSyncRejectReason.SessionMissing]: {
    permanent: true,
    maxAttempts: SESSION_MISSING_TERMINAL_ATTEMPTS,
  },
  [AgentComponentInvocationSyncRejectReason.ValidationFailed]: {
    permanent: true,
    maxAttempts: PERMANENT_REJECTION_MAX_ATTEMPTS,
  },
  [AgentComponentInvocationSyncRejectReason.PartConflict]: {
    permanent: true,
    maxAttempts: PERMANENT_REJECTION_MAX_ATTEMPTS,
  },
  [AgentComponentInvocationSyncRejectReason.GenerationConflict]: {
    permanent: true,
    maxAttempts: PERMANENT_REJECTION_MAX_ATTEMPTS,
  },
  [AgentComponentInvocationSyncRejectReason.ProtocolUnsupported]:
    TRANSIENT_REJECTION_BUDGET,
  [AgentComponentInvocationSyncRejectReason.IngestionFailed]:
    TRANSIENT_REJECTION_BUDGET,
  [AgentComponentInvocationSyncRejectReason.RateLimited]:
    TRANSIENT_REJECTION_BUDGET,
};

/**
 * ISS-6209: what a row's persisted `created_at` says about its `session_missing`
 * horizon. THREE states, not two, and the third is the whole point of the ticket.
 *
 * `created_at` is `NOT NULL` but it is a TEXT column, so a value `Date.parse`
 * cannot read is reachable at runtime — from a partial write, a store restored by
 * hand, or a migration that wrote a non-ISO shape. ISS-5789 folded that case into
 * "the horizon still holds", which read as a deliberate refusal to guess an age but
 * had a consequence it did not account for:
 *
 *  - the rejection stays TRANSIENT forever, so the row is never terminalized;
 *  - so the row stays `pending` on the target-scoped delivery queue forever;
 *  - so `loadBlockedInvocationDeliverySessionIds` reports that session as blocked
 *    on EVERY promotion pass, and `selectPromotableInvocationSessions` skips it;
 *  - so the newer generation that was supposed to supersede the corrupt row can
 *    never be promoted — the one escape ISS-5789's comment named as the reason
 *    unbounded retrying was acceptable here.
 *
 * The queue does not merely retry too long: it WEDGES for that session, permanently,
 * and the bad row is preserved rather than reported. Distinguishing the case is what
 * lets the lane quarantine it (invariant 5's terminal path stays reachable) without
 * fabricating an age it cannot know.
 */
export const SessionMissingRetryHorizon = {
  Within: "within",
  Outlived: "outlived",
  InvalidTimestamp: "invalid_timestamp",
} as const;
export type SessionMissingRetryHorizon =
  (typeof SessionMissingRetryHorizon)[keyof typeof SessionMissingRetryHorizon];

/**
 * ISS-6209: classify a row's `created_at` against
 * {@link SESSION_MISSING_MAX_RETRY_AGE_MS}, keeping "could not read it" a state of
 * its own rather than collapsing it into either readable answer.
 *
 * No age is invented for an unreadable value — the classification says the
 * timestamp is unusable, and {@link SESSION_MISSING_HORIZON_BUDGETS} decides
 * separately what that COSTS. Guessing an age would be the fabrication the repo's
 * bad-data rule forbids; treating it as fresh is the wedge described above.
 *
 * ISS-8566 widened WHICH values reach that third state, because `Date.parse` reading
 * a value is not the same as the value being this row's creation instant, and the
 * two ways it can differ fail in opposite directions:
 *
 *  - a FUTURE `created_at` (written while the machine clock ran forward, then
 *    corrected by NTP) makes the age NEGATIVE, so it can never reach the horizon and
 *    the row pins at `Within` — `permanent: false` forever, `pending` forever, and
 *    the same permanent promotion wedge ISS-6209 was filed for, reached by a
 *    readable value instead of an unreadable one.
 *  - an EPOCH `created_at` from a dead-RTC boot reads as decades old, so the very
 *    first `session_missing` ack terminalizes it on `Outlived`'s single-attempt
 *    budget — zero real retries, under a cause that says the lane retried long
 *    enough when it never retried at all.
 *
 * The past side is refused by a CALENDAR FLOOR and never by an age: a row that has
 * honestly waited a very long time is `Outlived`, not corrupt, and it keeps aging,
 * so any age band eventually claims it. See
 * {@link SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS}.
 *
 * Both are the SAME defect as an unreadable value — persisted data that cannot be
 * this row's age — so both take the state ISS-6209 already built and priced, and
 * nothing downstream needs to change to absorb them:
 * {@link SESSION_MISSING_TERMINAL_CAUSES} already names `InvalidTimestamp`
 * `CorruptCreatedAt`, and the store-integrity probe already counts that cause as a
 * `recent_quarantine` finding, so the row is unwedged AND reported. The budget is
 * {@link SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS} rather than `Outlived`'s
 * one, which is what buys the epoch row the real retries it never had.
 *
 * The band lives HERE and not in {@link isReadableRowTimestamp} deliberately. That
 * predicate's whole meaning is "`Date.parse` can read it", it is shared with the
 * integrity probe and the observation marker, and one of those callers has no clock
 * in scope to compare against — widening it would change what "corrupt" means for
 * three readers to fix one. This function already receives `nowMs`.
 */
export function classifySessionMissingRetryHorizon(
  createdAt: string,
  nowMs: number
): SessionMissingRetryHorizon {
  if (!isReadableRowTimestamp(createdAt)) {
    return SessionMissingRetryHorizon.InvalidTimestamp;
  }
  const createdMs = Date.parse(createdAt);
  if (!isPlausibleRowCreationInstant(createdMs, nowMs)) {
    return SessionMissingRetryHorizon.InvalidTimestamp;
  }
  // ISS-8615 (PRD-699 §7.3): the `Age` arm of the shared budget table. Same
  // comparison this branch always made, now spelled once for every lane that
  // budgets by elapsed time — and deliberately NOT the `Attempts` arm, because a
  // count here is the defect ISS-5789 removed: no number of transient failures
  // may pre-spend a horizon measured from the row's own creation instant.
  const outlived = isSyncRetryBudgetSpent(
    {
      kind: SyncRetryBudgetKind.Age,
      ageHorizonMs: SESSION_MISSING_MAX_RETRY_AGE_MS,
    },
    { attemptCount: 0, originMs: createdMs, nowMs }
  );
  if (outlived) {
    return SessionMissingRetryHorizon.Outlived;
  }
  return SessionMissingRetryHorizon.Within;
}

/**
 * What each horizon state costs. A total `Record` for the same reason
 * {@link REJECTION_BUDGETS} is one: a fourth horizon state must fail `tsc` until it
 * is deliberately priced, rather than falling through to whichever branch an
 * if/else happened to end on.
 *
 * `InvalidTimestamp` is TERMINAL, and that is a deliberate reversal of ISS-5789.
 * The row cannot be aged, so the bounded budget invariant 5 requires can never be
 * evaluated for it — and the escape hatch ISS-5789 relied on (a newer generation
 * superseding it) is precisely what an indefinitely-`pending` row disables. Between
 * "abandon one unreadable row" and "wedge that session's queue forever", invariant
 * 5 picks the first: it is bounded, it is reported, and it is the only one of the
 * two that lets the session's later data through.
 *
 * It is terminal on its OWN budget
 * ({@link SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS}) rather than on
 * `Outlived`'s, so the ordinary ordering race still gets real retries before the
 * lane gives up on it — see that constant for why the two must not share a number.
 */
const SESSION_MISSING_HORIZON_BUDGETS: Record<
  SessionMissingRetryHorizon,
  InvocationRejectionBudget
> = {
  [SessionMissingRetryHorizon.Within]: {
    permanent: false,
    maxAttempts: SESSION_MISSING_TERMINAL_ATTEMPTS,
  },
  [SessionMissingRetryHorizon.Outlived]: {
    permanent: true,
    maxAttempts: SESSION_MISSING_TERMINAL_ATTEMPTS,
  },
  [SessionMissingRetryHorizon.InvalidTimestamp]: {
    permanent: true,
    maxAttempts: SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS,
  },
};

/**
 * ISS-5789: classify a rejection ack against the ROW it landed on, producing the
 * pair `decideOutboxFailure` needs. ONE lookup rather than a `permanent` predicate
 * beside a separate `maxAttempts` switch, so the two cannot drift out of step.
 *
 * `session_missing` is the one reason whose classification is not static: it is
 * transient — deferring on the shared ladder with the budget untouched — while the
 * row sits inside its horizon, and terminal once it outlives it OR once its
 * `created_at` proves unreadable (ISS-6209). Those last two are both `permanent`
 * but they are NOT the same finding, so the horizon state is returned alongside the
 * budget: only the unreadable one is corrupt persisted data the caller must report.
 * Every other reason is decided by {@link REJECTION_BUDGETS} alone.
 *
 * The reasons deliberately left TRANSIENT, each for a stated cause rather than by
 * omission (the omission is what this ticket was filed for):
 *
 *  - `rate_limited` — a lane-wide condition, named verbatim by invariant 4 as a
 *    class that must never burn a row's budget.
 *  - `protocol_unsupported` — a version-SKEW signal, not a defect in this row's
 *    content. It is the ack-level twin of the bare HTTP 400 that
 *    `main/sync/AGENTS.md` records as deliberately lane-wide, because
 *    dead-lettering on it would walk the whole corpus forward on one side of a
 *    desktop/cloud skew and lose it. It resolves when either side upgrades.
 *  - `ingestion_failed` — a server-side processing failure. Nothing in it is
 *    reproducible from the persisted row, so invariant 4's "attributable to the
 *    item" test fails and it defers with the budget intact.
 *
 * The `hasOwn` guard is DEFENSE IN DEPTH, not the live cross-repo boundary. That
 * boundary is upstream, in the client: `isRejectReason` validates the wire value
 * against this same enum and fails the whole ack to a plain retry when a cloud
 * newer than this build sends a reason we have never heard of, and
 * `protocol_unsupported` is converted to `unavailable` earlier still. So an
 * unrecognized reason does not reach this function today. The guard earns its
 * place anyway: it costs one lookup, it keeps the classifier total for a future
 * caller wired up without that filter, and `hasOwn` (rather than a bare index)
 * stops a `__proto__`-shaped value resolving to an inherited property. Its
 * fallback is transient because a reason we cannot interpret is not one we can
 * attribute to the row.
 */
export function rejectionBudgetForRow(input: {
  reason: InvocationSyncRejectReason;
  createdAt: string;
  nowMs: number;
}): InvocationRejectionBudget {
  if (!Object.hasOwn(REJECTION_BUDGETS, input.reason)) {
    return TRANSIENT_REJECTION_BUDGET;
  }
  if (
    input.reason !== AgentComponentInvocationSyncRejectReason.SessionMissing
  ) {
    return REJECTION_BUDGETS[input.reason];
  }
  const horizon = classifySessionMissingRetryHorizon(
    input.createdAt,
    input.nowMs
  );
  return {
    ...SESSION_MISSING_HORIZON_BUDGETS[horizon],
    sessionMissingHorizon: horizon,
  };
}

export function isInvocationEnvironmentalRejectionReason(
  reason: InvocationSyncRejectReason
): boolean {
  if (!Object.hasOwn(REJECTION_BUDGETS, reason)) {
    return true;
  }
  return (
    reason !== AgentComponentInvocationSyncRejectReason.SessionMissing &&
    !REJECTION_BUDGETS[reason].permanent
  );
}

export function isInvocationDeadLetterRecoveryCause(
  cause: string | null
): boolean {
  return INVOCATION_DEAD_LETTER_RECOVERY_CAUSES.includes(
    cause as InvocationDeadLetterRecoveryCause
  );
}

/**
 * ISS-6209: can this lane read a row's persisted `created_at` at all?
 *
 * The ONE definition of "readable" for this lane, shared by the live classification
 * above and by the store-integrity check that reports the same corruption from the
 * other direction (`database/invocation-sync-outbox-integrity.ts`). Two copies of
 * `Number.isFinite(Date.parse(…))` would let the probe and the policy disagree about
 * which rows are corrupt — the probe reporting rows the lane happily retries, or
 * staying silent on rows the lane has already quarantined.
 */
export function isReadableRowTimestamp(createdAt: string): boolean {
  return Number.isFinite(Date.parse(createdAt));
}

/**
 * Which terminal CAUSE a `session_missing` dead-letter records as the row's
 * `last_error`, or `undefined` when that horizon state is not terminal at all.
 *
 * A total `Record` for the same reason {@link SESSION_MISSING_HORIZON_BUDGETS} is
 * one: a fourth horizon state must fail `tsc` until someone decides what it is
 * called on a parked row, rather than silently inheriting whichever cause an
 * if/else happened to end on. The two are deliberately separate maps — the budget
 * decides WHETHER the lane gives up, this decides what it calls the giving-up.
 *
 * `Within`'s entry is TOTALITY ONLY and is unreachable at runtime today: `Within`
 * is priced `permanent: false`, `decideOutboxFailure` reaches its dead-letter
 * branch only when `permanent` is true, and this map is consulted only from inside
 * that branch. It is `undefined` so that a future state priced as terminal cannot
 * quietly inherit an abandonment cause it did not earn — not because a within-
 * horizon row is expected to arrive here. No test covers that entry, deliberately;
 * a test of an unreachable branch is one that cannot fail.
 */
const SESSION_MISSING_TERMINAL_CAUSES: Record<
  SessionMissingRetryHorizon,
  AgentComponentInvocationSyncLocalError | undefined
> = {
  [SessionMissingRetryHorizon.Within]: undefined,
  [SessionMissingRetryHorizon.Outlived]:
    AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
  [SessionMissingRetryHorizon.InvalidTimestamp]:
    AgentComponentInvocationSyncLocalError.CorruptCreatedAt,
};

/**
 * ISS-5855: the `last_error` a dead-lettered part carries, given the horizon state
 * that terminalized it — the ack reason when the lane has no cause of its own to
 * name.
 *
 * `horizon` is `undefined` for every reason other than `session_missing`
 * (`validation_failed`, `part_conflict`, `generation_conflict`), whose ack reason
 * IS the whole story: the cloud attributed the failure to this row's content and
 * there is nothing local to add. Only `session_missing` has a local cause that the
 * ack reason cannot express, because the same ack reason is carried by every row
 * still healthily deferring inside its horizon.
 */
export function terminalCauseForRejection(input: {
  ackReason: string;
  horizon: SessionMissingRetryHorizon | undefined;
}): string {
  if (input.horizon === undefined) {
    return input.ackReason;
  }
  return SESSION_MISSING_TERMINAL_CAUSES[input.horizon] ?? input.ackReason;
}

/**
 * ISS-8566: how far AHEAD of the reading clock a row's `created_at` may sit and
 * still be aged.
 *
 * Sized for benign disagreement between the clock that WROTE the row and the clock
 * reading it — an NTP correction landing between the insert and the ack — and not
 * for a machine that genuinely ran days fast, which is the case the bound exists to
 * refuse. Minutes rather than days is what makes it a bound at all: a tolerance wide
 * enough to admit a real forward-clock row would restore the wedge it is here to
 * close.
 *
 * Minutes, and the same reasoning, wherever this lane bounds a timestamp at both
 * ends, so two surfaces do not conclude different things about the identical
 * class of clock error.
 */
export const SESSION_MISSING_FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * ISS-8566: the past-side companion — a CALENDAR FLOOR, deliberately not an age.
 *
 * A dead-RTC boot persists `1970-01-01T00:00:00.000Z`, which `Date.parse` reads
 * perfectly and which ages as decades. Nothing about that row is old; the clock that
 * stamped it was wrong, which is the same corruption an unreadable value carries.
 *
 * The first cut of this bound was an age — "older than a year is corrupt" — and it
 * was wrong, because AGE ALONE CANNOT DISTINGUISH THE TWO (review, ISS-8566). A
 * pending row can honestly survive a long offline period, and however long it waits
 * it is still `Outlived`: old, terminal on the horizon it really did outlive, and not
 * a quarantine finding. An age band eventually swallows that population no matter
 * where its edge sits, because the row keeps aging into it.
 *
 * An absolute floor cannot: this lane, its table and this application did not exist
 * before 2020, so a stamp below it is a clock that was never set, whatever the
 * reading clock says. A row parked for five years still classifies `Outlived`,
 * byte-identically to today.
 */
export const SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS = Date.parse(
  "2020-01-01T00:00:00.000Z"
);

/**
 * Could this instant be a real row's creation? The two ends are asymmetric ON
 * PURPOSE: how far AHEAD of the reading clock a stamp may sit is a question about
 * skew, so it is relative; how far back it may sit is a question about when this
 * lane existed, so it is absolute. Both are exclusive bounds.
 */
function isPlausibleRowCreationInstant(
  createdMs: number,
  nowMs: number
): boolean {
  return (
    createdMs > SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS &&
    nowMs - createdMs > -SESSION_MISSING_FUTURE_SKEW_TOLERANCE_MS
  );
}
