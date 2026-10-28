"use client";

import { CustomerViewProvider } from "@repo/analytics/customer-view";
import { FeatureFlagOverridesProvider } from "@repo/analytics/feature-flag-overrides";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { registerMountedCheckedFeatureFlag } from "@repo/app/shared/dev-tools/lib/checked-feature-flags-store";
import { DEV_MODE_EXEMPT_FLAG_KEYS } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-contract";
import {
  DevModeEligibility,
  DevModeProvider,
  useDevMode,
  useIsDevModeOn,
} from "@repo/app/shared/feature-flags/dev-mode/dev-mode-provider";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { ReactNode } from "react";
import { useActorEmail } from "@/hooks/use-actor-email";

/**
 * Web shell wiring for dev mode (ISS-7477): resolve who is allowed to use it,
 * then turn their choice into PostHog flag suppression.
 *
 * Eligibility is decided here, at the composition root, from the Clerk identity
 * — the same `isStaffEmail` signal `StaffParsingBugFlagProvider` and the staff
 * capture gate already use, so there is one answer to "is this an internal
 * viewer" on this surface. It is a visibility signal, not an authorization
 * boundary, and it does not need to be one: dev-mode-off can only ever REMOVE
 * capability from the viewer who chose it. Every API behind a suppressed flag
 * stays authenticated and org-scoped, so the worst a forged eligibility would
 * buy someone is a strictly smaller product.
 *
 * SCOPE, so nobody reads more into the customer view than it delivers: this
 * suppresses CLIENT flag reads only. A flag evaluated server-side per viewer —
 * `PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG` in
 * `apps/api/app/branches/branch-pensero-numerator.ts`, which decides whether the
 * branch-detail response carries the value at all — still resolves at the
 * internal viewer's own rollout, so the response data it shapes is NOT the
 * customer's. Closing that needs the choice to travel to
 * `apps/api` on the request, which is a wire contract this change deliberately
 * does not open.
 */
export function WebDevModeProvider({ children }: { children: ReactNode }) {
  const { email, isLoaded } = useActorEmail();
  // Read ABOVE `CustomerViewProvider`, so this one is never itself suppressed —
  // and `DEV_MODE_FLAG_KEY` is exempt besides, which keeps that ordering from
  // being load-bearing for a shell that nests the two differently.
  const isRolledOut = useFeatureFlagEnabled(DEV_MODE_FLAG_KEY);

  return (
    <DevModeProvider
      eligibility={resolveEligibility(isLoaded, email)}
      isRolledOut={isRolledOut}
    >
      <DevModeCustomerViewBridge>{children}</DevModeCustomerViewBridge>
    </DevModeProvider>
  );
}

/**
 * Dev mode OFF is the customer view. `useDevMode` pins a viewer known to be
 * ineligible to ON, and pins EVERYONE to ON while the rollout is off, so this
 * can neither leave a customer suppressed nor strand an internal viewer in a
 * view whose only exit the rollout has since un-rendered.
 *
 * Dev mode ON (for a viewer who may operate it) is what lets the Dev Tools
 * flag overrides apply, and what records the flags each page reads for the
 * overlay (ISS-12048).
 */
function DevModeCustomerViewBridge({ children }: { children: ReactNode }) {
  const { isDevModeEnabled } = useDevMode();
  const isDevModeOn = useIsDevModeOn();

  return (
    <CustomerViewProvider
      active={!isDevModeEnabled}
      exemptFlagKeys={DEV_MODE_EXEMPT_FLAG_KEYS}
    >
      <FeatureFlagOverridesProvider
        active={isDevModeOn}
        onFlagRead={recordBrowserFlagRead}
      >
        {children}
      </FeatureFlagOverridesProvider>
    </CustomerViewProvider>
  );
}

/**
 * `Unknown` until the identity answers — NOT `Ineligible`. The control stays
 * hidden either way, so a customer never sees it flash; what the distinction
 * buys is the other viewer, whose stored customer-view choice takes effect from
 * the first render instead of after a network round trip.
 */
function resolveEligibility(
  isLoaded: boolean,
  email: string | null
): DevModeEligibility {
  if (!isLoaded) {
    return DevModeEligibility.Unknown;
  }
  return isStaffEmail(email)
    ? DevModeEligibility.Eligible
    : DevModeEligibility.Ineligible;
}

/** ISS-12048: each flag the page reads while Dev Mode is on, for the overlay. */
function recordBrowserFlagRead(flag: string): () => void {
  return registerMountedCheckedFeatureFlag(flag);
}
