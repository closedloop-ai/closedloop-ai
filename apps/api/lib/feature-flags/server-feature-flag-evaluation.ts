import { isPinnedFeatureFlagEnabled } from "@repo/analytics/feature-flag-value";
import {
  isFeatureFlagEnabledForDistinctId,
  isFeatureFlagEnabledForGroup,
  POSTHOG_ORGANIZATION_GROUP_TYPE,
  readPinnedFeatureFlags,
} from "@repo/analytics/feature-flags";
import {
  currentFeatureFlagRequestScope,
  recordCheckedServerFeatureFlag,
} from "./feature-flag-request-scope";
import {
  type GrantSuppression,
  isFlagSuppressed,
} from "./server-feature-flag-suppression";
import {
  DEV_MODE_SERVER_FLAG,
  grantSuppressionForKeys,
  type RegisteredServerFeatureFlag,
} from "./server-feature-flags";

/**
 * ISS-7778: the single point in `apps/api` where a server flag is read.
 *
 * Before this, `isFeatureFlagEnabledForDistinctId` covered fourteen of the
 * sixteen evaluation sites and two went straight to `analytics.isFeatureEnabled`
 * — so a suppression installed at the "choke point" would have missed
 * `branch-pr` and `electron-remote-update` entirely, silently and with no test
 * able to see it. Every site now routes through here, and the parameter type
 * makes that structural rather than a convention: an unclassified,
 * unregistered flag is not assignable to
 * {@link RegisteredServerFeatureFlag}, so it cannot be evaluated at all.
 *
 * A SUPPRESSED grant resolves an explicit `false`, never `null`: withholding is
 * a decision, and reporting it as "could not evaluate" would let a memoizing
 * caller hold a previous `true` straight through the suppression.
 *
 * THE OTHER HALF OF THAT CHOICE IS A CONSTRAINT ON WHOEVER WIRES SUPPRESSION IN.
 * An answered `false` is indistinguishable from a PostHog verdict once it leaves
 * here, so a suppressed read must NOT be written into a per-viewer memo or
 * published to the cross-instance decision store. ISS-12048 wires exactly such a
 * suppression (a Dev Mode override to off) and owes that bypass:
 * `createMemoizedFeatureFlagGate` asks {@link resolveUnmemoizedFeatureFlagValue}
 * first and never caches or publishes what it answers.
 *
 * ISS-12048 also makes this the request's flag RECORDER and its Dev Mode
 * override point: each key read here is noted for the overlay, and a verified
 * Dev Mode override for the caller's own distinct id wins. Overriding to off
 * goes through {@link grantSuppressionForKeys}, so a restriction can never be
 * withheld; overriding a restriction at all is refused earlier, when the
 * overrides are parsed.
 *
 * @returns `true`/`false` when PostHog ANSWERED (or a snapshot or override
 *   decided), `null` when it did not — the ISS-4556 distinction, passed through
 *   untouched.
 */
export async function evaluateServerFeatureFlagForDistinctId(
  flag: RegisteredServerFeatureFlag,
  distinctId: string,
  suppression?: GrantSuppression
): Promise<boolean | null> {
  recordCheckedServerFeatureFlag(flag.key);
  const override = await resolveRequestOverride(flag, distinctId);
  if (override === true) {
    return true;
  }
  if (isFlagSuppressed(suppression, flag) || isFlagSuppressed(override, flag)) {
    return false;
  }
  return await isFeatureFlagEnabledForDistinctId(flag.key, distinctId);
}

/**
 * ISS-12048: a value that must NOT pass through a memo or the cross-instance
 * decision store, or `undefined` when the read is an ordinary live one.
 *
 * Two kinds: a preview environment's pinned snapshot (cheap to re-read, and
 * never a decision another environment should inherit), and the caller's own
 * verified Dev Mode override (one person's choice, which must never reach
 * another viewer through a shared record).
 */
export async function resolveUnmemoizedFeatureFlagValue(
  flag: RegisteredServerFeatureFlag,
  distinctIds: readonly string[]
): Promise<boolean | undefined> {
  for (const distinctId of distinctIds) {
    const override = await resolveRequestOverride(flag, distinctId);
    if (override === true) {
      recordCheckedServerFeatureFlag(flag.key);
      return true;
    }
    if (isFlagSuppressed(override, flag)) {
      recordCheckedServerFeatureFlag(flag.key);
      return false;
    }
  }
  const pinned = await readPinnedFeatureFlags();
  if (pinned) {
    recordCheckedServerFeatureFlag(flag.key);
    return isPinnedFeatureFlagEnabled(pinned, flag.key);
  }
  return undefined;
}

/**
 * The caller's verified override for this read: `true` to force it on, a
 * suppression to force it off, `undefined` for no override.
 *
 * Only for the request's own distinct id, so a read made on someone else's
 * behalf (a notification to a loop's owner) is never touched. `dev-mode` itself
 * is never overridden here: it is what the API checks to decide whether
 * overrides apply at all.
 */
async function resolveRequestOverride(
  flag: RegisteredServerFeatureFlag,
  distinctId: string
): Promise<true | GrantSuppression | undefined> {
  const scope = currentFeatureFlagRequestScope();
  if (
    !scope ||
    scope.distinctId !== distinctId ||
    flag.key === DEV_MODE_SERVER_FLAG.key
  ) {
    return undefined;
  }
  const overrides = await scope.overrides();
  if (!(overrides && Object.hasOwn(overrides, flag.key))) {
    return undefined;
  }
  if (overrides[flag.key]) {
    return true;
  }
  return grantSuppressionForKeys(new Set([flag.key]));
}

/**
 * PLN-2187 T-2.6: a flag read for an organization's PostHog group alone, with
 * no person, so every member of the org gets the same answer and a percentage
 * rollout splits by org (marisolashgrove, #8828). A Dev Mode override is one
 * person's and never applies here; a preview's pinned snapshot does.
 *
 * @returns `null` when PostHog did not answer, as
 *   {@link evaluateServerFeatureFlagForDistinctId} does.
 */
export async function evaluateServerFeatureFlagForOrganization(
  flag: RegisteredServerFeatureFlag,
  clerkOrganizationId: string
): Promise<boolean | null> {
  recordCheckedServerFeatureFlag(flag.key);
  return await isFeatureFlagEnabledForGroup(flag.key, {
    type: POSTHOG_ORGANIZATION_GROUP_TYPE,
    key: clerkOrganizationId,
  });
}
