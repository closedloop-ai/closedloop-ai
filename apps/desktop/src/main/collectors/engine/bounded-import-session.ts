import type {
  Importer,
  ImportResult,
} from "../../dashboard/agent-dashboard-db-types.js";
import { isDurableImportProgress } from "../../dashboard/agent-dashboard-db-types.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
} from "../../database/write-queue.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import type { Harness, NormalizedSession } from "../types.js";

/**
 * ISS-4410 / ISS-4572: run one historical `importSession` under a wall-clock
 * bound. Only the TIMEOUT is treated specially: if the write does not settle
 * within `timeoutMs`, this resolves to a synthetic `failed` result so the caller
 * advances past the source (the ISS-4476 isolate path leaves it unmarked, so it
 * retries next boot) instead of the whole boot import wedging on the first of N
 * sessions. A resolve/reject that arrives after the bound is harmless — the timer
 * is cleared on settle and the late result is ignored via the `settled` flag.
 *
 * ISS-4572 — on timeout the bound also ACTIVELY EVICTS THIS session's own wedged
 * write via `evictInFlightWrite` (see that helper). ISS-4410 abandoned only the
 * caller's promise, but the underlying `db.write` stayed queued on the single
 * serialized write queue, so a genuinely-wedged write (accepted, never completing)
 * parked every later source behind it. When the importer exposes
 * `cancelInFlightWrite` (the SQLite importer wired to the write queue's
 * TASK-SCOPED eviction), the timeout calls it with the timed-out `sessionId` so
 * the queue evicts THAT session's task specifically — never an unrelated healthy
 * session's transaction that merely happens to be running — and the tail advances
 * so later sources' writes dispatch. The evicted write's own promise is still
 * abandoned (left to settle on its own); eviction only stops it BLOCKING the
 * sweep. The hook is best-effort and topology-safe: in DB-host mode it is a proxy
 * op returning a Promise the helper swallows, so a dying DB host can never surface
 * an unhandled rejection in main; an importer without the hook degrades to the
 * prior abandon-only behavior.
 *
 * A GENUINE rejection is propagated unchanged (whitlockk review, ISS-4410). The child
 * importer already returns `failed` for session-local errors, while the
 * main-process proxy REJECTS for DB-host transport and lifecycle failures.
 * Swallowing those rejections into `failed` would turn a persistent host failure
 * into a per-remaining-source retry storm instead of aborting the harness pass as
 * the pre-ISS-4410 unbounded path did. We keep that abort behavior for real
 * rejections and reserve the synthesize-`failed`/continue path for the timeout
 * alone. Both a synchronous throw and an async rejection route through the same
 * cleanup so a sync throw cannot leave the timer running to log a bogus timeout.
 *
 * ISS-6115 — `onTimeout` fires on the TIMEOUT branch and on nothing else. The
 * synthetic `{ failed: true }` this branch resolves is indistinguishable at the
 * call site from the importer's OWN `failed` result for a session-local error
 * (the FK-parent gate on a mis-owned agent-id collision), so a caller that wants
 * to charge a retry budget for "this source burned a whole deadline and produced
 * nothing" cannot read it off the result. It is a callback rather than a richer
 * return type so a genuine rejection stays a rejection: it aborts the harness
 * pass by design, and must never be charged as an attempt.
 *
 * ISS-6115 (whitlockk review) — and it fires only when the deadline was spent on THIS
 * session's OWN work. This bound's clock starts at CALL time, which is BEFORE the
 * import reaches the single serialized writer, so a session queued behind another
 * harness's wedged transaction can burn the entire bound without its write ever
 * dispatching. Charging that waiter a retry-budget attempt would quarantine a
 * perfectly healthy transcript for a wedge that belonged to a different session —
 * and with one poison write parked at the queue head, every concurrently-queued
 * source is such a waiter, so the budget would converge on the wrong victims en
 * masse. The parse bound draws exactly this line with its dispatch-scoped clock
 * (ISS-4572), and `createImportGroupWriter` draws it per record group (ISS-6003).
 * Here the answer comes from the eviction itself, which is already issued on this
 * branch and now reports whether the evicted task had DISPATCHED — see
 * {@link classifyTimeoutEviction}.
 *
 * ISS-7257 — and the deadline expiring is NOT the same fact as the write having
 * failed. `importSession` reports which record groups committed only when it
 * RETURNS, which on this branch is necessarily after the bound gave up, so the
 * settle ISS-4410 discarded is the only evidence of durable completion there is.
 * The timeout branch now waits {@link IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS} for
 * it, but only where {@link evictionLeftWriteIntact} proves nothing was cancelled,
 * and marks on nothing weaker than the importer's own COMPLETE result. An
 * unproven, partial, or evicted write takes the unchanged timeout path: marking a
 * half-committed source strands it far more permanently than re-importing a whole
 * one.
 *
 * ISS-7256 — the call-time clock ISS-6115 described is now acted on rather than
 * only compensated for. ISS-6115 stopped CHARGING a never-dispatched waiter's
 * retry budget but still ended its attempt; the source was left unmarked and
 * re-parsed and re-imported in full on the next pass, forever. The deadline
 * therefore asks {@link Importer.hasUndispatchedWrite} where this session's
 * write stands and grants it more waiting while it is still only QUEUED, up to
 * {@link undispatchedRearmBudgetMs} in total. A DISPATCHED write — the wedge
 * ISS-4410 built this for — is untouched, and so is an ABSENT one, which is
 * ISS-6115's `None`: a deadline spent on this session's own pre-queue work.
 *
 * ISS-10401 — the store-side import now yields the store thread's loop before
 * each of its record groups (`write-core.ts`), so a listing read queued behind
 * it is served BETWEEN groups. Three consequences for this bound, none of them
 * removed here and all of them accepted with that change:
 *
 *   - "This session's OWN work" now includes the foreign reads served at those
 *     gaps. The call-time clock spans them, so an import interleaving with a
 *     long read (one hydration chunk per gap) can reach the deadline on work
 *     that is not its own.
 *   - A yield gap is a steady state with NO task of this session's queued or
 *     running. A deadline landing in one is probed `Absent` — not `Queued`, so
 *     no re-arm — and its eviction classifies `None`: graced for
 *     {@link IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS}, then CHARGED as ISS-6115's
 *     pre-queue case even though the import is mid-flight with real work left.
 *   - In DB-host mode the eviction is itself an `Execute` that lands at the next
 *     loop turn — no longer after the whole import, but at the next gap, where
 *     nothing of this session's is queued. It therefore almost always answers
 *     `None` and evicts nothing: the import runs to completion and seals while
 *     main has already resolved `failed` and left the source unmarked for an
 *     idempotent re-import next pass. The bound has never stopped the
 *     store-side import; the import-health telemetry tick (5 min) still covers
 *     the worst case measured there.
 *
 * Closing that false positive means a dispatch state the mirror can answer for
 * a live import between groups, plus a change to the "moved `taskSeq` ends the
 * extension" rule below — a redesign of this bound, tracked as ISS-10654, not
 * part of ISS-10401. The tail is three charges and a quarantined source, so it
 * is a ticket and not only this paragraph.
 *
 * Two properties of that question are load-bearing, and both come from review:
 *
 *   - It must be answerable BY THE DISPATCHER (whitlockk). The deadline fires
 *     because the store thread is inside a long synchronous write, so a probe
 *     that has to reach that thread is answered only once the condition it asks
 *     about has ended — it waits out
 *     {@link IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS}, reports nothing, and the
 *     production topology drops the waiter exactly as before. The write queue
 *     therefore PUSHES its transitions out to the dispatcher, which answers this
 *     op from that mirror. See `database/db-host/write-dispatch-mirror.ts`.
 *   - The answer is consumed LATER than it was computed (davetho), so a grant
 *     must not rest on it alone: the grant is sliced at
 *     {@link UNDISPATCHED_REARM_REVALIDATE_MS} and re-probed, and a probe whose
 *     `taskSeq` has moved ends the extension. See
 *     {@link createUndispatchedRearmBudget}.
 */
export function importSessionBounded(
  importer: Importer,
  log: (message: string) => void,
  session: NormalizedSession,
  harness: Harness,
  source: string,
  timeoutMs: number,
  onTimeout?: () => void,
  /**
   * ISS-12036: the deadline was spent behind a DIFFERENT session's write, so the
   * synthetic `failed` this bound resolves is not this source's failure to land.
   * The complement of `onTimeout` over the same classification — exactly one of
   * the two fires on an expired deadline — and the reason it is a second
   * callback rather than a field on the result is that the result is already
   * documented as indistinguishable from the importer's own `failed`.
   */
  onUndispatchedTimeout?: () => void,
  /** ISS-12552: the policy the session was parsed under. */
  parsePolicy?: ParsePolicy
): Promise<ImportResult> {
  return new Promise<ImportResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const rearm = createUndispatchedRearmBudget(timeoutMs);
    const late = createLateSettleWatch();
    const resolveTimedOut = (): void => {
      resolve({ skipped: false, reactivated: false, failed: true });
    };
    const onDeadline = (): void => {
      if (settled) {
        return;
      }
      // ISS-7256: before treating this deadline as spent, check whether it was
      // spent WAITING. A write that has never dispatched did not wedge the writer
      // and did not burn the window on its own work, so ending the attempt costs a
      // full re-parse and re-import next pass and buys nothing.
      probeUndispatchedWrite(importer, session.sessionId)
        .then((probe) => {
          if (settled) {
            return;
          }
          const grantedMs = rearm.grant(probe);
          if (grantedMs === null) {
            expire();
            return;
          }
          log(
            `historical import for session ${session.sessionId} (${harness}, ${source}) reached its bound without its write dispatching; waiting another ${grantedMs}ms (${rearm.spentMs()}/${rearm.budgetMs()}ms granted)`
          );
          timer = setTimeout(onDeadline, grantedMs);
          timer.unref?.();
        })
        .catch(expire);
    };
    const expire = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      // ISS-4572: actively evict the wedged write from the head of the serialized
      // write queue so later sources proceed instead of parking behind it.
      // ISS-6115: that same eviction reports whether the write had DISPATCHED,
      // which is what decides if this timeout is chargeable to the source.
      // The trailing `.catch` is the last-resort settle, not decoration: the
      // `resolve` lives in the same handler as the budget hook, so a THROWING
      // `onTimeout` would otherwise leave this bound unsettled and wedge the
      // sweep on the very session it exists to move past.
      classifyTimeoutEviction(importer, session.sessionId, timeoutMs)
        .then(async (outcome) => {
          const committed = await late.awaitDurableCompletion(
            outcome,
            timeoutMs
          );
          if (committed) {
            log(
              `historical import for session ${session.sessionId} (${harness}, ${source}) exceeded ${timeoutMs}ms but its write COMMITTED durably; the source is treated as imported`
            );
            resolve(committed);
            return;
          }
          log(
            `historical import for session ${session.sessionId} (${harness}, ${source}) exceeded ${timeoutMs}ms and was skipped this pass; the source is left unmarked to retry on the next launch`
          );
          if (isChargeableEviction(outcome)) {
            onTimeout?.();
          } else {
            onUndispatchedTimeout?.();
          }
          resolveTimedOut();
        })
        .catch(resolveTimedOut);
    };
    timer = setTimeout(onDeadline, timeoutMs);
    timer.unref?.();
    const finish = (result: ImportResult): void => {
      if (settled) {
        // ISS-7257: the bound already tripped; this late report is what it reads.
        late.note(result);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A genuine importSession failure — an async rejection OR a synchronous throw
    // before the returned promise exists — is NOT the wedge this bound guards
    // against. Propagate it unchanged so the pre-ISS-4410 abort behavior stands
    // for real DB-host failures. Routing both through this one handler also
    // guarantees the timer is cleared and `settled` set on a sync throw, so the
    // timer can never later log a spurious timeout for an already-failed session.
    const fail = (error: unknown): void => {
      if (settled) {
        late.note(null);
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      Promise.resolve(
        importer.importSession(session, harness, parsePolicy)
      ).then(finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * ISS-6115: how long the timeout branch will wait for a DB-host eviction to
 * report back before giving up and charging the attempt.
 *
 * The eviction answer is only needed to decide whether this timeout is chargeable
 * to the source's retry budget, so waiting on it is worth a bounded pause but
 * never an unbounded one: the write usually wedged BECAUSE the DB host is
 * unhealthy, and an `invoke` issued to a dying child can hang rather than reject.
 * An unbounded wait there would re-wedge the very sweep the ISS-4410 bound exists
 * to keep moving. Small next to the 120s bound it follows, and generous next to a
 * healthy IPC round trip (single-digit milliseconds).
 *
 * ISS-8246 M1 did NOT retire this bound, and PLN-1837 M3 was wrong to say it
 * would. The db-host dispatcher stays responsive during a long statement now,
 * but the write queue this eviction targets moved to the STORE thread with the
 * rest of the runtime, and the request reaches it as an ordinary `Execute`
 * message on the inner port — picked up only when that thread's loop turns.
 * While the store is inside a synchronous import, an eviction therefore waits
 * exactly as it did before the split, and this backstop is what keeps the sweep
 * moving. `db-host-invoke-dispatch.test.ts` pins that there is no
 * dispatcher-side answer for it.
 */
export const IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS = 5000;

/**
 * ISS-4572 / ISS-6115: best-effort TASK-SCOPED eviction of the timed-out
 * session's own write, safe on both importer topologies, reporting whether this
 * timeout should be CHARGED to the source's retry budget.
 *
 * `cancelInFlightWrite` is OPTIONAL and its return type is
 * `WriteQueueCancelOutcome | Promise<WriteQueueCancelOutcome>`: the in-process
 * SQLite importer evicts synchronously, but in DB-host mode (FEA-2038) the
 * importer is the `createDbHostAgentDatabase` PROXY, which answers the property
 * path and forwards the call as an IPC `invoke` — returning a promise that only
 * settles once the child evicts that session's queue task. The write usually
 * wedged BECAUSE the DB host is unhealthy (db-host-worker's recurring exit-code-5
 * OOM restarts), so that invoke can be issued to a dying child and REJECT or
 * simply never answer. Every one of those paths is handled here, and none of them
 * can reject or hang this promise: a peer-process failure must never crash the
 * Electron main process, nor stall the sweep.
 *
 * Only ONE outcome is not chargeable — {@link WriteQueueCancelOutcome.Queued}, an
 * evicted task that had never been dispatched, so the whole bound was spent
 * waiting behind a DIFFERENT session's transaction. Everything else charges:
 * `Running` is this session's own wedged write; `None` means no write of this
 * session was queued or running at the deadline, so it burned the window on its
 * own pre-queue work; and `null` — a throw, a rejection, or a host silent past the
 * backstop — carries no evidence at all. Charging is the conservative default — it
 * preserves the ISS-6115 budget exactly as it behaved before this distinction
 * existed, so a missing answer can never silently disable the budget.
 *
 * ISS-7257: an ABSENT hook reports `None` rather than `null`, which is not a
 * convenience. `null` means an eviction was issued and its answer was lost, so it
 * may have taken a victim; no hook means no eviction was ever issued, so the write
 * is provably untouched. {@link evictionLeftWriteIntact} needs those apart.
 */
function classifyTimeoutEviction(
  importer: Importer,
  sessionId: string,
  timeoutMs: number
): Promise<WriteQueueCancelOutcome | null> {
  let outcome: WriteQueueCancelOutcome | Promise<WriteQueueCancelOutcome>;
  try {
    outcome =
      importer.cancelInFlightWrite?.(
        sessionId,
        new Error(
          `historical import for session ${sessionId} evicted after ${timeoutMs}ms`
        )
      ) ?? WriteQueueCancelOutcome.None;
  } catch {
    return Promise.resolve(null);
  }
  if (typeof outcome === "string") {
    return Promise.resolve(outcome);
  }
  // A DB-host eviction: wait for its answer, but never unboundedly. The backstop
  // timer is cleared the moment the answer arrives, so a healthy host leaves no
  // timer pending behind the resolved promise.
  const pending = outcome;
  return new Promise<WriteQueueCancelOutcome | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (settledOutcome: WriteQueueCancelOutcome | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(settledOutcome);
    };
    timer = setTimeout(() => settle(null), IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS);
    timer.unref?.();
    pending.then(settle, () => settle(null));
  });
}

/**
 * True for every eviction outcome except a never-dispatched queue waiter. `null`
 * is "no evidence" (a throw, a rejection, or a silent DB host) and charges,
 * exactly as it did before the outcome was carried rather than collapsed to a
 * boolean — a missing answer must never silently disable the ISS-6115 budget.
 * An ABSENT hook is not a `null` source: it reports `None`, which also charges
 * here; {@link evictionLeftWriteIntact} is where the two must stay apart.
 */
function isChargeableEviction(
  outcome: WriteQueueCancelOutcome | null
): boolean {
  return outcome !== WriteQueueCancelOutcome.Queued;
}

/**
 * ISS-7257: how long the timeout branch will wait for the abandoned import to
 * report what it actually did, once the eviction has established that nothing of
 * this session's is holding the writer.
 *
 * Small next to the 120s bound, and enormous next to the microtask a write that
 * already committed needs to deliver its result — though since ISS-10401 the
 * `None` it graces on can also be an import still running its remaining groups
 * between yields, which the window may or may not cover. It is capped at the bound itself
 * ({@link durableSettleGraceMs}) so the grace can never be a material extension of
 * the deadline it follows.
 */
export const IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS = 2000;

function durableSettleGraceMs(timeoutMs: number): number {
  return Math.min(IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS, timeoutMs);
}

/**
 * ISS-7257: did the eviction PROVE it took no victim? Only then can the abandoned
 * write still be committing, and only then is waiting on it meaningful.
 *
 * `None` is that proof: no task of this session's was queued or running, so the
 * eviction cancelled nothing. It is also what an absent hook reports, which is
 * proof of the same thing for the stronger reason that no eviction was issued.
 * Since ISS-10401 it is ALSO what a live import parked between two record
 * groups reports (see the header): intact, but not finished, and racing the
 * grace below with its remaining groups plus whatever reads interleave.
 *
 * `null` is NOT the same claim and must not be read as one. It means the eviction
 * was issued and its answer never came back — a throw, a rejection, or a host that
 * went silent past {@link IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS}. In DB-host mode
 * that invoke may have been delivered and EXECUTED with only the reply lost, so
 * the write may well have been cancelled mid-flight. A cancelled write can still
 * return a result carrying neither `failed` nor `incomplete` (`write-core.ts` runs
 * `activity_metrics` outside `runGroup` deliberately), so gracing on `null` would
 * let a cancelled import be marked as a complete one — the half-committed source
 * this bound must never seal.
 */
function evictionLeftWriteIntact(
  outcome: WriteQueueCancelOutcome | null
): boolean {
  return outcome === WriteQueueCancelOutcome.None;
}

/**
 * ISS-7257: a result that proves the session is FULLY written — the distinction
 * the ticket turns on, between "durably committed" and merely "finished inside the
 * deadline". {@link isDurableImportProgress} is the canonical predicate and is
 * reused rather than restated, but it is true of an `incomplete` import too: that
 * one committed only some of its record groups and must stay unmarked for retry,
 * and must still spend the budget so a source that always half-commits after its
 * deadline cannot retry forever.
 */
function durableCompletion(result: ImportResult | null): ImportResult | null {
  if (result && isDurableImportProgress(result) && result.incomplete !== true) {
    return result;
  }
  return null;
}

/**
 * ISS-7257: holds the settle the ISS-4410 bound used to discard, so the timeout
 * branch can read it after the eviction has reported. A result noted before the
 * grace is even asked for is answered without arming a timer at all.
 */
function createLateSettleWatch(): {
  note(result: ImportResult | null): void;
  awaitDurableCompletion(
    outcome: WriteQueueCancelOutcome | null,
    timeoutMs: number
  ): Promise<ImportResult | null>;
} {
  let noted = false;
  let recorded: ImportResult | null = null;
  let waiter: ((result: ImportResult | null) => void) | null = null;
  return {
    note(result: ImportResult | null): void {
      noted = true;
      recorded = result;
      waiter?.(result);
    },
    awaitDurableCompletion(
      outcome: WriteQueueCancelOutcome | null,
      timeoutMs: number
    ): Promise<ImportResult | null> {
      if (!evictionLeftWriteIntact(outcome)) {
        return Promise.resolve(null);
      }
      if (noted) {
        return Promise.resolve(durableCompletion(recorded));
      }
      return new Promise<ImportResult | null>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        const settle = (result: ImportResult | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          waiter = null;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          resolve(durableCompletion(result));
        };
        waiter = settle;
        timer = setTimeout(() => settle(null), durableSettleGraceMs(timeoutMs));
        timer.unref?.();
      });
    },
  };
}

/**
 * ISS-7256: how many extra `timeoutMs` windows the bound will grant a session
 * whose write is still only WAITING in the serialized queue.
 *
 * Measured against the ticket's own case: a 267 KB / 17-event rollout imports in
 * 24–27 ms of real work on a store seeded to 2,000 sessions (flat from 100 to
 * 2,000), while production reported 12–20 s per import and 62 sessions past the
 * 120 s bound. That gap is queue wait, not work, and a never-dispatched write is
 * the WAITER rather than the wedge — evicting it advances nothing and costs the
 * source a full re-parse and re-import on the next pass.
 *
 * Bounded rather than open-ended because "still waiting" is not proof the queue
 * is healthy: a starved session must still reach a terminal outcome, and the
 * ISS-4410 guarantee that the sweep moves on is what the ceiling preserves. Total
 * wall clock is therefore `(1 + this) × timeoutMs`. A DISPATCHED write — the wedge
 * the bound was built for — is unaffected and still trips at `timeoutMs`.
 */
export const MAX_UNDISPATCHED_IMPORT_BOUND_REARMS = 2;

/**
 * ISS-7256: how long a single granted window lasts before the bound RE-ASKS.
 *
 * The re-arm is a poll, and a poll's answer is a point-in-time fact consumed
 * later (davetho review): the dispatcher can observe a task queued, the head
 * can settle and dispatch it, and only then does the `queued` answer reach main.
 * Acting on that stale answer hands a now-dispatched wedge a whole extra
 * deadline, weakening the ISS-4410 guarantee it is supposed to leave alone.
 *
 * Slicing the grant bounds that exposure to ONE slice instead of one full bound,
 * because the next slice re-probes and a dispatched write expires immediately.
 * The total extra wall clock is unchanged — {@link undispatchedRearmBudgetMs}
 * still caps it — so this buys race-safety without buying the starved session
 * any more time. Affordable only because ISS-7256's probe is answered by the
 * DISPATCHER out of a mirror rather than by a round trip to a blocked store
 * thread; against the old forwarded probe this cadence would have been absurd.
 */
export const UNDISPATCHED_REARM_REVALIDATE_MS = 5000;

/**
 * ISS-7256: total extra wall clock a waiting session may be granted, as
 * {@link MAX_UNDISPATCHED_IMPORT_BOUND_REARMS} further deadline windows.
 *
 * Expressed as a total rather than a count of re-arms because the grant is now
 * sliced: what must stay bounded is the TIME, not the number of times the bound
 * looked.
 */
function undispatchedRearmBudgetMs(timeoutMs: number): number {
  return timeoutMs * MAX_UNDISPATCHED_IMPORT_BOUND_REARMS;
}

/**
 * ISS-7256: decides, at each deadline, whether the session has earned another
 * slice of waiting — and refuses on every ground that means it has not.
 *
 * Three separate refusals, because they are three different facts:
 *
 *   - The probe does not say `Queued`. `Dispatched` is the ISS-4410 wedge, which
 *     this feature must leave exactly as it was. `Absent` is ISS-6115's `None`:
 *     no write of this session's is at the writer, so the deadline went on its
 *     own pre-queue work. `null` is no evidence at all.
 *   - The probed task CHANGED (davetho review). Two consecutive `queued`
 *     answers do not mean nothing happened: a task can dispatch, settle, and be
 *     followed by the next record group's task, and the owner reads `queued`
 *     both times having written a whole group in between. `taskSeq` is what
 *     tells those apart, and a moved one ends the extension — the session is
 *     making progress on the writer, so it is spending its deadline on its own
 *     work and the ISS-4410 premise holds again.
 *   - The budget is spent. A starved write must still reach a terminal outcome.
 */
function createUndispatchedRearmBudget(timeoutMs: number): {
  /** ms to wait, or `null` to expire now. */
  grant(probe: WriteDispatchProbe | null): number | null;
  spentMs(): number;
  budgetMs(): number;
} {
  const budget = undispatchedRearmBudgetMs(timeoutMs);
  let spent = 0;
  let observedTaskSeq: number | null = null;
  return {
    grant(probe: WriteDispatchProbe | null): number | null {
      if (probe?.state !== WriteDispatchState.Queued) {
        return null;
      }
      if (observedTaskSeq !== null && probe.taskSeq !== observedTaskSeq) {
        return null;
      }
      observedTaskSeq = probe.taskSeq;
      const remaining = budget - spent;
      if (remaining <= 0) {
        return null;
      }
      const slice = Math.min(
        remaining,
        timeoutMs,
        UNDISPATCHED_REARM_REVALIDATE_MS
      );
      spent += slice;
      return slice;
    },
    spentMs: () => spent,
    budgetMs: () => budget,
  };
}

/**
 * ISS-7256: ask the importer where this session's write stands, on either
 * topology and without ever rejecting.
 *
 * Mirrors {@link classifyTimeoutEviction}'s handling of the DB-host proxy: the
 * in-process importer answers synchronously, the proxy returns a promise, and a
 * throw, a rejection, or a host silent past
 * {@link IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS} all resolve `null`. `null` is the
 * conservative answer — {@link createUndispatchedRearmBudget} refuses on it — so
 * a missing answer can never extend a deadline.
 *
 * The backstop is retained even though the DB-host answer no longer depends on
 * the store thread (`write-dispatch-mirror.ts`): the DISPATCHER can also die,
 * and an `invoke` to a dying child can hang rather than reject.
 */
function probeUndispatchedWrite(
  importer: Importer,
  sessionId: string
): Promise<WriteDispatchProbe | null> {
  let answer: WriteDispatchProbe | Promise<WriteDispatchProbe> | undefined;
  try {
    answer = importer.hasUndispatchedWrite?.(sessionId);
  } catch {
    return Promise.resolve(null);
  }
  if (answer === undefined) {
    // No hook: the pre-ISS-7256 behavior, where a deadline always ends the
    // attempt. Distinct from `null` only in provenance; both refuse a grant.
    return Promise.resolve(null);
  }
  if (!(answer instanceof Promise)) {
    return Promise.resolve(answer);
  }
  const pending = answer;
  return new Promise<WriteDispatchProbe | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (value: WriteDispatchProbe | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(value);
    };
    timer = setTimeout(() => settle(null), IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS);
    timer.unref?.();
    pending.then(settle, () => settle(null));
  });
}
