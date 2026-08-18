import {
  type OrgSessionSyncPolicyState,
  OrgSessionSyncPolicyUnresolved,
} from "../../shared/contracts.js";
import { fetchDesktopIdentity } from "../auth/desktop-identity-client.js";
import type { SessionFetchOptions } from "../util/api-response-utils.js";

/**
 * FEA-4169 / ISS-4705 — main-process cache of the server-owned ORG POLICY
 * (`sessionSyncPolicyEnabled`) controlling whether local session data may sync
 * to the cloud at all. This is the OUTER gate ABOVE per-device sync consent
 * (PRD-542/FEA-4103): the desktop sync services AND {@link getPolicyState} into
 * their existing per-tier consent checks so no session data egresses when the
 * org policy is off.
 *
 * The policy is read from `GET /desktop/identity` (the same org-config surface
 * the Account tab already fetches) — an additive, optional field. Until the
 * first successful fetch the state is `"unknown"`, which the pure gate predicate
 * (`orgPolicyAllowsSessionSync`) fails CLOSED (ISS-4623).
 *
 * ISS-4623 — the store distinguishes the two non-boolean states so the gate can
 * resolve them differently: `"unknown"` (nothing resolved yet — pre-first-fetch,
 * offline, a failed attempt, or a capable server's malformed answer) fails
 * CLOSED, while `"unsupported"` degrades to the prior device-consent behavior.
 * Because unknown now blocks the lanes, {@link ensureResolved} lets the gate
 * itself kick a throttled best-effort refresh: a transient fetch failure is a
 * latency window, not a permanent stall.
 *
 * ISS-4705 — WHICH unresolved state a response missing `sessionSyncPolicyEnabled`
 * lands in is decided by the VERSIONED CAPABILITY marker
 * `sessionSyncPolicySupported`, not by field-presence alone:
 * - capability ABSENT (an OLD server that predates the policy) → `"unsupported"`,
 *   which degrades to device consent so a desktop upgrade never newly suppresses
 *   an already-consented user (the cross-repo skew rule).
 * - capability PRESENT but the policy field missing (a BUGGY CURRENT server that
 *   dropped only the boolean from an otherwise well-formed response) → `"unknown"`,
 *   which fails CLOSED — a capable server's malformed answer must not be read as
 *   "no org policy → allow". The capability check runs BEFORE any cached value,
 *   so a cached `true` cannot survive a capable server's malformed answer.
 *
 * A CURRENT server always advertises support and sends an explicit boolean, so
 * `"unsupported"` only ever describes a genuinely old server, and an explicit
 * `false` from a current server is never masked.
 *
 * ISS-4623 (follow-up) — the gate-driven `ensureResolved` retry alone is NOT
 * enough: the sync lanes tear their tick timer down while the fail-closed gate
 * says no, so once the FIRST fetch fails during startup nothing calls the gate
 * — and thus `ensureResolved` — again, and the throttled retry could never
 * fire. The store therefore runs its OWN self-heal timer
 * ({@link UNRESOLVED_SELF_HEAL_INTERVAL_MS}) while unresolved, re-attempting the
 * fetch on its own cadence until the policy resolves (then it stops), so
 * convergence never depends on a caller pumping it.
 */
export type OrgSyncPolicyStoreOptions = {
  /** Resolves the auth/transport options for the identity fetch. */
  getFetchOptions: () => SessionFetchOptions | null;
  /**
   * Injected fetcher (defaults to {@link fetchDesktopIdentity}); overridable in
   * tests so the store's caching/degrade behavior can be exercised without a
   * real transport.
   */
  fetchIdentity?: typeof fetchDesktopIdentity;
  /**
   * Injected clock (defaults to `Date.now`) so tests can drive the
   * {@link OrgSyncPolicyStore.ensureResolved} throttle window without a real
   * wall clock.
   */
  now?: () => number;
  /**
   * ISS-4623 — injected timer scheduler for the store's OWN self-heal loop
   * (defaults to `setTimeout`). The store re-arms this whenever a refresh leaves
   * the policy unresolved so convergence never depends on a caller pumping
   * {@link OrgSyncPolicyStore.ensureResolved}: the sync lanes tear their tick
   * timer down while the fail-closed gate says no, so once the FIRST fetch fails
   * during startup nothing would call the gate — and thus `ensureResolved` —
   * again, and the throttled retry could never fire. Overridable in tests so the
   * self-heal cadence is driven deterministically without a real wall clock.
   */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  /** Cancels a handle produced by {@link OrgSyncPolicyStoreOptions.setTimer}. */
  clearTimer?: (handle: TimerHandle) => void;
};

/** Opaque timer handle returned by the injected scheduler. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Minimum spacing between the self-healing refreshes
 * {@link OrgSyncPolicyStore.ensureResolved} kicks off. The gate is evaluated on
 * every sync tick, so without a throttle an unresolved policy (a signed-out
 * user, an offline machine) would issue one identity request per tick.
 */
export const UNRESOLVED_REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * ISS-4623 — cadence of the store's OWN self-heal timer while the policy stays
 * unresolved. Matches {@link UNRESOLVED_REFRESH_MIN_INTERVAL_MS} so the
 * store-driven retry and the gate-driven `ensureResolved` throttle stay in step:
 * whichever fires first, the other is a no-op inside the shared throttle window.
 */
export const UNRESOLVED_SELF_HEAL_INTERVAL_MS =
  UNRESOLVED_REFRESH_MIN_INTERVAL_MS;

export class OrgSyncPolicyStore {
  private policyState: OrgSessionSyncPolicyState =
    OrgSessionSyncPolicyUnresolved.Unknown;

  private readonly fetchIdentity: typeof fetchDesktopIdentity;

  private readonly getFetchOptions: OrgSyncPolicyStoreOptions["getFetchOptions"];

  private readonly now: () => number;

  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => TimerHandle;

  private readonly clearTimer: (handle: TimerHandle) => void;

  /**
   * ISS-4623 — the store's own self-heal timer while the policy is unresolved,
   * or `null` when resolved / not armed. Kept so it can be cleared on resolution
   * and on {@link reset} (no leaked timer, no restart of a superseded cycle).
   */
  private selfHealTimer: TimerHandle | null = null;

  /**
   * ISS-4623 (shafty023 review) — set once {@link dispose} runs. Latches the
   * self-heal loop off so neither an in-flight refresh's post-run hook nor a
   * timer that already fired can re-arm it during/after teardown.
   */
  private disposed = false;

  /** The in-flight refresh, so concurrent callers share one identity request. */
  private inFlight: Promise<OrgSessionSyncPolicyState> | null = null;

  /**
   * ISS-4705 (wongk review) — the identity generation this cache describes,
   * bumped by every {@link reset}. A refresh captures the generation it started
   * under and refuses to write a result whose generation no longer matches, so
   * an in-flight fetch for account A that lands AFTER a switch to account B can
   * never install A's policy over B's — which would silently re-open session
   * egress for an org that has it disabled.
   */
  private generation = 0;

  /** When {@link ensureResolved} last kicked a refresh (throttle bookkeeping). */
  private lastUnresolvedRefreshAt: number | null = null;

  /** Listeners notified whenever the cached policy state actually changes. */
  private readonly listeners = new Set<() => void>();

  constructor(options: OrgSyncPolicyStoreOptions) {
    this.getFetchOptions = options.getFetchOptions;
    this.fetchIdentity = options.fetchIdentity ?? fetchDesktopIdentity;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /**
   * The last observed policy state. `"unknown"` until a fetch resolves it.
   * Consumed by the sync gate via `orgPolicyAllowsSessionSync`.
   */
  getPolicyState(): OrgSessionSyncPolicyState {
    return this.policyState;
  }

  /**
   * ISS-4623 — observe policy-state transitions. Required, not a convenience:
   * the metadata sync lanes TEAR DOWN their tick timer when their readiness
   * gate says no (`AgentSessionSyncService.refresh` → `clearTimer`), so a lane
   * suppressed by a fail-closed `"unknown"` would never evaluate the gate again
   * and could not observe the policy later resolving to `true`. Subscribers
   * re-kick those lanes on every transition, the same shape as the existing
   * post-tier-change sweep kick. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fetch the current org policy and update the cache. Best-effort and
   * fail-safe: a null/failed response leaves the last-known state untouched
   * (so a transient outage never flips an explicit policy back to unresolved).
   * When a successful response omits the boolean, the resulting unresolved state
   * is chosen by the `sessionSyncPolicySupported` capability marker (ISS-4705):
   * capability absent → `"unsupported"` (old server → degrade), capability
   * present → `"unknown"` (buggy current server → fail closed). Concurrent calls
   * share one in-flight request. Returns the resulting state.
   */
  refresh(): Promise<OrgSessionSyncPolicyState> {
    const existing = this.inFlight;
    if (existing) {
      return existing;
    }
    const run = this.runRefresh(this.generation)
      .finally(() => {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
      })
      .then((state) => {
        // ISS-4623 — if this refresh left the policy unresolved, keep the
        // store's own self-heal loop running so convergence never depends on a
        // caller re-invoking the gate. `setPolicyState` clears the timer the
        // moment the policy actually resolves.
        this.armSelfHealIfUnresolved();
        return state;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * ISS-4623 — kick a throttled, best-effort refresh while the policy is still
   * unresolved. Called from the sync gate so a fail-closed `"unknown"` converges
   * on its own instead of waiting out the next sign-in or cloud-online
   * transition (the only other refresh triggers). No-ops — returning `null` —
   * once the policy has resolved to a boolean or to `"unsupported"`, while a
   * refresh is already in flight, and inside the throttle window.
   *
   * Returns the kicked refresh so the (synchronous) gate can discard it while
   * tests await it; the promise never rejects.
   */
  ensureResolved(): Promise<OrgSessionSyncPolicyState> | null {
    if (this.policyState !== OrgSessionSyncPolicyUnresolved.Unknown) {
      return null;
    }
    if (this.inFlight) {
      return null;
    }
    const now = this.now();
    const lastAt = this.lastUnresolvedRefreshAt;
    if (lastAt !== null && now - lastAt < UNRESOLVED_REFRESH_MIN_INTERVAL_MS) {
      return null;
    }
    this.lastUnresolvedRefreshAt = now;
    // `refresh` already swallows transport failures; the catch is belt-and-braces
    // so a fire-and-forget self-heal can never surface as an unhandled rejection.
    return this.refresh().catch(() => this.policyState);
  }

  /**
   * Clear the cached policy back to `"unknown"`. Called on an auth-session
   * change (sign-out / account switch) BEFORE the follow-up {@link refresh} so a
   * previous account's value cannot linger and gate the new account's org.
   * `"unknown"` fails closed (ISS-4623), which is the correct posture for a
   * not-yet-fetched account. Any in-flight refresh is detached and its response
   * discarded, so a late reply for the previous account cannot land on the new
   * one. This is a runtime reset — it does NOT persist across process restarts
   * (the store is always born `"unknown"`).
   */
  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.lastUnresolvedRefreshAt = null;
    // Cancel the previous account's self-heal cycle; the follow-up refresh the
    // caller issues after reset re-arms it for the new account if it, too, lands
    // unresolved. Clear BEFORE `setPolicyState` so a no-op transition (already
    // `"unknown"`) still stops the stale timer.
    this.clearSelfHealTimer();
    this.setPolicyState(OrgSessionSyncPolicyUnresolved.Unknown);
  }

  /**
   * Apply a resolved policy value and notify subscribers when it actually
   * changed. A listener that throws is swallowed so one bad subscriber cannot
   * break the sync gate or strand the remaining listeners.
   */
  private setPolicyState(next: OrgSessionSyncPolicyState): void {
    if (this.policyState === next) {
      return;
    }
    this.policyState = next;
    if (next !== OrgSessionSyncPolicyUnresolved.Unknown) {
      // Resolved (boolean or `"unsupported"`): stop the self-heal loop.
      this.clearSelfHealTimer();
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Best-effort notification; a failing subscriber must not break the gate.
      }
    }
  }

  private async runRefresh(
    generation: number
  ): Promise<OrgSessionSyncPolicyState> {
    const fetchOptions = this.getFetchOptions();
    if (!fetchOptions) {
      // No live session/transport yet — keep the last-known state.
      return this.policyState;
    }
    let identity: Awaited<ReturnType<typeof fetchDesktopIdentity>>;
    try {
      identity = await this.fetchIdentity(fetchOptions);
    } catch {
      // Transport/parse failure is already swallowed to null by the client, but
      // guard anyway so a throw never propagates into the sync tick.
      return this.policyState;
    }
    if (generation !== this.generation) {
      // ISS-4705 (wongk review) — a reset (sign-out / account switch) landed
      // while this fetch was in flight: the response describes the PREVIOUS
      // account's org. Discard it rather than write a stale cross-account policy
      // over the (fail-closed) state the reset installed for the new one, which
      // would silently re-open session egress for an org that has it disabled.
      return this.policyState;
    }
    if (!identity) {
      // Offline / unauthenticated / malformed → keep last-known state.
      return this.policyState;
    }
    const value = identity.sessionSyncPolicyEnabled;
    if (typeof value === "boolean") {
      this.setPolicyState(value);
      return this.policyState;
    }
    // Boolean absent from a successful response. ISS-4705 — the capability check
    // runs FIRST, ahead of any cached value, so a capable server's malformed
    // answer can never be masked by an earlier cached `true`.
    if (identity.sessionSyncPolicySupported === true) {
      // A CURRENT server that advertises policy support yet dropped only the
      // boolean is buggy/malformed → fail CLOSED. This overrides a previously
      // cached value (chatgpt-codex-connector review): a capable server's
      // malformed answer must never be read as "allow", and letting an earlier
      // cached `true` survive it would do exactly that. `"unknown"` is
      // recoverable — the next well-formed response resolves it again, and the
      // ISS-4623 self-heal loop re-arms to drive that retry without a caller.
      this.setPolicyState(OrgSessionSyncPolicyUnresolved.Unknown);
      return this.policyState;
    }
    // No capability marker → an OLD server that predates the policy. A
    // previously-observed explicit value stays authoritative and is NOT
    // clobbered, so a mixed fleet where one old node answers cannot reset a
    // resolved policy.
    if (typeof this.policyState === "boolean") {
      return this.policyState;
    }
    // Nothing explicit ever observed, and the server predates the policy →
    // version skew, degrade to the prior device-consent behavior.
    this.setPolicyState(OrgSessionSyncPolicyUnresolved.Unsupported);
    return this.policyState;
  }

  /**
   * ISS-4623 — while the policy is still unresolved, keep exactly one self-heal
   * timer scheduled so the store re-attempts the fetch on its own cadence,
   * independent of whether any sync lane is still ticking the gate. Idempotent:
   * a timer already armed is left in place (no churn, no double-scheduling). The
   * scheduled callback re-arms via {@link refresh}'s post-run hook only while the
   * state stays `"unknown"`; the loop stops as soon as the policy resolves
   * (`setPolicyState` clears the timer) or the account is reset.
   */
  private armSelfHealIfUnresolved(): void {
    if (this.disposed) {
      // Teardown latched the loop off: never re-arm, even if a refresh that was
      // in flight when dispose() ran resolves still-unresolved afterward.
      return;
    }
    if (this.policyState !== OrgSessionSyncPolicyUnresolved.Unknown) {
      return;
    }
    if (this.selfHealTimer !== null) {
      return;
    }
    this.selfHealTimer = this.setTimer(() => {
      // Clear the marker only when the timer actually fires so a canceled cycle
      // can always reschedule (runtime-cleanup contract). Skip the redundant
      // fetch if a caller-driven refresh already resolved the policy meanwhile,
      // or if teardown latched the loop off between arming and firing.
      this.selfHealTimer = null;
      if (this.disposed) {
        return;
      }
      if (this.policyState !== OrgSessionSyncPolicyUnresolved.Unknown) {
        return;
      }
      // `refresh` shares the in-flight request and re-arms this loop when it
      // completes still-unresolved; it already swallows transport failures. The
      // `.catch` is belt-and-braces so a fire-and-forget self-heal can never
      // surface as an unhandled rejection.
      this.refresh().catch(() => this.policyState);
    }, UNRESOLVED_SELF_HEAL_INTERVAL_MS);
  }

  private clearSelfHealTimer(): void {
    if (this.selfHealTimer === null) {
      return;
    }
    this.clearTimer(this.selfHealTimer);
    this.selfHealTimer = null;
  }

  /**
   * ISS-4623 (shafty023 review) — idempotent teardown. Latches the self-heal
   * loop off and clears any pending timer so, once the desktop starts shutting
   * down, this store can never fire another refresh or re-arm its timer — not
   * from a scheduled tick, and not from the post-run hook of a refresh that was
   * already in flight when dispose ran. The owner MUST call this before stopping
   * the sync lanes (alongside disposing the lane subscription) so an unresolved
   * policy cannot kick a fetch/upload into stopped lanes while the cloud socket
   * is still online. A disposed store keeps its last cached state for reads; it
   * is not expected to be refreshed again this process.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearSelfHealTimer();
  }
}
