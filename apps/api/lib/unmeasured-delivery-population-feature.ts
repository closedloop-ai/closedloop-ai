import "server-only";

import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { UNMEASURED_DELIVERY_POPULATION_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * ISS-8424: gates rendering an UNVERIFIED org-merged population as
 * not-yet-measured instead of as the number `0`.
 *
 * The perceivable change is a `0` becoming an em dash on the Delivery tiles, so
 * the closed-by-default UI policy applies. The gate is SERVER-SIDE and single,
 * not one flag per shell, because the honesty is produced by the cloud
 * producer and both shells render that one response — `apps/app` and the
 * desktop renderer read `packages/app/insights`, and desktop's org-scope
 * Insights are the cloud payload. A second desktop-side toggle could only ever
 * disagree with this one, which is the cross-surface leak the parity rule
 * exists to prevent rather than an instance of it. Modeled on the sibling
 * ISS-8148 read-side gate. Default OFF.
 *
 * The bounded resync this state also triggers is NOT gated: it writes
 * verification the surface is missing either way, and gating it would make the
 * flag's off-state slower to recover rather than merely older-looking.
 */
export const UNMEASURED_DELIVERY_POPULATION_FLAG_KEY =
  UNMEASURED_DELIVERY_POPULATION_SERVER_FLAG.key;

/** Structured-log event emitted only when flag evaluation throws. */
export const UNMEASURED_DELIVERY_POPULATION_FLAG_UNAVAILABLE_LOG_KEY =
  "unmeasured_delivery_population_flag_unavailable" as const;

/**
 * Fail-closed: an unavailable PostHog answer keeps the pre-ISS-8424 render, so
 * a flag outage can never blank a populated dashboard under a reader.
 */
export function isUnmeasuredDeliveryPopulationEnabled(
  identity: FeatureFlagIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    UNMEASURED_DELIVERY_POPULATION_SERVER_FLAG,
    identity,
    UNMEASURED_DELIVERY_POPULATION_FLAG_UNAVAILABLE_LOG_KEY
  );
}
