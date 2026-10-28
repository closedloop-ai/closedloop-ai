import { timingSafeEqual } from "node:crypto";
import { log } from "@repo/observability/log";
import { cronInvocationAcceptedThrottle } from "@/lib/observability/cron-invocation-accepted-throttle";
import { cronSecretRejectionThrottle } from "@/lib/observability/cron-secret-rejection-throttle";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Validates a `Authorization: Bearer <CRON_SECRET>` header on a cron route.
 *
 * Returns a `Response` to short-circuit the route when validation fails
 * (500 if `CRON_SECRET` is unset, 401 otherwise), or `null` when the request
 * is authorized and the route should proceed.
 *
 * `logTag` is the route prefix carried on the rejection and acceptance records,
 * e.g. `"[cleanup-expired-sessions]"`.
 */
export const validateCronSecret = (
  request: Request,
  logTag: string
): Response | null => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(`${logTag} CRON_SECRET is not configured`);
    scheduleLogFlush();
    return new Response("Internal Server Error", { status: 500 });
  }

  const presentedHeader = request.headers.get("authorization");
  const authHeader = presentedHeader ?? "";
  const expected = `Bearer ${cronSecret}`;
  // timingSafeEqual's precondition is equal BYTE length, and String.length
  // counts UTF-16 code units — a non-ASCII header can satisfy the second and
  // violate the first, making it throw. Compare the buffers themselves.
  const authBuffer = Buffer.from(authHeader);
  const expectedBuffer = Buffer.from(expected);
  const isValid =
    authBuffer.length === expectedBuffer.length &&
    timingSafeEqual(authBuffer, expectedBuffer);
  if (!isValid) {
    // The 401 is already decided. Everything below only DESCRIBES it, and the
    // clock is read here rather than above so nothing is added to the compared
    // path — the byte-length pre-check and timingSafeEqual are untouched.
    const authorizationHeaderPresent = presentedHeader !== null;
    // Nothing gates `/cron/*` — no middleware, no auth, no rate limiter — so an
    // unauthenticated scanner drives this branch at whatever rate it likes.
    // Emitting per rejection would make log volume and Datadog intake calls
    // proportional to attacker request rate across all 27 routes, so the record
    // is bounded per (route, header-presence) per window. The first rejection
    // in a window always emits, so a genuinely failing cron is still reported
    // every window it fails in; only intra-window duplicates are folded, and
    // they are counted rather than dropped.
    const decision = cronSecretRejectionThrottle.record(
      { route: logTag, authorizationHeaderPresent },
      Date.now()
    );
    if (decision.emit) {
      // `warn`, not the misconfig branch's `error`: any internet client can
      // reach this and an unauthenticated probe must not page. Matches every
      // other shared auth guard here (`*_rejected`, warn).
      // `authorizationHeaderPresent` is the one bit that separates a scheduler
      // holding a stale secret from a scanner sending none; nothing derived
      // from the presented or expected credential may join it.
      log.warn(CRON_SECRET_REJECTED_EVENT, {
        event: CRON_SECRET_REJECTED_EVENT,
        route: logTag,
        authorizationHeaderPresent,
        // Always present, including as `0`, so the monitor's log schema is
        // stable. `0` states that the window was fully observed.
        suppressedSincePreviousEmission: decision.flushedSuppressedCount,
      });
      // Without this the record is buffered and dies with the frozen function,
      // which is the silence this branch exists to end. Inside the `emit` guard
      // deliberately: the flush is the expensive half of the amplification, and
      // a suppressed rejection writes no record for it to carry.
      scheduleLogFlush();
    }
    return new Response("Unauthorized", { status: 401 });
  }

  recordCronInvocationAccepted(logTag);
  return null;
};

/**
 * Stable name a Datadog monitor keys on, duplicated into the payload because a
 * log-based query filters on the attribute rather than the message text.
 */
const CRON_SECRET_REJECTED_EVENT = "cron_secret_rejected";

export const CRON_INVOCATION_ACCEPTED_EVENT = "cron_invocation_accepted";

/**
 * ISS-9824. The rejection record above made a REJECTED invocation observable,
 * which left "the scheduler never fired" and "the scheduler fired, was
 * accepted, and the route did nothing" still indistinguishable — no `/cron/*`
 * route emits `request_completed`, because none of them goes through an auth
 * wrapper. This is the missing half: absence of BOTH records for a route now
 * means the scheduler is stale, and their combination is what lets the
 * ISS-9818 monitor become a composite instead of approximating with header
 * presence and repetition.
 *
 * `info`, not the rejection's `warn`: this is the outcome every scheduled tick
 * is supposed to have, so it is routine rather than actionable, and emitting it
 * at a level anything alerts on would make normal operation page.
 * `request_completed`, the repo's other success record, is `info` for the same
 * reason.
 *
 * Nothing derived from the presented or expected credential may join the
 * payload — the route tag is a literal from this repo, and it is the only
 * correlation the monitor needs.
 */
function recordCronInvocationAccepted(logTag: string): void {
  const decision = cronInvocationAcceptedThrottle.record(
    { route: logTag },
    Date.now()
  );
  if (!decision.emit) {
    return;
  }
  log.info(CRON_INVOCATION_ACCEPTED_EVENT, {
    event: CRON_INVOCATION_ACCEPTED_EVENT,
    route: logTag,
    // Always present, including as `0`, so the monitor's log schema is stable.
    suppressedSincePreviousEmission: decision.flushedSuppressedCount,
  });
  // Without this the record is buffered and dies with the frozen function: a
  // cron route can return with no awaited work, so nothing downstream is
  // guaranteed to flush it and the emit would be a production no-op.
  scheduleLogFlush();
}
