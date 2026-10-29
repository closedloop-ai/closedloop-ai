import type { NextResponse } from "next/server";
import {
  DesktopConnectRejectionCause,
  DesktopConnectStage,
  type DesktopContractErrorBody,
  desktopConnectRejected,
  desktopContractError,
} from "@/app/desktop/contract";
import { DesktopManagedFeatureFlagOutcome } from "@/lib/auth/desktop-managed-pop";

/**
 * The refusal a rollout-flag evaluation earns, or `null` when enforcement is
 * on and approval may proceed.
 *
 * ISS-8132: the fail-closed default is deliberate and unchanged — a flag that
 * is off, or that could not be reached, still refuses the approval. What the
 * two arms must NOT share is retryability. A provider outage answered with the
 * non-retryable 403 told the browser this approval is permanently forbidden,
 * so it rendered a terminal failure state and stopped; the retryable 503 leaves
 * the request approvable and the user can try again once PostHog is back.
 * `cause` keeps the counter from reading that outage as a confirmed approval
 * failure, the same split ISS-6692 drew on /desktop/onboarding-attempt.
 */
export function popEnforcementRejection(
  outcome: DesktopManagedFeatureFlagOutcome,
  orgId: string
): NextResponse<DesktopContractErrorBody<string>> | null {
  switch (outcome) {
    case DesktopManagedFeatureFlagOutcome.Enabled:
      return null;
    case DesktopManagedFeatureFlagOutcome.Disabled:
      return desktopContractError(
        403,
        "DESKTOP_SECURITY_UPGRADE_DISABLED",
        false
      );
    case DesktopManagedFeatureFlagOutcome.Faulted:
      // Reuses the 503 code this route already answers for a failed approval,
      // so an already-installed Desktop or browser build needs no upgrade to
      // handle it.
      return desktopConnectRejected(
        503,
        "DEVICE_SESSION_APPROVAL_FAILED",
        true,
        {
          stage: DesktopConnectStage.DeviceOnboardingApprove,
          orgId,
          cause: DesktopConnectRejectionCause.FeatureFlagLookupFaulted,
        }
      );
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
