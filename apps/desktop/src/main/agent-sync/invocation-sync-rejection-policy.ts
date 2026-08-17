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
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import { DEAD_LETTER_RETRY_MAX_MS } from "./agent-session-sync-backoff-policy.js";

/** This lane's retry ladder: the base delay and the ceiling one delay may reach. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 15 * 60_000;

const PERMANENT_REJECTION_MAX_ATTEMPTS = 5;

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
 *    a healthy part on attempt one of its 100-attempt budget. This lane has no
 *    dead-letter recovery, so that part was simply gone (codex P1).
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
 * That constant caps ONE such delay — it is not a total recovery horizon (@wongk).
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
 * cycles outlives this budget, and because this lane has no dead-letter recovery
 * path (`main/sync/AGENTS.md` invariant 3's KNOWN EXCEPTION) the part is then
 * abandoned for good. Closing that gap is the only thing that removes the
 * exposure; a larger constant only moves it. Bounded-and-terminating is the
 * deliberate trade invariant 5 requires — and three days is a real bound, against
 * the two weeks the jammed part in the incident had been retrying.
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
 * How one rejection reason is charged: whether it may exhaust the row's budget at
 * all, and the ceiling it exhausts against.
 */
export type InvocationRejectionBudget = {
  permanent: boolean;
  maxAttempts: number;
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
 * PLN-1562: delegates to the shared {@link exponentialBackoffMs} ladder (FEA-3795)
 * instead of re-deriving `BASE * 2^n` inline.
 *
 * The `+ 1` is load-bearing and behavior-preserving: `attemptCount` here is the
 * count BEFORE this failure (0 on the first), whereas the shared ladder takes a
 * 1-indexed attempt number. `exponentialBackoffMs(n + 1, …)` is exactly
 * `min(BASE * 2^n, MAX)` — the identical schedule this computed before.
 */
export function retryDelayMs(attemptCount: number): number {
  return exponentialBackoffMs(attemptCount + 1, RETRY_BASE_MS, RETRY_MAX_MS);
}

/**
 * ISS-5789: has this part been retrying for longer than
 * {@link SESSION_MISSING_MAX_RETRY_AGE_MS}?
 *
 * An unparseable `created_at` returns false rather than a fabricated age. The row
 * then keeps retrying rather than being abandoned on the strength of a value the
 * lane could not read — and it is still not unbounded, because promotion supersedes
 * the row once a newer generation for the session lands. Guessing an age here
 * would discard data over a corrupt timestamp.
 */
export function hasOutlivedSessionMissingHorizon(
  createdAt: string,
  nowMs: number
): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return false;
  }
  return nowMs - createdMs >= SESSION_MISSING_MAX_RETRY_AGE_MS;
}

/**
 * ISS-5789: classify a rejection ack against the ROW it landed on, producing the
 * pair `decideOutboxFailure` needs. ONE lookup rather than a `permanent` predicate
 * beside a separate `maxAttempts` switch, so the two cannot drift out of step.
 *
 * `session_missing` is the one reason whose classification is not static: it is
 * transient — deferring on the shared ladder with the budget untouched — until the
 * row outlives its horizon, and terminal from then on. Every other reason is
 * decided by {@link REJECTION_BUDGETS} alone.
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
  return {
    permanent: hasOutlivedSessionMissingHorizon(input.createdAt, input.nowMs),
    maxAttempts: SESSION_MISSING_TERMINAL_ATTEMPTS,
  };
}
