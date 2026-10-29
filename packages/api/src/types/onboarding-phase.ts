/**
 * @file onboarding-phase.ts
 * @description The canonical onboarding vocabulary (ISS-8349, PRD-689): the
 * phases a guided onboarding run can occupy, the cohort axes its guards branch
 * on, and the deferred-completion steps it can resume into.
 *
 * This module is deliberately VALUES ONLY — no Zod, no React, no transition
 * logic — so a bundle-sensitive `"use client"` surface can import a phase
 * constant without pulling in the parser (`onboarding-persistence.ts`) or the
 * machine (`onboarding-transitions.ts`).
 *
 * The normative source is the Web Master v2 canonical branch: the finite-state
 * diagram in PRD-689 and its state owner,
 * `packages/app/shell/v2/components/web-master-preview/components/web-master-shell.tsx`. Phase
 * names here are the production spelling; the prototype's shorter labels map as
 * `next` → {@link OnboardingPhase.Account},
 * `parsing` → {@link OnboardingPhase.SessionDiscovery},
 * `sync-options` → {@link OnboardingPhase.SyncPolicy},
 *  and `complete` → {@link OnboardingPhase.DashboardAvailable}.
 */

/**
 * The states of the onboarding finite-state contract.
 *
 * The diagram's `HostMode`, `OrganizationKind`, `AfterOrganization`,
 * `AfterInitialInvite`, and `PendingStep` are CHOICE pseudo-states, not
 * phases — they are resolved by the guards in `onboarding-transitions.ts` and
 * `onboarding-completion.ts`, so a persisted phase is always a real screen.
 */
export const OnboardingPhase = {
  /** Blocking introduction. Desktop and Web differ only in the primary action. */
  Welcome: "welcome",
  /** Desktop-only local source discovery and analysis progress. */
  SessionDiscovery: "session_discovery",
  /** Create an account or sign in. Required on Web, skippable on Desktop. */
  Account: "account",
  /** First member confirms a prefilled organization profile. */
  CreateOrganization: "create_organization",
  /** A later member joins a matched organization or creates another. */
  ChooseOrganization: "choose_organization",
  /**
   * Desktop-only sync policy choice, taken after the organization step so the
   * answer is recorded against a real organization (ISS-10890). A guest who
   * skips the account never reaches it.
   */
  SyncPolicy: "sync_policy",
  /** Invite teammates, or skip. */
  InviteTeam: "invite_team",
  /** Web-only installer gate. Skippable only with synced organization data. */
  DownloadDesktop: "download_desktop",
  /** Connect GitHub for PR attribution, or skip. */
  ConnectGitHub: "connect_github",
  /**
   * The diagram's `Complete`: the blocking modal has exited and the Dashboard
   * is available. Transient — {@link OnboardingEvent.DashboardEntered} routes
   * on to the tour or to {@link OnboardingPhase.Ready}.
   */
  DashboardAvailable: "dashboard_available",
  /** The six-step Dashboard spotlight tour. */
  DashboardTour: "dashboard_tour",
  /** Resting state: Dashboard with no blocking onboarding UI. */
  Ready: "ready",
} as const;
export type OnboardingPhase =
  (typeof OnboardingPhase)[keyof typeof OnboardingPhase];

/** Which surface is running the flow. Drives the diagram's `HostMode` choice. */
export const OnboardingHost = {
  Desktop: "desktop",
  Web: "web",
} as const;
export type OnboardingHost =
  (typeof OnboardingHost)[keyof typeof OnboardingHost];

/**
 * Which organization branch applies. Drives the diagram's `OrganizationKind`
 * choice — membership and whether an organization is already active, NOT host
 * mode, select create-vs-choose.
 */
export const OrganizationMembership = {
  FirstUser: "first_user",
  ExistingMember: "existing_member",
} as const;
export type OrganizationMembership =
  (typeof OrganizationMembership)[keyof typeof OrganizationMembership];

/**
 * The provider or account action the account was established with. GitHub auth
 * also satisfies the GitHub connection step; Google and email leave it pending.
 */
export const AccountProvider = {
  Email: "email",
  GitHub: "github",
  Google: "google",
} as const;
export type AccountProvider =
  (typeof AccountProvider)[keyof typeof AccountProvider];

/**
 * How far account setup got. `Skipped` is composed only by Desktop's
 * signed-out guest card; since ISS-11256 no server snapshot derives it, and
 * readers keep handling it for a skewed producer that still does.
 */
export const AccountStatus = {
  None: "none",
  Skipped: "skipped",
  Established: "established",
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

/**
 * A tri-state boolean for guard inputs whose producer can fail.
 *
 * PRD-689 (blind-scope capability authority): "Unknown/error is not false and
 * never grants a capability." A plain `boolean` cannot carry that distinction,
 * so a failed or still-loading read arrives as {@link KnownFlag.Unknown} and
 * the guard denies rather than inventing permission from a missing answer.
 */
export const KnownFlag = {
  Yes: "yes",
  No: "no",
  Unknown: "unknown",
} as const;
export type KnownFlag = (typeof KnownFlag)[keyof typeof KnownFlag];

/**
 * A step the user deferred, resumable one at a time from the sidebar card after
 * the tour. Declaration order here is NOT the priority order — that is
 * `PENDING_STEP_PRIORITY` in `onboarding-completion.ts`, which is derived from
 * an exhaustive record so a new member cannot be silently left unranked.
 */
export const PendingOnboardingStep = {
  CreateAccount: "create_account",
  DownloadDesktop: "download_desktop",
  ConnectGitHub: "connect_github",
  InviteTeam: "invite_team",
  ChooseSessionSync: "choose_session_sync",
} as const;
export type PendingOnboardingStep =
  (typeof PendingOnboardingStep)[keyof typeof PendingOnboardingStep];

/**
 * Everything the guards read. Adapters translate platform data into exactly
 * this shape, so Web and Desktop cannot diverge on what a branch means.
 */
export type OnboardingContext = {
  host: OnboardingHost;
  membership: OrganizationMembership;
  accountStatus: AccountStatus;
  accountProvider: AccountProvider | null;
  /** GitHub completion fact; modern server snapshots measure installation or personal registry status. */
  githubConnected: boolean;
  /** Present only when the server measured the GitHub data connection status. */
  githubDataConnectionStatusMeasured?: true;
  desktopAppDownloaded: boolean;
  /**
   * Authority: ISS-8375. Since ISS-12482 this no longer gates the Web download
   * skip (`membership` does); its live reader is the required-phase swap in
   * `apps/api/app/onboarding/guided/snapshot-service.ts`.
   */
  organizationHasSyncedSessionData: KnownFlag;
  teamInvited: boolean;
  /** Desktop-local consent record authority. Unknown never completes recovery. */
  syncConsentRecorded: KnownFlag;
  /** Desktop: whether local analysis has actually begun. Gates Continue. */
  analysisStarted: boolean;
  tourCompleted: boolean;
  /**
   * Whether the session is already acting in an organization. Clerk's own
   * session task creates one at signup, so a first user usually arrives with
   * one, and the organization branch must not create a second (ISS-11090).
   * `No` is a loaded, signed-in session with no active organization; a session
   * still loading, signed out, or with no auth provider is `Unknown`, and only
   * `No` may create one.
   */
  organizationActive: KnownFlag;
};

/** The persisted machine state: where the user is and how they got there. */
export type OnboardingMachineState = {
  phase: OnboardingPhase;
  /** Visited phases, oldest first. Back pops the tail. */
  history: readonly OnboardingPhase[];
  /**
   * The provider or account action accepted by the account step. Persisted so a
   * non-OAuth email signup still routes through the later GitHub step after a
   * snapshot refresh.
   */
  accountProvider: AccountProvider | null;
  /**
   * True while the user is inside a step resumed from the completion card
   * rather than the initial blocking run. It changes where InviteTeam exits to,
   * which is the diagram's `InviteTeam --> Complete: Resumed checklist step`
   * edge.
   */
  resuming: boolean;
  /**
   * True once an organization has been confirmed or joined. Resuming a step
   * resets {@link history}, so this cannot be recovered from the visited path:
   * a Desktop user who took `SkipAccount` reached the Dashboard without ever
   * running the organization/sync/invite tail, and only this flag distinguishes
   * them from a user who genuinely finished it.
   */
  organizationEstablished: boolean;
};

/** The phases that are only reachable on Desktop. */
const DESKTOP_ONLY_PHASES: readonly OnboardingPhase[] = [
  OnboardingPhase.SessionDiscovery,
  OnboardingPhase.SyncPolicy,
];

/** The phases that are only reachable on Web. */
const WEB_ONLY_PHASES: readonly OnboardingPhase[] = [
  OnboardingPhase.DownloadDesktop,
];

/**
 * Whether `phase` can be occupied on `host`. Used by the persistence fallback:
 * a state restored onto the other surface (a user who onboarded on Web opening
 * Desktop) must not resume into a screen that host never renders.
 */
export function isPhaseReachableOnHost(
  phase: OnboardingPhase,
  host: OnboardingHost
): boolean {
  if (host === OnboardingHost.Desktop) {
    return !WEB_ONLY_PHASES.includes(phase);
  }
  return !DESKTOP_ONLY_PHASES.includes(phase);
}

/** The state a fresh run starts from, and the target of every safe recovery. */
export function createInitialOnboardingState(): OnboardingMachineState {
  return {
    phase: OnboardingPhase.Welcome,
    history: [],
    accountProvider: null,
    resuming: false,
    organizationEstablished: false,
  };
}

/**
 * Whether the blocking modal is open in `phase`. It closes only by reaching the
 * Dashboard through a defined transition — never by Escape or outside click.
 *
 * Lives here rather than beside the machine because the server needs the same
 * answer: `guidedOnboardingSnapshotService` folds an already-onboarded account
 * to a settled run, and that fold must reach ONLY the phases that would
 * otherwise reopen the takeover — a `DashboardAvailable` or `DashboardTour`
 * response it swallowed would cost the host a handoff the machine still owes
 * (ISS-9916).
 */
export function isBlockingPhase(phase: OnboardingPhase): boolean {
  return (
    phase !== OnboardingPhase.DashboardAvailable &&
    phase !== OnboardingPhase.DashboardTour &&
    phase !== OnboardingPhase.Ready
  );
}
