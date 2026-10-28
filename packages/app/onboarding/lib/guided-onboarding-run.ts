import type { OnboardingEventInput } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import type { OnboardingTransitionAnalyticsOutcome } from "./onboarding-funnel-analytics";

/**
 * Where one guided onboarding run comes from, as a value the host is handed
 * rather than a source it reaches for itself.
 *
 * The default is still the server: `GuidedOnboardingDialogHost` reads
 * `/onboarding/guided/snapshot` and posts every transition back, and nothing
 * about that path changes. This type exists for the ONE reader the server
 * cannot answer for — a signed-out desktop guest.
 *
 * ISS-10195 retired the `workspace-experience-v2` gate so "even guest users on
 * desktop get onboarding experience v2", but removing the gate did not reach
 * them: `useGuidedOnboardingSnapshot` gates its query on
 * `isLoaded && userId !== null`, so a guest never fires the request, `data`
 * stays `undefined`, and the host's `open` is `false` for want of a snapshot
 * rather than because of any phase. The gate was one of TWO blockers and only
 * the first was removed.
 *
 * The shape is the server's own, deliberately. A guest run is the same machine
 * over the same `GuidedOnboardingSnapshot`, persisted somewhere else — not a
 * second flow with its own phases. Everything downstream of `snapshot` in the
 * host (phase resolution, guards, the dialog itself) is therefore untouched,
 * which is what keeps a guest and an account on one implementation.
 *
 * This is ISS-9728's ruling applied to the modal instead of the tour: for the
 * unauthenticated mode, local state governs, because there is no account to ask
 * PostHog or the API about.
 */
export type GuidedOnboardingRun = {
  /** A verified bootstrap handoff has no org yet, without granting normal auth. */
  awaitingOrganization?: boolean;
  /** The run to render, or `null` when this source has no run to offer. */
  snapshot: GuidedOnboardingSnapshot | null;
  /**
   * Whether the run is still being read. Drives the dialog's `restoring`, so a
   * source that answers synchronously reports `false` rather than inventing a
   * loading frame the reader would see flicker.
   */
  isLoading: boolean;
  /**
   * Apply one event to `snapshot`. Mirrors the server poster's signature so the
   * host calls one function either way.
   *
   * A source owns rejection: the machine is pure and a rejected event must
   * leave the run untouched, exactly as the server path's pre-flight
   * `transitionOnboarding` already guarantees before it posts.
   */
  postTransition: (
    snapshot: GuidedOnboardingSnapshot,
    event: OnboardingEventInput,
    callbacks?: {
      onSettled?: () => void;
      /** PRD-736 step-outcome facts, captured at the source's acceptance site (ISS-10502). */
      analytics?: OnboardingTransitionAnalyticsOutcome;
    }
  ) => void;
};
