/**
 * ISS-8186: how much WORK one desktop-sync ingest request may do, stated once
 * and applied inside the service rather than at a transport.
 *
 * The wire is deliberately unbounded (ISS-8051 removed the cardinality caps
 * because a rejecting `.max()` dead-lettered every sibling batched with the
 * offender, forever). Nothing here restores a cap: a payload that validated
 * before still validates, and no session is ever refused for being one of too
 * many. What is bounded is the sequential database work a single request will
 * attempt before it hands the remainder back to the next request.
 *
 * WHY THE SERVICE AND NOT THE ROUTE. The byte budgets
 * (`readBoundedMaybeGzipJsonBody`, and the socket lane's `maxHttpBufferSize`)
 * are per-transport and measure the wrong thing: a reviewer measured ~10,000
 * otherwise-minimal sessions at about 31 KiB gzipped, which every byte ceiling
 * on either transport admits. Work is what runs long, and both transports —
 * the HTTP sync route and the direct Socket.IO event — funnel through
 * `upsertSessionsBatch`, so a bound expressed here is transport-neutral by
 * construction (whitlockk, #5990).
 *
 * WHY 20 SECONDS. Two external ceilings bracket the request, and the tighter
 * one wins: the sync route declares `maxDuration = 60`, and the desktop client
 * abandons the request at 30 s (`AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS`, which
 * lives in `apps/desktop` and cannot be imported from here). A client that gives
 * up never reads the ack, so the answer must be on the wire well before 30 s —
 * the budget has to leave room for the slice already in flight plus the
 * response.
 *
 * ELAPSED TIME ALONE IS NOT A BOUND (davetho, #6080). Asking only whether the
 * budget is ALREADY spent admits a slice at 19.9 s that may then run for its
 * full transaction timeout, putting the response past 30 s — the desktop
 * abandons it, reads no ack, and re-sends the committed prefix into the same
 * shape forever. That is the livelock this budget exists to prevent, reproduced
 * by the budget itself. So a slice is admitted only when the remaining deadline
 * can COVER it, and the transaction it opens is given that remaining deadline
 * rather than a fixed one. The reservation is the half of
 * `drainBranchMaterializationRetries`' `hasTimeForNextClaim` this module
 * originally left out: that predicate asks `elapsed + worst-case next unit <=
 * budget`, not `elapsed < budget`.
 *
 * THE MANDATORY FIRST SLICE IS DELIBERATELY EXEMPT, and stays on the unclamped
 * `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS`. It is what makes the remaining set
 * shrink at all, and a session whose own transaction genuinely needs longer than
 * this whole budget must still be allowed to commit: clamping it would turn
 * "commits, ack lost, data durable" into "fails, 500, nothing durable", which is
 * a strictly worse non-convergence. One indivisible unit of work cannot be
 * reserved for, only failed, so that residual exposure is unchanged here.
 *
 * WHY A CLOCK AND NOT A SESSION COUNT. A count does not bound work — one
 * session with thousands of events costs more than a hundred empty ones — and
 * any fixed count is a cap by another name. Elapsed time is the quantity the
 * function ceiling and the client timeout are actually denominated in. The same
 * choice, for the same reason, as `drainBranchMaterializationRetries`, which
 * pairs its claim limit with `hasTimeForNextClaim`.
 */

/**
 * Guardrails for each bounded per-session write slice; the pre-resolution reads
 * and the final target watermark run outside this transaction.
 *
 * They live here rather than beside their one call site because the reservation
 * below is DERIVED from them: a slice's worst-case wall clock is the time Prisma
 * may spend acquiring the connection PLUS the transaction's own deadline, and a
 * budget that reserved for only one of the two would still admit a slice it
 * cannot cover.
 */
export const AGENT_SESSION_UPSERT_TX_TIMEOUT_MS = 30_000;
export const AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS = 5000;

/**
 * The least time a deadline-clamped slice transaction may be given to do its
 * WRITE, once the acquisition allowance is set aside.
 *
 * A floor is load-bearing rather than tidy: without one, a slice reached with a
 * millisecond left would still be started, open a transaction only to abort it,
 * and be reported as a slice FAILURE — and the next iteration would do the same,
 * so a spent budget would produce an avalanche of doomed transactions instead of
 * a deferral. Set to the acquisition allowance itself: a transaction should get
 * at least as long to do its work as it is permitted to spend merely being
 * handed a connection.
 */
const MIN_SLICE_TRANSACTION_MS = AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS;

/** One ingest request's work allowance. Not a wire cap — see the module header. */
export const SessionIngestWorkBudget = {
  /**
   * Wall-clock a single request may spend STARTING per-session write
   * transactions. See the module header for why 20 s and not 30 or 60.
   */
  RuntimeMs: 20_000,
  /**
   * The least remaining runtime a NON-FIRST slice may be started with: enough
   * for the connection Prisma has yet to acquire and for the shortest write
   * deadline worth opening a transaction under. Below it the request hands the
   * rest of the batch to the next one.
   */
  SliceReserveMs:
    AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS + MIN_SLICE_TRANSACTION_MS,
  /**
   * Distinct branch identities one session's slice materializes INLINE, inside
   * its own write transaction.
   *
   * The branch lane awaits `ensureBranchArtifactRow` once per distinct identity
   * folded from that session's whole `artifactRefs` array, so its round-trip
   * count is the array's — the monitored-activity persist runs later, is
   * uncapped since ISS-9860, and bounds nothing here (whitlockk, #5990).
   * Overflow is not dropped: it is enqueued into ISS-8001's durable branch
   * materialization retry store and materialized by the cron drain.
   *
   * Matched to `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` (100) — the per-session
   * non-commit ref budget the shipping desktop already enforces — so a payload
   * any current producer emits never defers, and only a version-skewed or
   * hostile client reaches the deferral path at all.
   */
  BranchMaterializationsPerSession: 100,
} as const;

/**
 * What a request that started at `startedAtMs` may spend on the NEXT per-session
 * write transaction: either nothing, or a deadline the remaining budget covers.
 *
 * Takes the clock as an argument rather than reading `Date.now()` so callers can
 * drive it deterministically, matching `drainBranchMaterializationRetries`'
 * `readNowMs`. Tests must not assert on real elapsed time.
 *
 * The returned deadline is what makes the reservation honest. Prisma's `maxWait`
 * and `timeout` are separate clocks — acquisition is not charged against the
 * transaction's own deadline — so the quantity that has to fit inside the
 * remaining budget is their SUM, and the deadline handed back is what is left
 * after the acquisition allowance. `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` remains
 * the ceiling; this only ever shortens it.
 */
export function resolveSessionIngestSliceBudget(
  startedAtMs: number,
  nowMs: number
): SessionIngestSliceBudget {
  const remainingMs = remainingSessionIngestRuntimeMs(startedAtMs, nowMs);
  if (remainingMs < SessionIngestWorkBudget.SliceReserveMs) {
    return { defer: true };
  }
  return {
    defer: false,
    transactionTimeoutMs: Math.min(
      AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
      remainingMs - AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS
    ),
  };
}

/**
 * Runtime this request has left, clamped at BOTH ends.
 *
 * The clock is injected and, on a real host, is not guaranteed monotonic — so a
 * reading before `startedAtMs` must not manufacture a budget larger than the
 * allowance, and one long past it must not produce a negative that compares
 * below every threshold as if it were headroom.
 */
function remainingSessionIngestRuntimeMs(
  startedAtMs: number,
  nowMs: number
): number {
  const elapsedMs = nowMs - startedAtMs;
  return Math.min(
    SessionIngestWorkBudget.RuntimeMs,
    Math.max(0, SessionIngestWorkBudget.RuntimeMs - elapsedMs)
  );
}

/** Either "hand the rest of the batch to the next request", or a slice deadline. */
export type SessionIngestSliceBudget =
  | { defer: true }
  | { defer: false; transactionTimeoutMs: number };
