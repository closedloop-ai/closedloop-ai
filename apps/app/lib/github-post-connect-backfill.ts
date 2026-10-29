"use client";

/**
 * Store for the GitHub backfill claim that both Branches routes make when they
 * land on a `?github=connected` return.
 *
 * ISS-7338: each route used to hold this claim in a `useRef`, which lives in a
 * component INSTANCE. A remount builds a fresh instance with a fresh ref, so the
 * guard reset and the route fired `POST /integrations/github/backfill` again —
 * an Apply-mode run that walks repos -> branches -> PRs -> projections
 * synchronously. That is duplicated server work caused by a render-lifecycle
 * accident, not by anything the user did.
 *
 * Document scope is the correct lifetime here, not merely a longer one. Every
 * reconnect ORIGINATES in a document navigation, so it tears this module down
 * and rebuilds it, while a React remount never does — exactly the distinction
 * the ref failed to make. A claim that survived a real reconnect would
 * under-fire, which is the opposite and equally wrong failure.
 *
 * The two producers of the param both navigate the document: the OAuth callback
 * answers with a redirect to `getSuccessRedirectUrl(...)`, and the Clerk-link
 * path finishes with `window.location.assign(...)`. One consumer then forwards
 * it CLIENT-side — `branch-compatibility-redirect.tsx` preserves the query onto
 * a `navigation.replace` into the branch detail route. That is still one claim
 * per reconnect, because it only ever runs downstream of the document
 * navigation that produced the param, and the route it leaves (`build/[id]`)
 * never claims. Do not read that hop as a second reconnect.
 *
 * Shaped as a store rather than a bare module-local `Set` per the `apps/app`
 * client-state guardrail: the claims are an immutable snapshot replaced
 * wholesale on every write, behind `subscribe`/`get`, so a reader can never
 * observe a half-applied mutation and a renderer can plug straight into
 * `useSyncExternalStore` without touching the claim path. The exemplars the
 * guardrail names (`packages/shared-platform/src/routing-store.ts`,
 * `packages/shared-platform/src/detection-store.ts`) each hold ONE snapshot; this extends
 * the same contract to a keyed claim, because the backfill is org-scoped and
 * one org's claim must never suppress another org's run. No `use…` hook is
 * exported: nothing renders the claim, and an unused hook would be exactly the
 * unreachable export the repo's dead-code rule forbids.
 */

/**
 * Claim-set ceiling. Document-lifetime state still needs a bound, and the org
 * count is attacker-independent but not intrinsically finite — a session that
 * keeps client-navigating between orgs would otherwise grow this set forever.
 * Well above any real membership count, so eviction is unreachable in practice;
 * if it ever fires, the evicted org can re-claim once, which costs one extra
 * backfill rather than a leak.
 */
export const MAX_CLAIMED_ORGS = 32;

let claimedOrgSlugs: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

function emitClaimChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribe to claim changes. Pairs with `getPostConnectBackfillClaims` as the
 * `useSyncExternalStore` contract.
 */
export function subscribePostConnectBackfillClaims(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current claims. Referentially stable between writes, which is what
 * `useSyncExternalStore` requires of a snapshot.
 */
export function getPostConnectBackfillClaims(): ReadonlySet<string> {
  return claimedOrgSlugs;
}

/**
 * Claim the post-connect backfill for `orgSlug`, returning whether the caller
 * won it. Test-and-set in one call so two mounts racing on the same tick cannot
 * both read "unclaimed" and both fire.
 */
export function claimPostConnectBackfill(orgSlug: string): boolean {
  if (claimedOrgSlugs.has(orgSlug)) {
    return false;
  }
  const next = new Set(claimedOrgSlugs);
  next.add(orgSlug);
  if (next.size > MAX_CLAIMED_ORGS) {
    // Insertion-ordered, so the first entry is the oldest claim and never the
    // one just added.
    const oldest = next.values().next().value;
    if (oldest !== undefined) {
      next.delete(oldest);
    }
  }
  claimedOrgSlugs = next;
  emitClaimChange();
  return true;
}

/**
 * Drop every claim. Module state outlives a single test, so a suite that mounts
 * a connected return more than once needs this in `beforeEach` — without it the
 * second case silently observes a claim the first one made.
 */
export function resetPostConnectBackfillClaims(): void {
  claimedOrgSlugs = new Set<string>();
  emitClaimChange();
}
