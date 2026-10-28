import {
  OnboardingEvent,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import {
  type OnboardingContext,
  type OnboardingMachineState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import {
  type OnboardingTransitionResult,
  transitionOnboarding,
} from "@repo/app/onboarding/lib/onboarding-transitions";

/**
 * ISS-11480 (PLN-2126 Step 3): carry a desktop guest's run from the Dashboard
 * phases to {@link OnboardingPhase.Ready}, the only phase `resume_pending_step`
 * is accepted from.
 *
 * A desktop guest's record parks on `DashboardAvailable` or `DashboardTour`:
 * the shared host posts `dashboard_entered` only while the Dashboard route is
 * active, and the desktop tour's deferral is a no-op off the tour phase. So the
 * guest run folds forward through the machine's OWN edges — `dashboard_entered`,
 * then `defer_tour` if that lands on the tour — rather than writing a phase by
 * hand. `defer_tour`, never `finish_tour`: deferral stamps no completion marker
 * (`dashboard-tour-completion.ts`), so the guest tour record stays the only
 * authority on whether the tour was seen (ISS-9728).
 *
 * Pure. The caller applies the resume to the returned state and writes only the
 * final one; the folded edges are bookkeeping, not reader actions, so they are
 * neither persisted nor captured.
 */
export function settleGuestRunToReady(
  state: OnboardingMachineState,
  context: OnboardingContext
): OnboardingTransitionResult {
  switch (state.phase) {
    case OnboardingPhase.Ready:
      return { state, status: "moved" };
    case OnboardingPhase.DashboardAvailable: {
      const entered = transitionOnboarding(
        state,
        { type: OnboardingEvent.DashboardEntered },
        context
      );
      return entered.status === "moved"
        ? settleGuestRunToReady(entered.state, context)
        : entered;
    }
    case OnboardingPhase.DashboardTour:
      return transitionOnboarding(
        state,
        { type: OnboardingEvent.DeferTour },
        context
      );
    case OnboardingPhase.Welcome:
    case OnboardingPhase.SessionDiscovery:
    case OnboardingPhase.Account:
    case OnboardingPhase.CreateOrganization:
    case OnboardingPhase.ChooseOrganization:
    case OnboardingPhase.SyncPolicy:
    case OnboardingPhase.InviteTeam:
    case OnboardingPhase.DownloadDesktop:
    case OnboardingPhase.ConnectGitHub:
      return {
        reason: OnboardingRejection.NotAllowedFromPhase,
        status: "rejected",
      };
    default:
      return unmappedPhase(state.phase);
  }
}

function unmappedPhase(phase: never): never {
  throw new Error(`settleGuestRunToReady: unmapped onboarding phase ${phase}`);
}
