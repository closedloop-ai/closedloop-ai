import {
  type OnboardingAccountModes,
  OnboardingFailureReason,
} from "@repo/api/src/types/onboarding-analytics.ts";
import type { DesktopBrowserSignInFailure } from "../../shared/contracts.js";

/** A snapshot of one live onboarding attempt; never an install identity. */
export type DesktopSignInAnalytics = {
  register(codeChallenge: string): void;
  failed(
    accountMode: OnboardingAccountModes,
    reason: OnboardingFailureReason
  ): void;
};

const FAILURE_REASONS: Record<
  DesktopBrowserSignInFailure,
  OnboardingFailureReason
> = {
  unavailable: OnboardingFailureReason.Unavailable,
  already_in_progress: OnboardingFailureReason.AlreadyInProgress,
  start_failed: OnboardingFailureReason.StartFailed,
  open_failed: OnboardingFailureReason.OpenFailed,
  redirect_timeout: OnboardingFailureReason.RedirectTimeout,
  state_mismatch: OnboardingFailureReason.StateMismatch,
  expired: OnboardingFailureReason.Expired,
  cancelled: OnboardingFailureReason.Cancelled,
  declined: OnboardingFailureReason.Cancelled,
  exchange_failed: OnboardingFailureReason.ExchangeFailed,
};

export function onboardingFailureReason(
  reason: DesktopBrowserSignInFailure
): OnboardingFailureReason {
  return FAILURE_REASONS[reason];
}
