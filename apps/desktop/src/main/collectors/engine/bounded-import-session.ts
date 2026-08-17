import type {
  Importer,
  ImportResult,
} from "../../dashboard/agent-dashboard-db-types.js";
import { WriteQueueCancelOutcome } from "../../database/write-queue.js";
import type { Harness, NormalizedSession } from "../types.js";

/**
 * ISS-4410: default per-session bound for the historical import write. Generous
 * enough that a legitimately large single-session write (a long transcript's
 * event/token/artifact rows through the DB-host write queue, plus its throttled
 * WAL checkpoint) completes well within it, so the bound only ever fires when a
 * single session's write has genuinely wedged — a DB-host write that is accepted
 * but never completes — and would otherwise stall the entire boot import at the
 * first of N sessions. 2 minutes.
 */
export const HISTORICAL_IMPORT_SESSION_TIMEOUT_MS = 2 * 60_000;

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
 * A GENUINE rejection is propagated unchanged (wongk review, ISS-4410). The child
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
 * ISS-6115 (wongk review) — and it fires only when the deadline was spent on THIS
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
 * {@link classifyTimeoutCharge}.
 */
export function importSessionBounded(
  importer: Importer,
  log: (message: string) => void,
  session: NormalizedSession,
  harness: Harness,
  source: string,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<ImportResult> {
  return new Promise<ImportResult>((resolve, reject) => {
    let settled = false;
    const resolveTimedOut = (): void => {
      resolve({ skipped: false, reactivated: false, failed: true });
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      log(
        `historical import for session ${session.sessionId} (${harness}, ${source}) exceeded ${timeoutMs}ms and was skipped this pass; the source is left unmarked to retry on the next launch`
      );
      // ISS-4572: actively evict the wedged write from the head of the serialized
      // write queue so later sources proceed instead of parking behind it.
      // ISS-6115: that same eviction reports whether the write had DISPATCHED,
      // which is what decides if this timeout is chargeable to the source.
      // The trailing `.catch` is the last-resort settle, not decoration: the
      // `resolve` lives in the same handler as the budget hook, so a THROWING
      // `onTimeout` would otherwise leave this bound unsettled and wedge the
      // sweep on the very session it exists to move past.
      classifyTimeoutCharge(importer, session.sessionId, timeoutMs)
        .then((chargeable) => {
          if (chargeable) {
            onTimeout?.();
          }
          resolveTimedOut();
        })
        .catch(resolveTimedOut);
    }, timeoutMs);
    timer.unref?.();
    const finish = (result: ImportResult): void => {
      if (settled) {
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
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      Promise.resolve(importer.importSession(session, harness)).then(
        finish,
        fail
      );
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
 * own pre-queue work; and an absent hook, a throw, a rejection, or a silent host
 * carry no evidence at all. Charging is the conservative default — it preserves
 * the ISS-6115 budget exactly as it behaved before this distinction existed, so a
 * missing answer can never silently disable the budget.
 */
function classifyTimeoutCharge(
  importer: Importer,
  sessionId: string,
  timeoutMs: number
): Promise<boolean> {
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
    // Best-effort eviction — no evidence, so charge.
    return Promise.resolve(true);
  }
  if (typeof outcome === "string") {
    return Promise.resolve(isChargeableEviction(outcome));
  }
  // A DB-host eviction: wait for its answer, but never unboundedly. The backstop
  // timer is cleared the moment the answer arrives, so a healthy host leaves no
  // timer pending behind the resolved promise.
  const pending = outcome;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (chargeable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(chargeable);
    };
    timer = setTimeout(() => settle(true), IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS);
    timer.unref?.();
    pending.then(
      (settledOutcome) => settle(isChargeableEviction(settledOutcome)),
      () => settle(true)
    );
  });
}

/** True for every eviction outcome except a never-dispatched queue waiter. */
function isChargeableEviction(outcome: WriteQueueCancelOutcome): boolean {
  return outcome !== WriteQueueCancelOutcome.Queued;
}
