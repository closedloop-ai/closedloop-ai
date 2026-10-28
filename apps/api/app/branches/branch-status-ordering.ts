import {
  type BranchStatusOrdering,
  branchStatusOrderingFor,
} from "@repo/api/src/types/branch-status-order";
import {
  evaluateFeatureFlagForAnyIdentity,
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";
import { ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

const FLAG_LOG_KEY = "branches.status-ordering.flag-evaluation-failed";

/**
 * ISS-9437 — resolve the Branches status ordering for one request principal.
 *
 * The ONE place `apps/api` reads this key. Both producers that need it — the
 * list route, which builds the page, and the list-status-ordering route, which
 * states what the list will be built with — call this and receive a WHOLE
 * ORDERING rather than a boolean, so neither can derive its own answer from the
 * flag and drift from the other.
 *
 * MUST BE CALLED ABOVE `withBranchProductReadSnapshot`. It awaits a PostHog
 * round trip, and that snapshot is a RepeatableRead transaction with a 45s
 * timeout (ISS-10295 raised it from 15s) — spending any of that budget on a
 * flag lookup risks aborting the read
 * it was meant to configure. `listServerPageBranches` therefore takes a resolved
 * ordering and never a `FeatureFlagIdentity`.
 *
 * `evaluateFeatureFlagForAnyIdentity` rather than the raw
 * `isFeatureFlagEnabledForDistinctId`, because the raw call RE-THROWS a rejected
 * read and would turn a PostHog outage into a 500 on the Branches list. This one
 * catches, logs, and reports UNAVAILABLE.
 */
export async function resolveBranchStatusOrdering(
  identity: FeatureFlagIdentity
): Promise<BranchStatusOrdering> {
  const enabled = await evaluateBranchStatusRootOrder(identity);
  return branchStatusOrderingFor(enabled === true);
}

/**
 * The ordering NAME to state on the evaluation clock, or `undefined` when the
 * flag could not be evaluated at all AND nothing was ever evaluated for this
 * principal.
 *
 * UNAVAILABLE with no held answer states NOTHING rather than the default name.
 * The client HOLDS its previously latched ordering when this field is absent,
 * and holding is the right answer for a blip: naming the default here would
 * re-key the reader's list query and reset their page every time PostHog failed
 * to answer, then again when it recovered.
 */
export async function resolveServedBranchStatusOrderingName(
  identity: FeatureFlagIdentity
): Promise<string | undefined> {
  const enabled = await evaluateBranchStatusRootOrder(identity);
  return enabled === null ? undefined : branchStatusOrderingFor(enabled).name;
}

/**
 * ISS-9437 — the LAST ANSWER PostHog actually gave for a principal, held only
 * long enough to cover a blip.
 *
 * Why this exists, and why a plain per-request read is not enough: the clock
 * and the list are SEPARATE requests. The clock names an ordering, the client
 * latches it and keys its list query on it, and the list route then reads the
 * flag again. Without this, a read that fails on page 2 alone serves
 * VOCABULARY-ordered rows under a root-first key, so offsets index into a
 * different ordering than page 1 did and branches repeat or vanish across the
 * seam. That is exactly the pagination integrity this ticket exists to hold,
 * and "the producer cannot hold" — the previous reasoning here — was only true
 * because nothing remembered.
 *
 * It is consulted ONLY when the live read is UNAVAILABLE, so a genuine flag
 * flip is never delayed: a successful read overwrites the entry before it is
 * ever used. A cold entry is impossible for the sequence that matters, because
 * the clock request populates it for the same principal moments earlier; when
 * it truly is cold, behavior is exactly what it was before.
 *
 * WHAT THIS DOES NOT COVER, and why that is a deliberate stopping point
 * (ISS-9437, marisolashgrove review on #6928). The clock and the list can name
 * different orderings two ways, and this closes ONE of them. The other is two
 * HEALTHY reads that return different answers: the ordering is latched
 * client-side for `SERVED_STATUS_ORDERING_RENEW_MS`
 * (`served-status-ordering.ts`) while the list route re-evaluates per
 * request, so a rollout flip landing between page 1 and page 2 builds page 2
 * root-first under a vocabulary key with both evaluations succeeding —
 * `evaluated` is non-null, this hold never runs, and the rows straddle. It is
 * bounded rather than open-ended: it needs a rollout percentage to move
 * mid-session, it cannot happen while the key is off, and it self-heals at the
 * next ordering renew. Closing it too would mean the list honouring an ordering
 * the CLIENT states rather than one it evaluates, which is a request-contract
 * change this ticket deliberately does not make.
 *
 * Best-effort by construction. It is per-process, so a serverless instance that
 * has served this principal nothing simply falls back — this buys resilience,
 * and no correctness claim rests on a hit.
 */
const HELD_ORDERING_TTL_MS = 60_000;
const HELD_ORDERING_MAX_PRINCIPALS = 5000;
const heldOrderingByPrincipal = new Map<
  string,
  { enabled: boolean; at: number }
>();

async function evaluateBranchStatusRootOrder(
  identity: FeatureFlagIdentity
): Promise<boolean | null> {
  const evaluated = await evaluateFeatureFlagForAnyIdentity(
    ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
    identity,
    FLAG_LOG_KEY
  );
  const principal = principalKey(identity);
  if (principal === null) {
    return evaluated;
  }
  if (evaluated === null) {
    return heldOrderingFor(principal);
  }
  holdOrderingFor(principal, evaluated);
  return evaluated;
}

/**
 * The SAME distinct id the evaluation was performed against, so a principal
 * cannot be held under one identity and read back under another. Null when the
 * principal resolves no distinct id, which is also the case the evaluator
 * itself declines to evaluate.
 */
function principalKey(identity: FeatureFlagIdentity): string | null {
  const [distinctId] = resolveDistinctIdsForIdentity(identity);
  return distinctId ?? null;
}

function heldOrderingFor(principal: string): boolean | null {
  const held = heldOrderingByPrincipal.get(principal);
  if (!held) {
    return null;
  }
  if (Date.now() - held.at > HELD_ORDERING_TTL_MS) {
    heldOrderingByPrincipal.delete(principal);
    return null;
  }
  return held.enabled;
}

function holdOrderingFor(principal: string, enabled: boolean): void {
  // Delete before set so the Map's insertion order stays least-recent-first,
  // which is what makes the eviction below evict the right entry.
  heldOrderingByPrincipal.delete(principal);
  heldOrderingByPrincipal.set(principal, { enabled, at: Date.now() });
  while (heldOrderingByPrincipal.size > HELD_ORDERING_MAX_PRINCIPALS) {
    const oldest = heldOrderingByPrincipal.keys().next();
    if (oldest.done) {
      return;
    }
    heldOrderingByPrincipal.delete(oldest.value);
  }
}

/**
 * Clears the held answers. A suite that drives more than one evaluation outcome
 * for one principal MUST call this between cases, or the first case's success
 * answers the next case's unavailable read and the case passes for the wrong
 * reason.
 */
export function resetHeldBranchStatusOrderings(): void {
  heldOrderingByPrincipal.clear();
}
