import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type {
  DesktopDownloadHrefs,
  DesktopOs,
} from "../lib/desktop-platform-availability";
import type {
  AccountEstablishedOnboardingEvent,
  OrganizationReadyOnboardingEvent,
} from "../lib/guided-onboarding-events";
import type { AuthMethod } from "./auth-methods";
import type {
  OnboardingAccount,
  OnboardingAnalysisProgress,
  OnboardingDesktopSkipEligibility,
  OnboardingGitHubConnection,
  OnboardingInviteOutcome,
  OnboardingJoinableOrganization,
  OnboardingOrganizationJoin,
  OnboardingOrganizationMembers,
  OnboardingSessionDiscovery,
} from "./guided-onboarding-data";
import type { SyncConsentLevel } from "./sync-consent";

export const GuidedSyncLevel = DataSyncLevel;

export type OrganizationDetails = {
  name: string;
  /** Transient logo file for hosts that must create the organization first. */
  logoFile?: File;
  slug: string;
};

/** Host-owned organization-logo mutation; shared onboarding stays provider-neutral. */
export type OrganizationLogoUploadHandler = (file: File) => Promise<void>;

/** Host-owned organization creation; shared onboarding stays provider-neutral. */
export type OrganizationCreationHandler = (
  organization: OrganizationDetails
) => Promise<void> | void;

/**
 * Host-owned rename of the organization the session is ALREADY acting in
 * (ISS-11253). Distinct from {@link OrganizationCreationHandler} because the
 * underlying provider calls are different operations: creating a second
 * organization for a first user whose organization Clerk's signup task already
 * made is the ISS-11090 defect, so a host backs this with an update of the
 * active organization and never with a create.
 */
export type OrganizationRenameHandler = (organization: {
  name: string;
  slug: string;
}) => Promise<void> | void;

/**
 * Whether the guided wizard has a screen for a phase. Exhaustive over
 * {@link OnboardingPhase}, so a phase added to the machine fails `tsc` here
 * until someone states whether the modal renders it. A `ReadonlySet` or an
 * array of phase names would compile with a member missing, which is the hole
 * this shape closes (ISS-8345).
 */
const WIZARD_RENDERS_PHASE = {
  [OnboardingPhase.Welcome]: true,
  [OnboardingPhase.SessionDiscovery]: true,
  [OnboardingPhase.Account]: true,
  [OnboardingPhase.CreateOrganization]: true,
  [OnboardingPhase.ChooseOrganization]: true,
  [OnboardingPhase.SyncPolicy]: true,
  [OnboardingPhase.DownloadDesktop]: true,
  [OnboardingPhase.InviteTeam]: true,
  [OnboardingPhase.ConnectGitHub]: true,
  // The blocking modal has exited by these three: the resting Dashboard, the
  // spotlight tour, and Ready belong to the shell, not to the wizard.
  //
  // `dashboard_available` is the phase the modal CLOSES on, so it never renders
  // with the dialog mounted: `isBlockingPhase` in `../lib/onboarding-transitions.ts`
  // returns false for it, and the wizard's only host closes on it
  // (`open: !ready || state.phase !== DashboardAvailable` in the web-master
  // prototype's `use-web-master-onboarding-controller.ts`). The remaining
  // `!ready` disjunct keeps the dialog open only while `restoring` is also true,
  // which overrides the body with the restoring step. It was classified `true`
  // and paired with the ANALYSIS screen, so the phase at which analysis has
  // finished would have rendered "analyzing your sessions" — the render the
  // deleted `default:` branch used to give it, kept explicit rather than
  // re-examined (ISS-8345).
  [OnboardingPhase.DashboardAvailable]: false,
  [OnboardingPhase.DashboardTour]: false,
  [OnboardingPhase.Ready]: false,
} as const satisfies Record<OnboardingPhase, boolean>;

/** The {@link OnboardingPhase} members the guided wizard renders a screen for. */
export type WizardPhase = {
  [Phase in OnboardingPhase]: (typeof WIZARD_RENDERS_PHASE)[Phase] extends true
    ? Phase
    : never;
}[OnboardingPhase];

/**
 * {@link WizardPhase} as a runtime list, derived from the same record the type
 * is. A union has no runtime representation, so a consumer that must validate a
 * phase it did not type — a persisted snapshot, a URL param — needs the members
 * as values; deriving them here keeps that consumer from hand-rolling a second
 * enumeration that answers the identical question and has to be updated in
 * lockstep with this one (ISS-8345).
 *
 * Kept beside {@link WIZARD_RENDERS_PHASE} rather than at the bottom of the file
 * because it is only correct as long as it reads from that record.
 *
 * REMOVING a member from that record can be a storage migration, not just a
 * render decision. A consumer that validates PERSISTED state against this list
 * — the web-master prototype's localStorage snapshot is one — narrows the set it
 * accepts when this one shrinks, so a phase that leaves retroactively
 * invalidates every stored snapshot sitting at it, which reads as a corrupt
 * snapshot and silently restarts the flow. Either bump that consumer's storage
 * version in the same change (`GUIDED_FTUE_STORAGE_VERSION` in
 * `guided-ftue-state.ts`), or keep its accepted set unchanged by re-adding the
 * departing phase there — which is what ISS-8345 did when
 * `dashboard_available` left: the prototype rests at that phase with the modal
 * closed, so it stays a valid PERSISTED phase while ceasing to be a RENDERED
 * one. Adding a member is safe.
 */
export const WIZARD_PHASES: readonly WizardPhase[] = Object.values(
  OnboardingPhase
).filter((phase): phase is WizardPhase => WIZARD_RENDERS_PHASE[phase]);

/**
 * Whether the wizard has a screen for `phase` — the runtime half of
 * {@link WizardPhase}, read straight off {@link WIZARD_RENDERS_PHASE} so it can
 * never disagree with the type. For a host holding a phase the wizard does not
 * necessarily render: one resting at `dashboard_available` with the modal
 * closed, or one restoring a persisted phase it did not type.
 */
export function isWizardPhase(phase: OnboardingPhase): phase is WizardPhase {
  return WIZARD_RENDERS_PHASE[phase];
}

export type GuidedOnboardingAnnotations = Partial<
  Record<WizardPhase, React.ReactNode>
>;

/**
 * Product content a host places at the top of a wizard step's body
 * (ISS-12363). The same shape as {@link GuidedOnboardingAnnotations} but a
 * different kind of thing: annotations are prototype design notes, these are
 * shipped UI. Separate aliases keep one from being passed as the other.
 */
export type GuidedOnboardingStepNotices = Partial<
  Record<WizardPhase, React.ReactNode>
>;

export type GuidedOnboardingDialogProps = {
  /**
   * Measured data the wizard may present. Each defaults to its explicit
   * `unknown` variant, never to a plausible value — a host that has not resolved
   * one yet gets an honest pending render instead of an invented number
   * (ISS-8678). See `./guided-onboarding-data.ts`.
   */
  account?: OnboardingAccount;
  discovery?: OnboardingSessionDiscovery;
  /**
   * Whether GitHub is connected (ISS-8352). Derive it with
   * `../lib/onboarding-github-connection.ts` rather than assembling one here —
   * the connected predicate has a single owner and this is not it.
   */
  githubConnection?: OnboardingGitHubConnection;
  joinableOrganization?: OnboardingJoinableOrganization;
  members?: OnboardingOrganizationMembers;
  /**
   * What the host's invitation send actually did. Supplied, it is authoritative
   * for the invite step's confirmation and states the server's own counts.
   * Omitted, the step keeps announcing the send optimistically, which is the
   * behaviour every current caller relies on.
   */
  inviteOutcome?: OnboardingInviteOutcome;
  /**
   * Whether the analyzer has reported enough for Session Discovery's Continue
   * to be pressable. Supplied by a host that also gates the machine edge on it,
   * so the button and the transition cannot disagree; omitted, it is derived
   * from `discovery` and `progress` with `onboardingAnalysisHasStarted`.
   */
  analysisStarted?: boolean;
  accountCreated?: boolean;
  accountMethod?: AuthMethod | null;
  /** Desktop-only account deferral. Ignored in Web mode. */
  allowSkipAccount?: boolean;
  /**
   * Whether the Web installer step offers `Skip for now` (ISS-8350). Derive it
   * with `../lib/onboarding-desktop-skip.ts` rather than assembling one here —
   * the skippable predicate has a single owner and this is not it.
   *
   * Omitted, it defaults to `unknown`, which withholds Skip: a host that has not
   * resolved the organization's synced-data flag must not offer a deferral on a
   * value nobody measured.
   */
  desktopSkipEligibility?: OnboardingDesktopSkipEligibility;
  allowStagedOrganizationLogo?: boolean;
  annotations?: GuidedOnboardingAnnotations;
  /**
   * Product content a host places at the top of a step's body. Only the sync
   * step renders one today: the Web setup gate's acknowledgement and
   * explanation (ISS-12363). An entry for any other phase is ignored.
   * Distinct from {@link annotations}, which are design notes for a prototype
   * reader and never product UI. Omitted, every step renders exactly as before.
   */
  stepNotices?: GuidedOnboardingStepNotices;
  brand: React.ReactNode;
  desktopAppDownloaded?: boolean;
  /** Whether this user's Desktop app is currently reachable. */
  desktopAppRunning?: boolean;
  desktopMode?: boolean;
  /** Controlled in-flight state while a GitHub connect handoff runs. */
  githubConnecting?: boolean;
  /**
   * Why the last GitHub connect handoff could not be opened, or `null`.
   * Host-owned and host-worded, exactly like {@link syncError}: the shell
   * reports the outcome and never classifies it.
   *
   * Omitted, the GitHub step renders no failure — which is what made a rejected
   * desktop handoff a silent dead click (ISS-10990).
   */
  githubConnectError?: string | null;
  /** Controlled in-flight method while the host's account sign-in runs. */
  accountPendingMethod?: AuthMethod | null;
  /**
   * Why the last account sign-in failed, or `null`. Host-owned and host-worded,
   * like {@link githubConnectError}. Omitted, the Account step renders none.
   */
  accountSignInError?: string | null;
  /**
   * Installer URL per platform. Host-owned: no release URL is baked into the
   * step (see `guided-onboarding-download-step.tsx`).
   */
  downloadHrefs: DesktopDownloadHrefs;
  /**
   * PREVIEW ONLY: a platform the download step shows INSTEAD of the one it
   * reads itself, so a prototype can show the Windows variant to a designer on
   * a Mac (ISS-12364). A production host omits it and the step reads the
   * browser's own platform, as it always has.
   *
   * Only a concrete `DesktopOs`, deliberately: the step's own read can also be
   * `null` ("not read yet") or `unrecognized`, and accepting those here made
   * `undefined` and `null` mean different things on one prop, where a host
   * passing `null` for "read it yourself" would freeze the step on its
   * not-read-yet arm (marisolashgrove, review of #8983). There is no value of
   * this prop that reaches that arm.
   */
  platformOverride?: DesktopOs;
  /**
   * Content for the download step's installer-gap arm, between the gap alert
   * and `Continue without installing` (ISS-12364). Omitted, the step renders
   * exactly as before.
   */
  installerGapFollowUp?: (os: DesktopOs) => React.ReactNode;
  existingOrganizationLogo?: React.ReactNode;
  invitedEmails?: readonly string[];
  newOrganizationLogo?: React.ReactNode;
  onBack?: () => void;
  onComplete: () => void;
  onConnectGitHub?: () => void;
  onCreateOrganization?: (
    organization: OrganizationDetails,
    event: OrganizationReadyOnboardingEvent
  ) => Promise<void> | void;
  onContinue?: () => void;
  onContinueFromDownload?: () => void;
  onContinueWithoutInstalling?: () => void;
  /** Advances past an already-connected GitHub step. */
  onContinueFromGitHub?: () => void;
  onContinueFromInvites?: () => void;
  onContinueFromOrganization?: (
    event: OrganizationReadyOnboardingEvent
  ) => void;

  /**
   * Honor the Join button for an organization the account has not activated.
   *
   * The host performs the provider call its `OnboardingOrganizationJoin`
   * authority names — activate a membership, accept an invitation — and the
   * phase advances ONLY when that call resolves. Without this the button would
   * advance the run without joining anything, which is a control reporting work
   * it did not do. Absent where a host has no way to act, in which case no Join
   * affordance is offered at all.
   */
  onJoinOrganization?: (join: OnboardingOrganizationJoin) => void;
  /**
   * Re-run the membership/invitation lookup after it reported a FAILURE
   * (ISS-11158).
   *
   * Only the host holds the read, so only the host can re-issue it. Supplying
   * this is what puts a Retry on the Choose-organization step's `unavailable`
   * arm; the arm itself renders either way, because a failure with no escape is
   * still a truer statement than the pending skeleton's.
   */
  onRetryJoinableOrganizationLookup?: () => void;
  /**
   * Advances past the sync step, carrying the level the user chose so the host
   * can persist THAT value rather than re-reading a copy of its own. A host that
   * only advances still satisfies this: a zero-argument callback is assignable.
   */
  onContinueFromSync?: (level: SyncConsentLevel) => void;
  onContinueWithEmail?: (
    email: string,
    event: AccountEstablishedOnboardingEvent
  ) => void;
  onContinueWithGitHub?: (event: AccountEstablishedOnboardingEvent) => void;
  onContinueWithGoogle?: (event: AccountEstablishedOnboardingEvent) => void;
  onDownloadApp?: () => void;
  onInviteTeam?: (emails: readonly string[]) => void;
  /**
   * Renames the already-active organization from the choose step, then advances.
   * Supplying it is what RENDERS the editable name and slug there; a host with
   * no rename capability supplies nothing and the step stays a confirmation
   * (ISS-11253).
   */
  onRenameOrganization?: (
    organization: { name: string; slug: string },
    event: OrganizationReadyOnboardingEvent
  ) => void;
  onUploadOrganizationLogo?: OrganizationLogoUploadHandler;
  /**
   * The Account step's "Already have an account? Sign in" control.
   *
   * Omitted it falls back to `onComplete`, which is what Web relies on: there,
   * completing the step IS the route to an existing account. Desktop has to
   * supply one, because its `onComplete` only posts a transition for an
   * ESTABLISHED account — so a signed-out guest pressing Sign in navigated
   * underneath a dialog that never closed, and never reached `beginSignIn`.
   */
  onSignIn?: () => void;
  onSignOut?: () => void;
  onSkipAccount?: () => void;
  onSkipDownload?: () => void;
  /** Defers GitHub authorization during optional onboarding. */
  onSkipGitHub?: () => void;
  onSkipInvites?: () => void;
  onStart?: () => void;
  /**
   * Chosen "Create new organization" from the choose-organization list.
   *
   * No production host supplies it, so that row does not render on either
   * shell, and the CreateOrganization phase has no edge out of Choose in
   * `PHASE_EDGES` — deliberately: routing there created a SECOND organization
   * for a first user whose organization Clerk's task had already made
   * (ISS-11090). The naming capability that route carried is
   * {@link GuidedOnboardingDialogProps.onRenameOrganization} instead, on the
   * choose step itself (ISS-11253).
   */
  onStartCreateOrganization?: () => void;
  onSyncLevelChange?: (level: SyncConsentLevel) => void;
  open: boolean;
  organizationChosen?: boolean;
  /**
   * The proposed company name inferred from the visitor's email domain,
   * pre-filling only the new-organization form. Empty means "not inferred" —
   * the copy then says "your company" rather than naming one.
   */
  organizationName?: string;
  organizationSlug?: string;
  /** Why the last organization create failed, or `null`. Host-owned. */
  organizationCreationError?: string | null;
  /** Whether the host is creating the organization. */
  organizationCreating?: boolean;
  /** Why the last organization JOIN failed, or `null`. Host-owned. */
  organizationJoinError?: string | null;
  /** Whether the host is joining the organization the reader picked. */
  organizationJoining?: boolean;
  /** Why the last organization rename failed, or `null`. Host-owned. */
  organizationRenameError?: string | null;
  /** Whether the host is renaming the organization. */
  organizationRenaming?: boolean;
  phase?: WizardPhase;
  privacyHref?: string;
  /**
   * How far the local analysis has got. A union rather than a number because
   * `0` and "nobody has reported yet" are different screens, and defaulting to
   * the former renders a measurement no host took (ISS-8678).
   */
  progress?: OnboardingAnalysisProgress;
  restoring?: boolean;
  /** Why the last sync-level write failed, or `null`. Host-owned. */
  syncError?: string | null;
  syncLevel?: SyncConsentLevel | null;
  /** Whether a sync-level write is in flight. Host-owned. */
  syncSaving?: boolean;
  termsHref?: string;
};

/**
 * The dialog props each phase's own default has already been applied to. Listed
 * rather than derived because "has a default" is a fact about the shell's
 * destructure, not about the type.
 *
 * The list is hand-kept and only ONE of its two failure directions is loud. A
 * member added HERE without a matching default in `guided-onboarding-dialog.tsx`
 * cannot build the source and fails `tsc`. The reverse is SILENT: give a prop a
 * default or resolved value in the shell and forget this list, and it stays
 * optional on {@link GuidedOnboardingPhaseSource}, so every selector reading it
 * defaults it a second time — the shell-defaults-then-selector-defaults-again
 * drift ISS-8345 removed, reintroduced one prop at a time with nothing to catch
 * it. Closing that half means deriving both the list and the shell's resolved
 * values from one defaults record; until then, adding a resolved prop means
 * editing this list by hand.
 */
type ResolvedDialogProp =
  | "account"
  | "accountCreated"
  | "analysisStarted"
  | "accountMethod"
  | "accountPendingMethod"
  | "accountSignInError"
  | "allowSkipAccount"
  | "allowStagedOrganizationLogo"
  | "annotations"
  | "desktopAppDownloaded"
  | "desktopMode"
  | "desktopSkipEligibility"
  | "discovery"
  | "githubConnectError"
  | "githubConnecting"
  | "githubConnection"
  | "invitedEmails"
  | "joinableOrganization"
  | "members"
  | "organizationChosen"
  | "organizationCreationError"
  | "organizationCreating"
  | "organizationJoinError"
  | "organizationJoining"
  | "organizationName"
  | "organizationRenameError"
  | "organizationRenaming"
  | "organizationSlug"
  | "privacyHref"
  | "progress"
  | "syncError"
  | "syncLevel"
  | "syncSaving"
  | "termsHref";

/**
 * What the shell hands a phase selector. The dialog's props with every
 * defaulted or locally derived value already resolved, minus the chrome-only
 * three (`open`, `phase`, `restoring`) that no phase reads.
 *
 * Resolving VALUES here is what lets a selector narrow instead of re-defaulting,
 * which is where the old dispatch drifted: the shell defaulted `account` and the
 * switch then defaulted it again. Per-phase CALLBACK fallback chains are
 * deliberately NOT resolved here — which callback stands in for a missing one is
 * that phase's policy, and it lives in that phase's selector.
 */
export type GuidedOnboardingPhaseSource = Omit<
  GuidedOnboardingDialogProps,
  ResolvedDialogProp | "onSyncLevelChange" | "open" | "phase" | "restoring"
> &
  Required<Pick<GuidedOnboardingDialogProps, ResolvedDialogProp>> & {
    /** Resolved by the shell, which owns the uncontrolled-sync-level fallback. */
    onSyncLevelChange: (level: SyncConsentLevel) => void;
  };
