/**
 * ISS-9824 — bound `cron_invocation_accepted` emission at the shared `/cron/*`
 * credential guard.
 *
 * WHY IT EXISTS AT ALL. The rejection binding next door
 * (`cron-secret-rejection-throttle.ts`) is an ABUSE bound: nothing gates
 * `/cron/*`, so an unauthenticated scanner drives that branch. This one is not
 * — reaching the success path requires the real `CRON_SECRET`, so request
 * volume here is Vercel's scheduler, not an attacker. What this bounds is
 * NOISE. The record is a per-route heartbeat whose only consumer asks whether
 * the scheduler still reaches this route with a valid secret, and at one record
 * per invocation the every-two-minutes cron alone would write 720 identical
 * lines a day that answer that question no better than one does.
 *
 * WHAT THE RECORD DOES NOT SAY. It is emitted by the credential guard, before
 * the route's own work runs, so it attests that the invocation was AUTHORIZED —
 * not that the cron's work then succeeded. A route that is reached and then
 * throws still emits it. That is the intended scope: the signal it completes is
 * "did the scheduler fire and get in", the half `cron_secret_rejected` cannot
 * express. Per-route success remains each route's own business.
 *
 * WHY THE KEY IS THE ROUTE ALONE. `route` is the `logTag` literal the route
 * file passes — a closed set of 27 string constants that live in this repo, so
 * no header, token, or IP can mint a key. Ceiling: 27 resident keys. The
 * rejection binding additionally keys on `authorizationHeaderPresent` because
 * there that bit separates a stale scheduler from a bare probe; on this path it
 * is necessarily `true`, so carrying it would add a constant to the payload and
 * double a keyspace for nothing.
 *
 * THE AUTH DECISION IS ALREADY MADE BEFORE THIS RUNS. The guard authorizes,
 * then asks this whether to describe the acceptance, and acts only on the
 * returned decision — a throttling bug can never change an auth answer, a
 * status code, or a body.
 *
 * WHAT THE SIGNAL IS WORTH AFTER THIS. The FIRST accepted invocation of a route
 * in a window always emits, so the monitor's real question — absence of the
 * event for a route — is preserved: a route that stops being accepted stops
 * emitting. What the bound removes is only the 2nd..Nth acceptance inside one
 * window, and those are counted rather than dropped. A monitor must therefore
 * be written against "the event appeared for this route", never against a raw
 * per-invocation count.
 *
 * THE ONE LATENCY THIS BUYS, STATED. The window is anchored to a key's first
 * occurrence, not to the wall clock, so a route that was accepted at T, failed
 * for a while, and RECOVERS at T+40min has that recovery folded into the window
 * opened at T — its "all clear" record waits until the window rolls. The bound
 * is therefore one window, under an hour. This is an accepted tradeoff, not an
 * oversight: 10 of the 27 guarded crons run once daily, so any absence-based
 * monitor built on this event needs a window of ~24h or more regardless, and a
 * sub-hour recovery lag cannot be mistaken for a still-failing route at that
 * scale. It replaces a recovery lag of up to ~48h. Never configure the absence
 * window at or near this window's length, where the lag WOULD be the signal.
 *
 * `suppressedSincePreviousEmission` carries the same caveat the sibling
 * bindings do: it is materialised by an EVENT (the next acceptance on the same
 * key), never by a clock, and this binding deliberately does not wire
 * `drainExpired` — with no aggregate emitter of its own a drain would DISCARD
 * the pending count rather than report it. Read it as an eventual lower bound.
 *
 * Serverless constraint (`apps/api/AGENTS.md`, "Serverless Routes and State"):
 * process-local and best-effort. Each instance folds independently, and an
 * instance that freezes between two invocations simply emits both — which errs
 * toward MORE heartbeats, never toward a silence the monitor would misread.
 *
 * This is the cron-acceptance binding of the shared {@link
 * FixedWindowEmissionThrottle}, which owns the windowing, the LRU keyspace cap,
 * and the flush-on-eviction guarantee. The engine is not reimplemented here.
 */

import { FixedWindowEmissionThrottle } from "./fixed-window-emission-throttle";

/**
 * An hour, not the rejection binding's minute. A minute would fold nothing that
 * matters: the busiest cron here runs every two minutes, so every invocation
 * would still open its own window and the 720-lines-a-day case this exists to
 * remove would survive intact. An hour folds the sub-hourly schedules while
 * still emitting far more often than any consumer needs — 10 of the 27 guarded
 * crons run once daily, so an absence monitor cannot use a window under ~24h
 * regardless, and an hourly heartbeat leaves that ~24 samples of headroom.
 */
export const CRON_INVOCATION_ACCEPTED_WINDOW_MS = 3_600_000;

/**
 * Deliberately far below the engine's 10,000 default. The keyspace is closed at
 * 27 route literals, so this cap is unreachable in production and exists as a
 * hard second bound: if a future caller ever passed a non-constant `route`,
 * memory is still capped instead of growing with caller input.
 */
export const CRON_INVOCATION_ACCEPTED_MAX_ENTRIES = 32;

/** The emitted record's own identifying field, carried through the throttle. */
export type CronInvocationAcceptedKeyParts = {
  /** The route's `logTag` literal, e.g. `"[cleanup-expired-sessions]"`. */
  route: string;
};

export type CronInvocationAcceptedThrottleDecision = {
  /** Whether THIS acceptance emits its own record. True for the first per route per window. */
  emit: boolean;
  /** Acceptances the just-closed window folded for this route; `0` when none. */
  flushedSuppressedCount: number;
};

export type CronInvocationAcceptedThrottleOptions = {
  windowMs?: number;
  maxEntries?: number;
};

/** Per-route fixed-window throttle for the acceptance heartbeat. */
export class CronInvocationAcceptedThrottle {
  private readonly throttle: FixedWindowEmissionThrottle<CronInvocationAcceptedKeyParts>;

  constructor(options: CronInvocationAcceptedThrottleOptions = {}) {
    this.throttle =
      new FixedWindowEmissionThrottle<CronInvocationAcceptedKeyParts>({
        windowMs: options.windowMs ?? CRON_INVOCATION_ACCEPTED_WINDOW_MS,
        maxEntries: options.maxEntries ?? CRON_INVOCATION_ACCEPTED_MAX_ENTRIES,
      });
  }

  record(
    parts: CronInvocationAcceptedKeyParts,
    now: number
  ): CronInvocationAcceptedThrottleDecision {
    return this.throttle.record(parts.route, parts, now);
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
 * Process-local shared throttle for the production guard, matching the
 * rejection binding's shape. Tests construct their own instance, or `clear()`
 * this one.
 */
export const cronInvocationAcceptedThrottle =
  new CronInvocationAcceptedThrottle();
