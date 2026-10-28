/**
 * ISS-9812 (#6880 review) — bound `cron_secret_rejected` emission at the shared
 * `/cron/*` credential guard.
 *
 * WHY. `validateCronSecret` is the single guard in front of 27 `/cron/*` routes
 * and nothing sits in front of IT: the routes are publicly reachable, there is
 * no middleware, no `withAnyAuth`, and no rate limiter, so the caller driving
 * the rejection path is UNAUTHENTICATED. Emitting one warning plus one
 * `scheduleLogFlush()` per rejection therefore turns arbitrary scanner request
 * volume into proportional log records and Datadog intake calls — the flush
 * being the expensive half, since it is a network round trip per request.
 * `apps/api/AGENTS.md` ("Emission and Abuse Control"): bound emission at the
 * choke point and keep a bounded suppressed count. This is the "no limiter at
 * all" case rather than the "limiter is too loose" one, and it is a strictly
 * worse starting position than the two existing bindings, which at least sit
 * behind authentication.
 *
 * THE 401 IS DECIDED BEFORE THIS RUNS. The guard rejects, then asks this
 * whether to describe the rejection, and acts only on the returned decision, so
 * a throttling bug can never change an auth answer, a status code, or a body.
 *
 * THE KEY IS THE ROUTE PLUS THE HEADER-PRESENCE BIT, and neither part is
 * client-controlled text. `route` is the `logTag` literal the route file passes
 * — a closed set of 27 string constants that live in this repo, so an attacker
 * cannot mint a new key by varying a header, an IP, or a token. Keying on an
 * attacker-supplied value would have swapped one amplification vector
 * (emissions) for another (memory), which the root `AGENTS.md` bounded-growth
 * rule forbids. `authorizationHeaderPresent` is a BOOLEAN, so it multiplies the
 * keyspace by exactly two rather than opening it; it is in the key because it
 * is the bit that separates a scheduler holding a stale secret from a bare
 * probe, and a route-only key would let high-volume scanner traffic win the
 * window's single slot and mask the stale scheduler this ticket exists to
 * surface. Ceiling: 27 routes x 2 = 54 resident keys.
 *
 * WHAT THE SIGNAL IS WORTH AFTER THIS. The FIRST rejection of a key in a window
 * still emits, always — a genuine nightly failure is reported every window it
 * occurs in, which is what ISS-9812 asked for. What the bound removes is only
 * the 2nd..Nth duplicate within one minute, and those are not discarded: they
 * are counted and reported on the next emission for that key. A monitor must
 * therefore be written against "the event appeared for this route", not against
 * a raw per-request count — see ISS-9818.
 *
 * WHAT `suppressedSincePreviousEmission` IS WORTH (the same caveat #5508 put on
 * `session-ingestion-policy-denied-throttle.ts`). That count is materialised by
 * an EVENT, never a clock: the next rejection on the SAME key. This binding
 * deliberately does not wire `drainExpired`, because with no aggregate emitter
 * of its own a drain would DISCARD the pending count rather than report it —
 * leaving it pending is strictly more informative. So a burst followed by quiet
 * keeps its terminal window's count in process memory, and a serverless
 * instance that freezes first loses it. Read the field as an eventual lower
 * bound on suppressed volume, not as a census.
 *
 * This is the cron-guard binding of the shared {@link
 * FixedWindowEmissionThrottle}, which owns the windowing, the LRU keyspace cap,
 * and the flush-on-eviction guarantee. Same relationship
 * `session-ingestion-policy-denied-throttle.ts` and
 * `insights-section-latency-throttle.ts` have to that engine; the engine is not
 * reimplemented here.
 */

import { FixedWindowEmissionThrottle } from "./fixed-window-emission-throttle";

export const CRON_SECRET_REJECTED_WINDOW_MS = 60_000;

/**
 * Deliberately far below the engine's 10,000 default. The keyspace is closed at
 * 54 (27 route literals x the presence boolean), so this cap is unreachable in
 * production and exists as a hard second bound: if a future caller ever passed
 * a non-constant `route`, memory is still capped instead of growing with
 * attacker input.
 */
export const CRON_SECRET_REJECTED_MAX_ENTRIES = 64;

/** Composite-key delimiter. Route tags are bracketed literals with no `|`. */
const KEY_DELIMITER = "|";

/**
 * The emitted record's own identifying fields, carried through the throttle so
 * a rollup raised by an eviction could name what it is rolling up without
 * parsing the composite key back apart.
 */
export type CronSecretRejectionKeyParts = {
  /** The route's `logTag` literal, e.g. `"[cleanup-expired-sessions]"`. */
  route: string;
  authorizationHeaderPresent: boolean;
};

export type CronSecretRejectionThrottleDecision = {
  /** Whether THIS rejection emits its own record. True for the first per key per window. */
  emit: boolean;
  /** Rejections the just-closed window suppressed for this key; `0` when none. */
  flushedSuppressedCount: number;
};

export type CronSecretRejectionThrottleOptions = {
  windowMs?: number;
  maxEntries?: number;
};

/**
 * Per-(route, header-presence) fixed-window throttle for the rejection record.
 */
export class CronSecretRejectionThrottle {
  private readonly throttle: FixedWindowEmissionThrottle<CronSecretRejectionKeyParts>;

  constructor(options: CronSecretRejectionThrottleOptions = {}) {
    this.throttle =
      new FixedWindowEmissionThrottle<CronSecretRejectionKeyParts>({
        windowMs: options.windowMs ?? CRON_SECRET_REJECTED_WINDOW_MS,
        maxEntries: options.maxEntries ?? CRON_SECRET_REJECTED_MAX_ENTRIES,
      });
  }

  record(
    parts: CronSecretRejectionKeyParts,
    now: number
  ): CronSecretRejectionThrottleDecision {
    return this.throttle.record(
      `${parts.route}${KEY_DELIMITER}${String(parts.authorizationHeaderPresent)}`,
      parts,
      now
    );
  }

  /** How many keys are resident. The bound this class exists to hold. */
  get size(): number {
    return this.throttle.size;
  }

  clear(): void {
    this.throttle.clear();
  }
}

/**
 * Process-local shared throttle for the production guard. Ephemeral per
 * serverless instance by design (`apps/api/AGENTS.md`, "Serverless Routes and
 * State"): each instance bounds itself independently, so a fleet still reports
 * the failure while no single hot instance can be replayed into an unbounded
 * emit stream. Tests construct their own instance, or `clear()` this one.
 */
export const cronSecretRejectionThrottle = new CronSecretRejectionThrottle();
