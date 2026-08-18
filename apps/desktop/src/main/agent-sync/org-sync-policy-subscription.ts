import { sameUserIdentity } from "../util/user-identity.js";
import type { OrgSyncPolicyStore } from "./org-sync-policy-store.js";

/**
 * ISS-4623 — wiring for the org-sync-policy → sync-lane re-kick subscription,
 * extracted from `app.ts` so its shutdown/dispose lifecycle is unit-testable in
 * isolation (and so the grandfathered `app.ts` does not carry another
 * responsibility inline).
 *
 * The org-policy gate fails closed while the policy is still unresolved, and
 * BOTH metadata lanes tear their tick timer down when their readiness gate says
 * no (`AgentSessionSyncService.refresh` → `clearTimer`;
 * `AgentComponentInvocationSyncService.schedule` refuses to re-arm). A lane
 * suppressed during the load window would therefore never re-evaluate the gate
 * and would stay dead for the rest of the process once the policy resolved to
 * `true`. So on every policy transition we re-kick every lane — the same shape
 * as the post-tier-change sweep kick.
 *
 * Two invariants this module owns (wongk review):
 * - **Shutdown-gated.** A policy refresh can resolve DURING teardown, after the
 *   lanes were stopped. The transcript sweep's `shouldRun()` does not check the
 *   lane's `started` flag and the cloud socket is still online until later in the
 *   shutdown sequence, so an un-gated re-kick could restart an upload mid-
 *   teardown. The callback no-ops once `isShuttingDown()` is true.
 * - **Disposable.** The returned handle unsubscribes from the store. The owner
 *   MUST invoke it before stopping the lanes (e.g. before `stopAgentCapture`) so
 *   a late transition cannot fire into stopped lanes at all.
 */
export type OrgSyncPolicyLaneKicks = {
  /** Re-kick the agent-session metadata lane (`AgentSessionSyncService.refresh`). */
  refreshAgentSessionSync: () => void;
  /** Re-kick the component-invocation lane (`AgentComponentInvocationSyncService.refresh`). */
  refreshComponentInvocationSync: () => void;
  /** Kick a transcript sweep, mirroring the tier-change kick. */
  kickTranscriptSweep: () => void;
};

/** The account identity an auth-session change resolves to, or `null` on sign-out. */
export type OrgSyncPolicyAccountIdentity = {
  userId: string;
  organizationId: string;
};

export type OrgSyncPolicySubscriptionOptions = {
  store: OrgSyncPolicyStore;
  laneKicks: OrgSyncPolicyLaneKicks;
  /** True once teardown has begun; the re-kick no-ops so it can't restart lanes. */
  isShuttingDown: () => boolean;
  /**
   * ISS-4623 (shafty023 review) — the account identity as of the auth-session
   * change being reacted to. Used to distinguish a genuine account switch /
   * sign-out (identity changed) from a routine SAME-account token renewal
   * (`applyTokens` re-notifies with an unchanged `{userId, organizationId}`).
   * Returns `null` when signed out.
   */
  getAccountIdentity: () => OrgSyncPolicyAccountIdentity | null;
};

/** A disposable subscription handle. */
export type OrgSyncPolicySubscription = {
  /**
   * FEA-4169/ISS-4623 — react to an auth-session change (sign-in / sign-out /
   * account switch): reset the cached org policy so a previous account's value
   * cannot linger and gate the new account's org during the async refresh gap
   * (the reset `"unknown"` fails closed, so the gap suppresses egress rather than
   * allowing it), then kick a best-effort refresh. A failed refresh leaves
   * `"unknown"` and the store's own self-heal loop converges on a later tick.
   * No-ops during teardown.
   */
  onAuthSessionChange: () => void;
  /** Unsubscribe from the store. Idempotent. Call BEFORE stopping the lanes. */
  dispose: () => void;
};

/**
 * Subscribe the sync lanes to org-policy transitions. Returns a disposable that
 * unsubscribes; the callback itself is shutdown-gated so even a transition that
 * lands between "shutting down" and disposal cannot restart a lane.
 */
export function wireOrgSyncPolicySubscription(
  options: OrgSyncPolicySubscriptionOptions
): OrgSyncPolicySubscription {
  const { store, laneKicks, isShuttingDown, getAccountIdentity } = options;
  const unsubscribe = store.subscribe(() => {
    if (isShuttingDown()) {
      // A refresh resolved during teardown; do not restart any lane or sweep.
      return;
    }
    laneKicks.refreshAgentSessionSync();
    laneKicks.refreshComponentInvocationSync();
    laneKicks.kickTranscriptSweep();
  });
  // ISS-4623 (shafty023 review) — the account this subscription last observed, so
  // a routine same-account token renewal does not `reset()` (which would fail the
  // now-fail-closed `"unknown"` gate closed and pause every lane until the next
  // identity fetch succeeds). Seeded to the identity at wire time so the very
  // first same-account renewal is recognized as such.
  let lastAccountIdentity = getAccountIdentity();
  let disposed = false;
  return {
    onAuthSessionChange: () => {
      if (isShuttingDown()) {
        return;
      }
      const nextIdentity = getAccountIdentity();
      const sameAccount = sameUserIdentity(lastAccountIdentity, nextIdentity);
      lastAccountIdentity = nextIdentity;
      if (sameAccount) {
        // Same-account token renewal (`applyTokens` re-notifies with an unchanged
        // identity): refresh WITHOUT resetting so a known `true`/`false` policy is
        // not discarded — a transient identity failure otherwise pauses every lane
        // until a later fetch succeeds. `refresh` never clobbers a known value
        // with a null/failed response, so the cached policy survives the gap.
        store.refresh().catch(() => store.getPolicyState());
        return;
      }
      // Genuine account switch / sign-out (identity changed): reset FIRST so the
      // previous account's explicit policy cannot linger, then re-derive the new
      // account's policy. `refresh` swallows failures and re-arms the store's
      // self-heal loop when it lands still-unresolved.
      store.reset();
      store.refresh().catch(() => store.getPolicyState());
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
    },
  };
}
