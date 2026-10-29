/**
 * @file onboarding-events.ts
 * @description The typed events that drive the onboarding machine (ISS-8349).
 *
 * Every edge in the PRD-689 finite-state diagram is one of these, so a screen
 * dispatches an intent and never names its own destination. Values only — the
 * machine that consumes them is `@repo/app`'s `onboarding-transitions.ts`.
 *
 * ISS-8375 moved this module here from `@repo/app`. The events stopped being a
 * client-internal vocabulary the moment the guided transition endpoint began
 * accepting one on the wire: the server validates `event.type` and derives the
 * `SkipAccount` / `DownloadDesktopApp` / `FinishTour` markers from it, and
 * `apps/api` cannot import `@repo/app`. Re-declaring the union server-side
 * would be SSOT drift by copy. The MACHINE stays in `@repo/app` — the server
 * still never runs a transition, it only arbitrates and persists one.
 */

import type {
  AccountProvider,
  PendingOnboardingStep,
} from "./onboarding-phase.ts";

export const OnboardingEvent = {
  /** Welcome primary action. Resolves the diagram's `HostMode` choice. */
  Start: "start",
  /** Desktop session discovery Continue. Guarded on analysis having begun. */
  ContinueFromDiscovery: "continue_from_discovery",
  /** Desktop-only "Skip for now" on the account screen. */
  SkipAccount: "skip_account",
  /** Account created or signed in. Carries the provider or account action. */
  AccountEstablished: "account_established",
  /** Create-organization confirmed, or an existing organization joined. */
  OrganizationReady: "organization_ready",
  /** Desktop sync-policy Continue. */
  ContinueFromSyncPolicy: "continue_from_sync_policy",
  /** Invitations sent. */
  SendInvitations: "send_invitations",
  /** "Skip for now" on the invite screen. */
  SkipInvitations: "skip_invitations",
  /** Installer downloaded on the Web gate. */
  DownloadDesktopApp: "download_desktop_app",
  /** Web download skip. Guarded on synced organization data existing. */
  SkipDownload: "skip_download",
  /** GitHub connected from the connect screen. */
  ConnectGitHub: "connect_github",
  /** "Skip for now" on the GitHub screen. */
  SkipGitHub: "skip_github",
  /** The blocking modal has exited; route to the tour or to Ready. */
  DashboardEntered: "dashboard_entered",
  /** Tour Done or Skip tour. */
  FinishTour: "finish_tour",
  /**
   * The tour run ended without showing anything — the dashboard had no anchor
   * to ring, so there was no tour for the reader to finish (PLN-1875 Step 9).
   *
   * It exits the tour phase and stamps NOTHING. That is the whole difference
   * from {@link OnboardingEvent.FinishTour}: a reader whose org has not synced a
   * session yet would otherwise sit in `dashboard_tour` forever, because
   * `finish_tour` is the only edge out and writing it would retire the tour for
   * exactly the cohort it exists for. The tour stays owed and is offered again
   * once the dashboard has something to show.
   */
  DeferTour: "defer_tour",
  /** The completion card was actioned. Re-enters one deferred step. */
  ResumePendingStep: "resume_pending_step",
  /** Back within the blocking flow. Pops the visited-phase history. */
  Back: "back",
} as const;
export type OnboardingEvent =
  (typeof OnboardingEvent)[keyof typeof OnboardingEvent];

type BareOnboardingEvent = Exclude<
  OnboardingEvent,
  | typeof OnboardingEvent.AccountEstablished
  | typeof OnboardingEvent.ResumePendingStep
>;

type BareOnboardingEventInput = {
  [Event in BareOnboardingEvent]: { type: Event };
}[BareOnboardingEvent];

/**
 * The dispatchable event union. Most events are bare; the two that carry data
 * do so because the destination depends on it and the context alone cannot say.
 */
export type OnboardingEventInput =
  | {
      type: typeof OnboardingEvent.AccountEstablished;
      /** GitHub also satisfies the GitHub step; Google and email do not. */
      provider: AccountProvider;
    }
  | {
      type: typeof OnboardingEvent.ResumePendingStep;
      step: PendingOnboardingStep;
    }
  | BareOnboardingEventInput;

/** Why a dispatched event did not move the machine. */
export const OnboardingRejection = {
  /** The event has no edge out of the current phase. */
  NotAllowedFromPhase: "not_allowed_from_phase",
  /** The edge exists but its guard denied it. */
  GuardBlocked: "guard_blocked",
  /** Back was dispatched with nothing left to pop. */
  NoHistory: "no_history",
  /** A resume was dispatched for a step that is not currently pending. */
  StepNotPending: "step_not_pending",
} as const;
export type OnboardingRejection =
  (typeof OnboardingRejection)[keyof typeof OnboardingRejection];
