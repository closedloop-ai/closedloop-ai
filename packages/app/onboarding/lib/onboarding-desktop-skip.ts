/**
 * @file ISS-8350: whether the Web installer step may be skipped, derived from
 * the snapshot's `membership`.
 *
 * THIS MODULE DOES NOT DECIDE WHETHER SKIPPING IS ALLOWED. That question has one
 * owner — `canSkipDesktopDownload` in `@repo/api/src/types/onboarding-completion`
 * (ISS-8349) — and the onboarding transition engine already gates on it. What
 * this module adds is the third state the predicate cannot express: a boolean
 * has no way to say "nobody supplied this", and the predicate answers `false`
 * for a first user and an unread value alike.
 *
 * ORDER MATTERS. An unrecognised value is resolved BEFORE delegating.
 * Delegating first would fold an absent answer into
 * {@link OnboardingDesktopSkipEligibility.Required} and tell the reader they are
 * the organization's first user on a value nobody read.
 */

import { canSkipDesktopDownload } from "@repo/api/src/types/onboarding-completion";
import { OrganizationMembership } from "@repo/api/src/types/onboarding-phase";
import { OnboardingDesktopSkipEligibility } from "../components/guided-onboarding-data";

/**
 * What the download step should offer, given the snapshot's `membership`
 * exactly as it arrived.
 *
 * `raw` is `unknown` on purpose. `GuidedOnboardingSnapshot` is a plain type with
 * no response-side schema, so this value reaches the client as unvalidated JSON:
 * an absent field, a spelling from a newer or older peer, or a non-string are
 * all reachable at runtime however the types read. Every one of them is an
 * absent answer, and an absent answer is never permission to skip.
 */
export function deriveOnboardingDesktopSkipEligibility(
  raw: unknown
): OnboardingDesktopSkipEligibility {
  const membership = Object.values(OrganizationMembership).find(
    (known) => known === raw
  );
  if (membership === undefined) {
    return OnboardingDesktopSkipEligibility.Unknown;
  }
  return canSkipDesktopDownload({ membership })
    ? OnboardingDesktopSkipEligibility.Eligible
    : OnboardingDesktopSkipEligibility.Required;
}
