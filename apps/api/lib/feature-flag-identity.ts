import { getAllFeatureFlagsForDistinctId } from "@repo/analytics/feature-flags";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { evaluateServerFeatureFlagForDistinctId } from "@/lib/feature-flags/server-feature-flag-evaluation";
import type { GrantSuppression } from "@/lib/feature-flags/server-feature-flag-suppression";
import type { RegisteredServerFeatureFlag } from "@/lib/feature-flags/server-feature-flags";

/**
 * Request principal for a server-side, per-user feature-flag check. The Clerk
 * user id is the principal's PostHog distinct id; the internal user id is
 * carried only so a principal that has no Clerk id still resolves something.
 */
export type FeatureFlagIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

/**
 * The PostHog distinct id(s) a rollout is evaluated against for a request
 * principal: the Clerk user id when the principal has one, and the internal
 * user id ONLY as a fallback for a principal that does not (an API key whose
 * owner carries no `clerkId`), which would otherwise resolve no flags at all.
 *
 * ISS-8196: this used to return BOTH ids and the evaluator ORed their verdicts.
 * The browser identifies PostHog with the Clerk id alone
 * (`packages/analytics/hooks/use-identify-user.ts`), so on a PERCENTAGE rollout
 * — which buckets on a hash of the distinct id — the second id was an
 * independent second draw: a user bucketed OUT on the Clerk id, and therefore
 * seeing the feature off everywhere the browser renders it, could still be
 * bucketed IN on the internal id and get a server-side `true`. Two reviewers
 * raised it independently on PR #5989.
 *
 * The docstring this replaces justified the OR with "a rollout may be targeted
 * at either distinct-id namespace". The internal namespace is not targetable:
 * every `identify` call in the repo — the browser hook above and the Clerk
 * webhook handlers in `apps/api/app/webhooks/auth/auth-hooks.ts`, which pass
 * the Clerk `UserJSON.id` — establishes the CLERK id. PostHog therefore holds
 * no person, no properties and no cohort membership under an internal user id,
 * so a property- or cohort-based release condition can only ever match the
 * Clerk id, and a percentage rollout matches an internal id by coin flip rather
 * than by intent.
 *
 * Returns a list rather than one id because the empty case is real (a principal
 * carrying neither id resolves nothing, and the caller must not evaluate) and
 * because it keeps the per-id failure isolation in
 * {@link evaluateFeatureFlagForAnyIdentity} intact.
 */
export function resolveDistinctIdsForIdentity(
  identity: FeatureFlagIdentity
): string[] {
  const browserDistinctId = identity.clerkUserId;
  if (browserDistinctId) {
    return [browserDistinctId];
  }
  return identity.userId ? [identity.userId] : [];
}

/**
 * Fail-closed rollout check. Returns true only when an explicit `true` comes
 * back from the exact PostHog key for the principal's distinct id (see
 * {@link resolveDistinctIdsForIdentity}); unavailable, false, null, or a thrown
 * evaluation all resolve to false so a dark-launched feature stays unreachable
 * outside the flag.
 *
 * @param logKey - Structured-log event name emitted when flag evaluation throws.
 * @param suppression - ISS-7778: an optional blanket withholding. It can only
 *   ever contain GRANTS, so a restriction reaches PostHog whatever is passed.
 */
export async function isFeatureFlagEnabledForAnyIdentity(
  flag: RegisteredServerFeatureFlag,
  identity: FeatureFlagIdentity,
  logKey: string,
  suppression?: GrantSuppression
): Promise<boolean> {
  return (
    (await evaluateFeatureFlagForAnyIdentity(
      flag,
      identity,
      logKey,
      suppression
    )) === true
  );
}

/**
 * ISS-4556: the same rollout check as
 * {@link isFeatureFlagEnabledForAnyIdentity}, but reporting UNAVAILABLE
 * (`null`) distinctly from an evaluated `false`.
 *
 * The boolean wrapper above collapses the two, which is the right default for a
 * one-shot gate: an unreachable flag service must not open a dark-launched
 * feature. It is the wrong answer for a caller that needs several reads in one
 * page load to agree, because a transient outage on ONE of them silently
 * rewrites that read's cohort while its siblings keep the evaluated value. Such
 * a caller needs to see "could not evaluate" so it can hold its previous
 * decision instead of flipping.
 *
 * ISS-4556: UNAVAILABLE is now genuinely REACHABLE for the failure mode it was
 * built for. `isFeatureFlagEnabledForDistinctId` no longer folds posthog-node's
 * `undefined` — which is what a failed or unresolvable evaluation resolves to,
 * since it does not reject — into a definite `false`, so a PostHog outage reports
 * `null` here instead of masquerading as an evaluated OFF.
 *
 * @returns `true`/`false` when PostHog actually answered for the principal's
 *   distinct id, `null` when no evaluation was possible (the principal carries
 *   no id at all, no analytics client is configured, the client reported the
 *   flag unevaluated, or the evaluation threw).
 */
export async function evaluateFeatureFlagForAnyIdentity(
  flag: RegisteredServerFeatureFlag,
  identity: FeatureFlagIdentity,
  logKey: string,
  suppression?: GrantSuppression
): Promise<boolean | null> {
  let evaluated = false;
  for (const distinctId of resolveDistinctIdsForIdentity(identity)) {
    // ISS-8196: the resolver now yields AT MOST ONE id, so this runs zero or
    // one times and the loop exists only to make the no-id principal fall
    // through to the `null` below. The per-id try/catch shape is ISS-4556's and
    // is kept rather than hoisted: a catch around the loop would report
    // UNAVAILABLE for a definite answer PostHog had already given, and
    // UNAVAILABLE tells a memoizing caller to HOLD its previous decision — so a
    // viewer whose flag was genuinely just turned OFF would keep being served
    // the stale ON.
    let result: boolean | null = null;
    try {
      result = await evaluateServerFeatureFlagForDistinctId(
        flag,
        distinctId,
        suppression
      );
    } catch (error) {
      log.warn(logKey, {
        featureFlagKey: flag.key,
        error: parseError(error),
      });
      continue;
    }
    if (result === true) {
      return true;
    }
    // `null` means no analytics client answered for this id; only a real
    // `false` counts as an evaluation that came back negative.
    evaluated = evaluated || result !== null;
  }
  return evaluated ? false : null;
}

/**
 * ISS-8024: the WHOLE-ASSIGNMENT twin of
 * {@link evaluateFeatureFlagForAnyIdentity}, for a caller that needs every key
 * at once rather than one named key.
 *
 * Reads the assignment for the SAME distinct id the per-key check evaluates
 * (see {@link resolveDistinctIdsForIdentity}), so a desktop gate and a web gate
 * evaluated for the same person cannot disagree about which id decided them.
 *
 * ISS-8196 narrowed that resolver to at most ONE id, which retired this
 * function's cross-id merge: it landed (ISS-8024) while the resolver still
 * returned both ids and ORed them, and that OR was the second draw ISS-8196
 * removes. The merge shape is kept rather than flattened for the same reason
 * the per-key sibling keeps its loop — the no-id principal must fall through to
 * `null`, and the per-id failure isolation must survive.
 *
 * @returns the per-key verdict, or `null` when NO id produced an assignment (the
 *   principal carries no id at all, no analytics client is configured, or the
 *   read threw). `null` is UNKNOWN, not "all off"; a caller that renders from
 *   this must still fail closed.
 */
export async function getAllFeatureFlagsForAnyIdentity(
  identity: FeatureFlagIdentity,
  logKey: string
): Promise<Record<string, boolean> | null> {
  const distinctIds = resolveDistinctIdsForIdentity(identity);
  // `allSettled` keeps the per-id isolation the per-key sibling's try/catch
  // exists for: one id's rejection cannot discard another's answer.
  const settled = await Promise.allSettled(
    distinctIds.map((distinctId) => getAllFeatureFlagsForDistinctId(distinctId))
  );

  const merged: Record<string, boolean> = Object.create(null);
  let answered = false;

  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      log.warn(logKey, {
        // WHICH namespace failed, never the id itself: the value is a Clerk or
        // internal user id, and nothing here needs a user identifier to fail
        // closed. The per-key sibling above logs no identifier either.
        distinctIdKind: distinctIdKindOf(distinctIds[index], identity),
        error: parseError(outcome.reason),
      });
      continue;
    }
    if (!outcome.value) {
      continue;
    }
    answered = true;
    for (const [flag, enabled] of Object.entries(outcome.value)) {
      merged[flag] = merged[flag] === true || enabled;
    }
  }

  return answered ? { ...merged } : null;
}

/**
 * Which PostHog distinct-id namespace a flag-read failure was for, as logged by
 * {@link getAllFeatureFlagsForAnyIdentity}.
 */
export const DistinctIdKind = {
  Clerk: "clerk",
  Internal: "internal",
} as const;
export type DistinctIdKind =
  (typeof DistinctIdKind)[keyof typeof DistinctIdKind];

/**
 * ISS-8196: this replaced a positional `distinctIdIndex`, which named the
 * namespace only while {@link resolveDistinctIdsForIdentity} always returned
 * clerk-then-internal. That resolver now yields at most ONE id whose namespace
 * depends on whether the principal carries a Clerk id, so the index became a
 * constant `0` identifying nothing.
 */
function distinctIdKindOf(
  distinctId: string | undefined,
  identity: FeatureFlagIdentity
): DistinctIdKind {
  return distinctId === identity.clerkUserId
    ? DistinctIdKind.Clerk
    : DistinctIdKind.Internal;
}
