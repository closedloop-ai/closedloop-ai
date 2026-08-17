"use client";

/**
 * Gateway detection store -- manages the cached detection state.
 *
 * Uses useSyncExternalStore for React integration. The store itself
 * is framework-agnostic; the React hook is a thin wrapper.
 *
 * Probing costs one loopback request per port in `PROBE_PORTS`, and with no
 * desktop app running every one of them is refused. The browser's own network
 * stack logs each refusal (`net::ERR_CONNECTION_REFUSED`); that log is emitted
 * below JS, so no `try`/`catch`, `.catch()`, or error boundary can suppress it.
 * The only way to not produce it is to not issue the request. This store is
 * therefore built to *stop* probing once it has a confirmed negative, and to
 * resume only on a real signal -- never on a timer.
 *
 * ISS-6084 closes the remaining hole in that design: stopping after one sweep
 * still charged EVERY visitor one sweep per page load, including the majority
 * who have never installed the desktop app, so production consoles showed four
 * refused loopback requests on every navigation. An `ambient` loop -- the
 * background bootstrap mounted on every authenticated page -- now issues no
 * request at all unless there is durable evidence this user actually has a
 * desktop app. See {@link isGatewayProbePermitted} for the two signals and how
 * a first-ever detection still bootstraps.
 */

import { useEffect, useSyncExternalStore } from "react";
import { probeGateway } from "./gateway-probe";
import { getStorageItem, removeStorageItem, setStorageItem } from "./storage";
import type { GatewayDetectionState } from "./types";

const CACHE_TTL_MS = 60_000;
/**
 * Durable "a desktop gateway has been detected in this browser before" marker.
 *
 * Written on the first successful probe and never cleared by a later absence:
 * the question it answers is "is it worth looking here at all?", and a desktop
 * app that is merely closed right now does not change that answer. Versioned
 * so the shape can change without misreading an old value.
 *
 * Deliberately device-scoped rather than user- or org-scoped, and the stored
 * value is a bare `"1"` -- no port, machine name, gateway id, or token. On a
 * shared browser the marker therefore outlives the account that earned it, so a
 * second user signing in on the same machine may ambient-probe once even though
 * their own account-level signal says nothing. That is the accepted tradeoff:
 * the cost is the same handful of refused loopback requests this gate accepts
 * for any browser that has genuinely seen a gateway, it discloses nothing about
 * the first user, and every real dispatch is still authorized server-side by
 * the gateway. Scoping the key per user would instead re-probe for the SAME
 * person on every account switch, which is the louder failure.
 */
const GATEWAY_SEEN_STORAGE_KEY = "closedloop-gateway-seen:v1";
const GATEWAY_SEEN_STORAGE_VALUE = "1";
// Responsive cadence used only while a desktop gateway is present, so a
// capability/version change or the gateway going offline is picked up promptly.
const DETECTED_POLL_INTERVAL_MS = 10_000;
/**
 * Absent-sweep budget for ambient web probing (every surface except onboarding).
 *
 * One sweep. A user with the desktop app running is detected by it; a user
 * without one has answered the question, and asking again on a timer only
 * reproduces the unsuppressable refused-request log. Past the budget the poll
 * loop arms no timer at all and detection resumes only on a re-arm signal.
 */
const AMBIENT_MAX_ABSENT_SWEEPS = 1;
/**
 * Absent-sweep budget for `fastPoll` callers (the onboarding desktop-setup
 * flow), where the user is actively installing the desktop app on the very
 * screen that is watching for it. ~2 minutes of responsive retry, then the same
 * hard stop; window refocus and the explicit re-check both re-arm from there.
 */
const FAST_POLL_MAX_ABSENT_SWEEPS = 12;
/**
 * Absent-sweep budget granted after the gateway was actually seen.
 *
 * The ambient budget of 1 answers "is a desktop app running here?" for a user
 * who never had one. It must NOT be applied to a gateway that was detected and
 * then went quiet for a single sweep -- a desktop self-update, a machine
 * sleep/resume, or one dropped probe would otherwise stop detection for good
 * while the app is still running, and every consumer would report not-detected
 * until the user happened to refocus the tab. A user who really did quit the
 * app still converges: once this budget is spent the ambient rule takes over
 * again, so the total cost of a genuine shutdown is a few sweeps, not forever.
 */
const RECOVERY_MAX_ABSENT_SWEEPS = 3;
/**
 * Re-arm debounce. A focus/visibility signal is a *user* signal, not a timer, so
 * it is allowed to restart detection -- but a user alternating between the
 * browser and another app would otherwise turn every switch back into a sweep.
 * Each consecutive re-arm that still finds nothing doubles the minimum gap from
 * {@link REARM_BASE_INTERVAL_MS} up to {@link REARM_MAX_INTERVAL_MS}; a
 * successful detection resets it.
 */
const REARM_BASE_INTERVAL_MS = 30_000;
const REARM_MAX_INTERVAL_MS = 30 * 60_000;
/** Caps the doubling above, so the attempt counter cannot grow without bound. */
const REARM_MAX_ATTEMPTS = 8;

const DEFAULT_STATE: GatewayDetectionState = {
  detected: false,
  loading: true,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

let snapshot: GatewayDetectionState = DEFAULT_STATE;
let expiresAt = 0;
let inFlight: Promise<GatewayDetectionState> | null = null;
/**
 * Consecutive sweeps that came back absent. Module-level on purpose: several
 * components mount the hook at once, and a per-loop counter would let each of
 * them spend its own budget, multiplying the refused requests by the number of
 * mount sites.
 */
let absentSweeps = 0;
/**
 * Live `fastPoll` loops.
 *
 * The absent budget is a property of the loop that is actually running, not of
 * whoever is rendering, so a render site must not restate it. Counted rather
 * than flagged because ambient and onboarding loops coexist: the onboarding
 * step raises the budget for as long as it is mounted, and disposal has to put
 * it back. Read by {@link isGatewayDetectionExhausted}.
 */
let fastPollLoops = 0;
let rearmAttempts = 0;
/**
 * Whether a gateway was seen recently enough that a run of absent sweeps should
 * be treated as a blip to recover from rather than a confirmed negative. Cleared
 * once {@link RECOVERY_MAX_ABSENT_SWEEPS} is spent, so a real shutdown converges
 * on the ambient rule instead of buying a fresh recovery budget every re-arm.
 */
let sawGateway = false;

const listeners = new Set<() => void>();
/**
 * Poll loops that want to be handed the result of an explicit re-arm so they can
 * resume their cadence. Entries are added by {@link startGatewayDetectionPolling}
 * and removed by its disposer, so the set is bounded by the number of mounted
 * consumers.
 */
const resumeHandlers = new Set<(result: GatewayDetectionState) => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getGatewayDetectionSnapshot(): GatewayDetectionState {
  return snapshot;
}

export function subscribeGatewayDetection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function recordProbeOutcome(detected: boolean): void {
  if (detected) {
    absentSweeps = 0;
    rearmAttempts = 0;
    sawGateway = true;
    rememberGatewaySeen();
    return;
  }
  absentSweeps = Math.min(absentSweeps + 1, FAST_POLL_MAX_ABSENT_SWEEPS + 1);
  if (sawGateway && absentSweeps >= RECOVERY_MAX_ABSENT_SWEEPS) {
    sawGateway = false;
  }
}

export function ensureGatewayDetection(options?: {
  force?: boolean;
}): Promise<GatewayDetectionState> {
  if (globalThis.window === undefined) {
    return Promise.resolve({
      ...DEFAULT_STATE,
      loading: false,
    });
  }

  const now = Date.now();
  if (!options?.force) {
    if (snapshot.checkedAt && now < expiresAt) {
      return Promise.resolve(snapshot);
    }
    // A confirmed negative does not expire. Without this, the TTL alone would
    // re-probe on every remount and route change -- a page navigated around for
    // an hour would keep re-emitting the refused loopback requests. Only a
    // forced probe (the poll loop, still inside its budget) or an explicit
    // re-arm refreshes it.
    if (absentSweeps > 0) {
      return Promise.resolve(snapshot);
    }
  }
  if (inFlight) {
    return inFlight;
  }

  if (!snapshot.checkedAt) {
    snapshot = { ...snapshot, loading: true };
    emitChange();
  }

  inFlight = probeGateway()
    .then((result) => {
      const checkedAt = Date.now();
      snapshot = {
        ...result,
        loading: false,
        checkedAt,
      };
      expiresAt = checkedAt + CACHE_TTL_MS;
      recordProbeOutcome(result.detected);
      emitChange();
      return snapshot;
    })
    .catch(() => {
      const checkedAt = Date.now();
      snapshot = {
        detected: false,
        loading: false,
        port: null,
        version: null,
        machineName: null,
        gatewayId: null,
        capabilities: null,
        onboardingCompleted: null,
        checkedAt,
      };
      expiresAt = checkedAt + CACHE_TTL_MS;
      recordProbeOutcome(false);
      emitChange();
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

const DISABLED_STATE: GatewayDetectionState = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

/** Consecutive absent sweeps recorded so far, for cadence decisions and tests. */
export function getAbsentSweepCount(): number {
  return absentSweeps;
}

/**
 * Delay before the next probe, or `null` to stop probing entirely.
 *
 * Detected -> responsive cadence (pick up capability/offline changes promptly).
 *
 * Absent -> the caller gets a bounded number of sweeps
 * (`AMBIENT_MAX_ABSENT_SWEEPS`, or `FAST_POLL_MAX_ABSENT_SWEEPS` when `fastPoll`
 * is set for the onboarding flow) and then `null`: the loop arms no timer and
 * detection is over until a re-arm signal arrives. A slower cadence would not
 * do -- a page left open would still emit refused loopback requests forever,
 * just less often.
 */
export function getNextProbeDelayMs(
  result: GatewayDetectionState,
  options?: { fastPoll?: boolean; absentSweeps?: number; recovering?: boolean }
): number | null {
  if (result.detected) {
    return DETECTED_POLL_INTERVAL_MS;
  }
  const sweeps = options?.absentSweeps ?? 0;
  if (sweeps < resolveAbsentBudget(options)) {
    return DETECTED_POLL_INTERVAL_MS;
  }
  return null;
}

/** Absent-sweep allowance for this caller, highest applicable budget wins. */
function resolveAbsentBudget(options?: {
  fastPoll?: boolean;
  recovering?: boolean;
}): number {
  if (options?.fastPoll) {
    return FAST_POLL_MAX_ABSENT_SWEEPS;
  }
  if (options?.recovering) {
    return RECOVERY_MAX_ABSENT_SWEEPS;
  }
  return AMBIENT_MAX_ABSENT_SWEEPS;
}

/**
 * Whether a gateway was seen recently enough to still be worth recovering.
 *
 * Read by the poll loop so a detected gateway that goes quiet gets the recovery
 * budget instead of the one-sweep ambient rule.
 */
export function isRecoveringGatewayDetection(): boolean {
  return sawGateway;
}

/** Minimum gap between focus/visibility-driven re-arms, backing off as they fail. */
export function getRearmIntervalMs(): number {
  return Math.min(
    REARM_BASE_INTERVAL_MS * 2 ** rearmAttempts,
    REARM_MAX_INTERVAL_MS
  );
}

/** Whether a re-arm signal should be honored, or debounced away. */
export function canRearmGatewayDetection(): boolean {
  if (snapshot.checkedAt === null) {
    return true;
  }
  return Date.now() - snapshot.checkedAt >= getRearmIntervalMs();
}

/**
 * Explicitly restart detection after it has stopped.
 *
 * This is the only way back once the absent budget is spent: a user action (the
 * onboarding "Check again" control), or a window focus/visibility signal that
 * clears {@link canRearmGatewayDetection}. It clears the remembered negative,
 * probes once, and hands the result to every mounted poll loop so a gateway that
 * has since appeared is picked up on the responsive cadence again.
 *
 * Pass `userInitiated` for the explicit "Check again" control. That path already
 * bypasses the debounce, so charging it an attempt would only slow the *passive*
 * focus re-arm -- a user who clicks the button several times would push the
 * focus debounce toward its 30-minute cap as a side effect of asking more often.
 */
export function rearmGatewayDetection(options?: {
  userInitiated?: boolean;
}): Promise<GatewayDetectionState> {
  // Count an ATTEMPT only when this call actually starts a probe. Every mounted
  // poll loop installs its own re-arm listener, and one browser event (a restore
  // from minimized fires `visibilitychange` *and* `focus`) dispatches them all
  // synchronously, while `snapshot.checkedAt` still holds the old timestamp -- so
  // every sibling handler clears the debounce and calls in. `inFlight` already
  // collapses those into one network probe; incrementing per *call* instead of
  // per *probe* would let a single tab restore with a few consumers mounted
  // saturate the backoff straight to REARM_MAX_INTERVAL_MS, stranding detection
  // for 30 minutes on a surface that has no re-check control.
  if (inFlight === null && !options?.userInitiated) {
    rearmAttempts = Math.min(rearmAttempts + 1, REARM_MAX_ATTEMPTS);
  }
  absentSweeps = 0;
  expiresAt = 0;

  const probe = ensureGatewayDetection({ force: true });
  probe
    .then((result) => {
      for (const resume of resumeHandlers) {
        resume(result);
      }
      return result;
    })
    .catch(() => undefined);
  return probe;
}

/**
 * Whether the page is currently hidden.
 *
 * Defaults to visible when `document` is unavailable (SSR, or a test harness
 * stubbing only `window`), so a missing API can never suppress a real re-arm.
 */
function isDocumentHidden(): boolean {
  return globalThis.document?.visibilityState === "hidden";
}

function isEventTarget(value: unknown): value is EventTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

/**
 * Start the self-rescheduling gateway detection poll loop.
 *
 * Frameworkless so it can be driven directly under test. Probes once
 * immediately, then reschedules each subsequent probe at the cadence from
 * {@link getNextProbeDelayMs} -- until that returns `null`, at which point the
 * loop stops dead and arms no timer. It stays stopped until a re-arm signal
 * (window focus or visibility change, debounced by
 * {@link canRearmGatewayDetection}, or an explicit
 * {@link rearmGatewayDetection}) revives it.
 *
 * Returns a disposer that stops the loop, clears any pending timer, and detaches
 * the re-arm listeners, so nothing leaks once the caller (the React effect)
 * unmounts or `enabled` flips off.
 *
 * Pass `fastPoll` for the onboarding desktop-setup flow, which watches for an
 * app the user is installing right now and therefore gets a larger (still
 * bounded) absent budget.
 */
export function startGatewayDetectionPolling(
  options?: GatewayDetectionPollOptions
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // ISS-6084: an ambient loop with no evidence of a desktop app must not issue
  // a single loopback request -- not one sweep, not one port. Returning here
  // instead of probing-then-stopping is the whole fix: the refused-request log
  // is emitted by the browser's network stack, so the only way to not produce
  // it is to not make the request. No timer and no re-arm listener is armed,
  // so a focus/visibility signal cannot resurrect probing either; the React
  // effect re-runs (and this loop is rebuilt) if `desktopKnown` later flips.
  if (!isGatewayProbePermitted(options)) {
    settleWithoutProbing();
    return () => {
      // Nothing was started, so there is nothing to tear down.
    };
  }

  // `absentSweeps` is module-global so concurrent mount sites share one budget,
  // but it also outlives any single loop. A `fastPoll` consumer is the onboarding
  // desktop-setup step, and a fresh mount of it is explicit user intent: the user
  // is on the screen installing the app. Without this reset it would inherit an
  // already-spent counter -- from an earlier visit to the same step, or from an
  // ambient sweep elsewhere in the app -- and start with no budget at all,
  // arming no timer and never probing, so the step could sit on "not detected"
  // forever with Desktop actually running. Ambient loops deliberately do NOT
  // reset, which is what keeps a route-change remount from re-flooding.
  if (options?.fastPoll) {
    absentSweeps = 0;
    fastPollLoops += 1;
  }

  const clearPendingTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const nextDelayMs = (result: GatewayDetectionState): number | null =>
    getNextProbeDelayMs(result, {
      fastPoll: options?.fastPoll,
      absentSweeps: getAbsentSweepCount(),
      recovering: isRecoveringGatewayDetection(),
    });

  const scheduleNext = (result: GatewayDetectionState): void => {
    clearPendingTimer();
    if (disposed) {
      return;
    }
    const delay = nextDelayMs(result);
    if (delay === null) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      // Re-check the budget against the CURRENT snapshot before probing. The
      // absent-sweep counter is module-global and consumers mount staggered, so
      // a sibling loop can spend the last of the shared budget between this
      // timer being armed and its callback running. Forcing a probe anyway
      // would make the cap a per-consumer allowance -- the three-sweep recovery
      // budget would grow with the number of mounted components, which is
      // exactly the multiplied refused-request flood the shared counter exists
      // to prevent.
      if (nextDelayMs(getGatewayDetectionSnapshot()) === null) {
        return;
      }
      ensureGatewayDetection({ force: true })
        .then(scheduleNext)
        .catch(() => undefined);
    }, delay);
  };

  const resume = (result: GatewayDetectionState): void => {
    if (disposed || timer !== undefined) {
      return;
    }
    scheduleNext(result);
  };
  resumeHandlers.add(resume);

  const handleRearmSignal = (): void => {
    // `visibilitychange` fires on hide as well as show. Re-arming as the user
    // leaves would sweep loopback on a page nobody is looking at -- producing
    // exactly the unsuppressable refused-request log this store exists to stop.
    // Only a tab becoming visible (or a focus event, which cannot fire while
    // hidden) is a real signal.
    if (disposed || timer !== undefined || isDocumentHidden()) {
      return;
    }
    if (!canRearmGatewayDetection()) {
      return;
    }
    rearmGatewayDetection().catch(() => undefined);
  };

  // `focus` is dispatched on the window; `visibilitychange` is dispatched on the
  // DOCUMENT and never bubbles to the window. Listening for it on the window
  // would silently drop every visibility-only restore -- switching back to a tab
  // that was hidden but never lost window focus -- leaving detection stopped on
  // exactly the signal this store relies on to resume.
  const focusTarget = isEventTarget(globalThis.window)
    ? globalThis.window
    : null;
  const visibilityTarget = isEventTarget(globalThis.document)
    ? globalThis.document
    : null;
  focusTarget?.addEventListener("focus", handleRearmSignal);
  visibilityTarget?.addEventListener("visibilitychange", handleRearmSignal);

  ensureGatewayDetection()
    .then(scheduleNext)
    .catch(() => undefined);

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (options?.fastPoll) {
      fastPollLoops = Math.max(0, fastPollLoops - 1);
    }
    clearPendingTimer();
    resumeHandlers.delete(resume);
    focusTarget?.removeEventListener("focus", handleRearmSignal);
    visibilityTarget?.removeEventListener(
      "visibilitychange",
      handleRearmSignal
    );
  };
}

export function useGatewayDetection(
  enabled = true,
  options?: GatewayDetectionPollOptions
): GatewayDetectionState {
  const fastPoll = options?.fastPoll ?? false;
  const ambient = options?.ambient ?? false;
  const desktopKnown = options?.desktopKnown ?? false;
  const state = useSyncExternalStore(
    subscribeGatewayDetection,
    getGatewayDetectionSnapshot,
    () => DEFAULT_STATE
  );

  // Destructured to primitives on purpose: an inline `options` object literal at
  // the call site is a new reference every render, so depending on it would tear
  // down and restart the poll loop (and its probe) on every re-render.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Rebuilt as one variant or the other rather than one flat object: the
    // options type is a discriminated union precisely so an ambient loop cannot
    // also claim the intentful `fastPoll` guarantee, and spreading all three
    // keys would erase that distinction at the one call site that matters.
    return ambient
      ? startGatewayDetectionPolling({ ambient: true, desktopKnown })
      : startGatewayDetectionPolling({ fastPoll });
  }, [ambient, desktopKnown, enabled, fastPoll]);

  if (!enabled) {
    return DISABLED_STATE;
  }

  return state;
}

/**
 * Expire the cached detection result.
 *
 * Used by the fetch interceptor when a dispatch to a gateway we believed was
 * present fails, so the next probe re-checks. It deliberately does NOT clear a
 * remembered negative -- that is {@link rearmGatewayDetection}'s job, and only
 * an explicit signal should restart probing.
 */
export function invalidateGatewayDetectionCache(): void {
  expiresAt = 0;
}

export function resetGatewayDetectionForTests(): void {
  snapshot = DEFAULT_STATE;
  expiresAt = 0;
  inFlight = null;
  absentSweeps = 0;
  fastPollLoops = 0;
  rearmAttempts = 0;
  sawGateway = false;
  listeners.clear();
  resumeHandlers.clear();
  removeStorageItem(GATEWAY_SEEN_STORAGE_KEY);
}

/**
 * Whether detection has stopped probing -- not merely finished a sweep.
 *
 * This is the store's own stop condition, evaluated with the store's own
 * numbers: exactly when {@link getNextProbeDelayMs} returns `null` the loop in
 * {@link startGatewayDetectionPolling} arms no further timer. A UI that wants
 * to say "we looked and did not find it" must ask this rather than rebuild the
 * arguments at the render site, because the budget depends on which loop is
 * running ({@link fastPollLoops}), which only this module knows. A consumer
 * that hardcoded `fastPoll: true` would keep claiming "still looking" through
 * eleven sweeps that an ambient loop is never going to run.
 */
export function isGatewayDetectionExhausted(): boolean {
  return (
    getNextProbeDelayMs(getGatewayDetectionSnapshot(), {
      absentSweeps,
      fastPoll: fastPollLoops > 0,
      recovering: sawGateway,
    }) === null
  );
}

/** Options accepted by {@link startGatewayDetectionPolling} and {@link useGatewayDetection}. */
/**
 * How a poll loop was started, as a discriminated union on `ambient`.
 *
 * The two modes are mutually exclusive BY CONSTRUCTION rather than by a
 * precedence rule a reader has to memorise. `fastPoll` documents itself as
 * "always permits probing" while an ambient loop is gated by
 * {@link isGatewayProbePermitted}, so `{ fastPoll: true, ambient: true }` is a
 * direct self-contradiction -- and it used to be silently resolved in ambient's
 * favour, quietly breaking the stronger of the two guarantees. It is now a
 * compile error instead (ISS-6084 review).
 *
 * `desktopKnown` is likewise confined to the ambient variant: it exists only to
 * open the ambient gate, and an intentful loop probes regardless of it, so
 * accepting it there would imply an influence it does not have.
 */
export type GatewayDetectionPollOptions =
  | {
      /**
       * Intentful loop: the user asked for the desktop app (installing it in
       * onboarding, selecting LocalElectron routing, clicking "Check again", or
       * dispatching a gateway request). Always permitted to probe.
       */
      ambient?: false;
      /**
       * The onboarding desktop-setup flow, where the user is installing the
       * desktop app on the very screen that is watching for it. Raises the
       * absent-sweep budget -- it is the most explicit intent signal there is.
       */
      fastPoll?: boolean;
      /** Meaningless for an intentful loop, which probes either way. */
      desktopKnown?: never;
    }
  | {
      /**
       * Background bootstrap with no user intent behind it -- the loop mounted
       * by the authenticated layout on every page. Probes only when
       * {@link isGatewayProbePermitted} says there is durable evidence of a
       * desktop app.
       */
      ambient: true;
      /**
       * Account-level evidence that this user has a desktop app, supplied by the
       * caller (the web bootstrap reads it from the user's registered compute
       * targets). Additive and optional: an older/unknown value simply leaves
       * the ambient loop on the browser-local marker.
       */
      desktopKnown?: boolean;
      /** An ambient loop is by definition not the onboarding fast path. */
      fastPoll?: never;
    };

/**
 * Whether this loop is allowed to issue loopback probes at all.
 *
 * Non-ambient loops always are -- they exist because a user asked for the
 * desktop app (installing it in onboarding, selecting LocalElectron routing,
 * clicking "Check again", or dispatching a gateway request).
 *
 * An ambient loop needs evidence, from either of two independent signals, so a
 * visitor who has never installed the desktop app makes ZERO localhost requests:
 *
 *  1. `desktopKnown` -- the signed-in user owns a registered compute target,
 *     which only exists because a desktop app connected to the cloud under that
 *     account. Account-scoped, so it works on a browser profile that has never
 *     detected anything itself.
 *  2. {@link hasSeenGatewayBefore} -- this browser has detected a gateway here
 *     before. Covers a desktop app running with cloud sync off, which registers
 *     no compute target, and makes the gate self-heal after any one detection.
 *
 * Neither signal is produced by ambient probing, so this is not a gate that can
 * only open after it has already opened. A first-ever detection bootstraps from
 * an intentful loop, both of which probe unconditionally and write signal 2 on
 * success: the onboarding desktop-setup step (`fastPoll`), and the explicit
 * "Check again" control that sits beside it.
 *
 * KNOWN RESIDUAL (ISS-6084 review): both of those live under `(onboarding)`, and
 * signal 1 needs a desktop that reached the cloud. So a user who skipped the
 * onboarding desktop step AND runs a desktop app with cloud sync disabled AND is
 * on a browser that has never detected one has no ambient bootstrap left, and
 * recovers only by re-entering onboarding. Before this gate they self-healed on
 * the next page load, at the cost of the refused-request flood this exists to
 * stop. Closing it properly needs a "check for Desktop" affordance on an
 * authenticated surface (or an account-level installed-desktop signal); do NOT
 * close it by letting an ambient loop probe speculatively again.
 */
export function isGatewayProbePermitted(
  options?: GatewayDetectionPollOptions
): boolean {
  if (options?.ambient !== true) {
    return true;
  }
  return options.desktopKnown === true || hasSeenGatewayBefore();
}

/**
 * Whether a desktop gateway has ever been detected in this browser.
 *
 * Reads through {@link getStorageItem}, which is SSR-safe, and treats a storage
 * failure (Safari private mode, disabled storage) as "no evidence" -- the quiet
 * answer, since a false negative only costs a user an explicit re-check while a
 * false positive would reintroduce the refused-request flood for everyone.
 */
export function hasSeenGatewayBefore(): boolean {
  try {
    return (
      getStorageItem(GATEWAY_SEEN_STORAGE_KEY) === GATEWAY_SEEN_STORAGE_VALUE
    );
  } catch {
    return false;
  }
}

/**
 * Record that a gateway was detected here, so ambient probing is permitted from
 * now on. Best-effort: a storage write that throws must never fail the probe
 * that succeeded.
 */
function rememberGatewaySeen(): void {
  try {
    setStorageItem(GATEWAY_SEEN_STORAGE_KEY, GATEWAY_SEEN_STORAGE_VALUE);
  } catch {
    // Storage is an optimization here, never a correctness requirement.
  }
}

/**
 * Publish a settled not-detected state for a loop that is not permitted to
 * probe, so consumers are not stuck on `loading` forever.
 *
 * `checkedAt` deliberately stays `null`. It is the store's "a probe has answered
 * this" marker: the fetch interceptor's LocalElectron dispatch reads it to
 * decide whether to force a probe, and {@link ensureGatewayDetection} reads it
 * for its TTL. Stamping it here would make a suppressed ambient loop look like a
 * completed negative sweep and silently stop an intentful caller from ever
 * probing.
 */
function settleWithoutProbing(): void {
  // An intentful caller's probe is already running, and it has not answered yet
  // -- `checkedAt` is still null and `loading` still true, which is exactly the
  // state this function otherwise treats as "nobody has settled this, so I
  // will". Publishing here would announce a settled NEGATIVE over a pending
  // LocalElectron check, and `EngineerTransportBootstrap` acts on `loading:
  // false` the moment it lands: a user with a working local desktop gets routed
  // to CloudRelay while their own gateway is still answering (ISS-6084 review).
  // The in-flight probe publishes the real verdict when it resolves, so the
  // correct move is to say nothing.
  if (inFlight !== null) {
    return;
  }
  // Never overwrite a real probe result, and stay idempotent across the several
  // consumers that mount this loop on one page.
  if (snapshot.checkedAt !== null || !snapshot.loading) {
    return;
  }
  snapshot = { ...DEFAULT_STATE, loading: false };
  emitChange();
}
