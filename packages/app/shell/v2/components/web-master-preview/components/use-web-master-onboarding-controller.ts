"use client";

import {
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep as SetupGateStepId,
} from "@repo/api/src/types/onboarding-phase";
import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { OnboardingAnalysisProgressStatus } from "@repo/app/onboarding/components/guided-onboarding-data"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type {
  GuidedOnboardingStepNotices,
  WizardPhase,
} from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { isWizardPhase } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { SyncPolicyGateNotice } from "@repo/app/onboarding/components/setup-gate-steps"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  isSetupGateStepOwed,
  resolveSetupGate,
} from "@repo/app/onboarding/lib/first-user-setup-gate"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  FIXTURE_FIRST_MEMBER,
  FIXTURE_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/lib/guided-onboarding-fixtures"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { deriveOnboardingDesktopSkipEligibility } from "@repo/app/onboarding/lib/onboarding-desktop-skip"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { desktopInstallerHrefs } from "../mock";
import type { PendingOnboardingStep } from "./app-sidebar";
import {
  getPostAccountOrganizationPhase,
  lastWizardPhase,
  popPreviousFtuePhase,
} from "./ftue-navigation";
import { type FtuePhase, isAnalysisStatusPhase } from "./ftue-progress-context";
import { SyncPolicy } from "./guided-ftue-modal";
import {
  createInitialGuidedFtueState,
  getGuidedFtueStorageKey,
} from "./guided-ftue-state";
import {
  PrototypeMode,
  type PrototypeMode as PrototypeModeValue,
  PrototypeOrganizationDataProbe,
  type PrototypeOrganizationDataProbe as PrototypeOrganizationDataProbeValue,
} from "./prototype-developer-menu";
import { SETUP_GATE_PROPOSED_COPY } from "./setup-gate-copy";
import { useGuidedFtueState } from "./use-guided-ftue-state";
import type { WebMasterPrototypeContextValue } from "./web-master-prototype-context";

export function useWebMasterOnboardingController({
  mode,
  organizationDataProbe,
  organizationMemberCount,
}: {
  mode: PrototypeModeValue;
  /**
   * Whether the fixture organization's synced-data flag was ever READ. Required,
   * not defaulted: a default would let a caller reach only the two measured arms
   * and never notice the third exists.
   */
  organizationDataProbe: PrototypeOrganizationDataProbeValue;
  organizationMemberCount: number;
}) {
  const { ready, reset, setState, state } = useGuidedFtueState({
    mode,
    organizationMemberCount,
  });
  const isDesktop = mode === PrototypeMode.Desktop;
  const nextPhaseAfterAccount = getPostAccountOrganizationPhase(
    organizationMemberCount
  );
  const organizationHasSessionData = organizationMemberCount > 0;
  /**
   * The picker's pending selection. The policy itself is only recorded on
   * Continue, so clicking a radio cannot mark the setup step done before the
   * reader has confirmed it (ISS-12363).
   */
  const [syncDraft, setSyncDraft] = useState<SyncConsentLevel | null>(null);
  const inviteAdvanceTimerRef = useRef<number | null>(null);

  /**
   * Drop the paced invite advance (davetho review).
   *
   * The timer set by `onInviteTeam` outlives whatever phase was on screen when
   * it was scheduled. Without this, clicking Back during the confirmation
   * interval moved the wizard backwards and the timer then forced it forward
   * again, over a destination the reader had just chosen — and a reset or a
   * fixture change landed in the same stale navigation.
   *
   * The ref is nulled here so a later cancel is a no-op, which is what lets
   * `navigateToPhase` call this unconditionally: the timer's own callback nulls
   * the ref BEFORE it navigates, so its advance is the one navigation this does
   * not cancel.
   */
  const cancelInviteAdvance = useCallback(() => {
    if (inviteAdvanceTimerRef.current !== null) {
      globalThis.window.clearTimeout(inviteAdvanceTimerRef.current);
      inviteAdvanceTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelInviteAdvance, [cancelInviteAdvance]);

  // A fixture change re-seeds the whole walkthrough, so an advance scheduled
  // against the previous one must not land on it. Keyed on the two fixture
  // inputs rather than on `cancelInviteAdvance`, which is stable and would make
  // this a mount-only effect that cancels nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fixture inputs ARE the trigger; the callback is stable.
  useEffect(() => {
    cancelInviteAdvance();
    // An unconfirmed picker selection belongs to the scenario it was made in;
    // carried over, it would pre-select the incoming one's sync step.
    setSyncDraft(null);
  }, [cancelInviteAdvance, mode, organizationMemberCount]);

  const navigateToPhase = useCallback(
    (nextPhase: FtuePhase) => {
      cancelInviteAdvance();
      setState((current) => ({
        ...current,
        phase: nextPhase,
        phaseHistory: [...current.phaseHistory, current.phase],
      }));
    },
    [cancelInviteAdvance, setState]
  );

  const openFtuePhase = useCallback(
    (nextPhase: FtuePhase) => {
      cancelInviteAdvance();
      setState((current) => ({
        ...current,
        phase: nextPhase,
        phaseHistory: [OnboardingPhase.DashboardAvailable],
      }));
    },
    [cancelInviteAdvance, setState]
  );

  useEffect(() => {
    if (
      !isDesktop ||
      state.phase === OnboardingPhase.Welcome ||
      state.progress >= 100
    ) {
      return;
    }
    const timer = globalThis.window.setInterval(() => {
      setState((current) => ({
        ...current,
        progress: Math.min(100, current.progress + 1),
      }));
    }, 1000);
    return () => globalThis.window.clearInterval(timer);
  }, [isDesktop, setState, state.phase, state.progress]);

  /**
   * The phase the wizard last actually put on screen this mount.
   *
   * `state.phaseHistory` is the back-stack, not a record of what has been
   * screened, and Back CONSUMES its entries. A step resumed from the dashboard
   * checklist seeds the history with `dashboard_available` alone, so a single
   * Back empties it while the modal is still fading — leaving the history-based
   * fallback below nothing to hold and the exit fade blank again (ISS-8345).
   *
   * Only recorded once `ready`: until then the dialog renders the restoring
   * step rather than a phase, so recording the pre-restore `welcome` here would
   * fade out a screen the reader never saw and shadow the restored history.
   *
   * Stamped with the snapshot it was screened under. Switching mode or user
   * scenario swaps the storage key WITHOUT remounting, so an unstamped ref would
   * survive into the incoming snapshot and let the abandoned scenario's last
   * screen outrank that snapshot's own history. Validating the stamp on read
   * makes a stale record unreadable rather than merely old, which is what keeps
   * this correct without depending on effect ordering.
   */
  const lastScreenedWizardPhaseRef = useRef<ScreenedWizardPhase | undefined>(
    undefined
  );
  const storageKey = getGuidedFtueStorageKey(mode, organizationMemberCount);

  useEffect(() => {
    if (ready && isWizardPhase(state.phase)) {
      lastScreenedWizardPhaseRef.current = { phase: state.phase, storageKey };
    }
  }, [ready, state.phase, storageKey]);

  const pendingOnboardingStep = getPendingOnboardingStep({
    accountMethod: state.accountMethod,
    accountSkipped: state.accountSkipped,
    desktopAppDownloaded: state.desktopAppDownloaded,
    githubConnected: state.githubConnected,
    isDesktop,
    phase: state.phase,
    syncLevel: state.syncLevel,
    teamInvited: state.teamInvited,
  });

  // ISS-12363: the Web gate. Desktop needs none — it already asks for the
  // policy inside its own wizard and the reader already has the app. The gate
  // reads the same probed membership as the wizard, so the developer menu's
  // Unmeasured scenario reaches the gate's unknown-membership arm.
  const organizationMembership = fixtureOrganizationMembership({
    hasOtherMembers: organizationHasSessionData,
    probe: organizationDataProbe,
  });
  const setupGate = resolveSetupGate({
    desktopAppDownloaded: state.desktopAppDownloaded,
    membership: organizationMembership,
    syncPolicy: state.syncLevel,
  });
  const showGateNotices = !isDesktop && setupGate.blocking;
  // Where the Web run goes once the download step is left (downloaded, skipped,
  // or continued without an installer). The gate is the only authority on
  // whether the policy choice is still owed, so the modal holds a first user
  // on it and lets everyone else through.
  const nextPhaseAfterDownload = (): FtuePhase =>
    !isDesktop &&
    isSetupGateStepOwed(setupGate, SetupGateStepId.ChooseSessionSync)
      ? OnboardingPhase.SyncPolicy
      : getPostDownloadPhase(state.accountMethod, state.githubConnected);
  // Where the Web run goes once the policy is recorded: back to the dashboard
  // when the step was resumed from the Getting started card, onward otherwise.
  const nextPhaseAfterSyncChoice = (): FtuePhase =>
    state.phaseHistory.at(-1) === OnboardingPhase.DashboardAvailable
      ? OnboardingPhase.DashboardAvailable
      : getPostDownloadPhase(state.accountMethod, state.githubConnected);
  const commitSyncChoice = (level: SyncConsentLevel) => {
    setSyncDraft(null);
    setState((current) => ({ ...current, syncLevel: level }));
  };

  // The wizard renders no screen for `dashboard_available` — that is the phase
  // the modal closes on, and `open` below is already false there. Handing the
  // dialog a phase it does not render would ask its registry for a component
  // that should not exist, so the resting phase resolves to no phase of its own.
  // It resolves to the last one the wizard DID screen rather than to nothing,
  // because the dialog stays mounted through its exit animation: the screen the
  // user just completed is what should be fading out.
  const lastScreenedWizardPhase =
    lastScreenedWizardPhaseRef.current?.storageKey === storageKey
      ? lastScreenedWizardPhaseRef.current.phase
      : undefined;
  const wizardPhase = isWizardPhase(state.phase)
    ? state.phase
    : (lastScreenedWizardPhase ?? lastWizardPhase(state.phaseHistory));

  const modalProps = {
    accountCreated: state.accountCreated,
    accountMethod: state.accountMethod,
    allowSkipAccount: isDesktop,
    desktopSkipEligibility: deriveOnboardingDesktopSkipEligibility(
      organizationMembership
    ),
    desktopAppDownloaded: state.desktopAppDownloaded,
    desktopMode: isDesktop,
    downloadHrefs: desktopInstallerHrefs,
    invitedEmails: state.invitedEmails,
    // The wizard takes a membership LOOKUP, never a bare count (ISS-8678), so
    // the developer menu's scenario has to be resolved to a fixture here to
    // reach the step at all.
    members:
      organizationMemberCount > 0
        ? FIXTURE_ORGANIZATION_MEMBERS
        : FIXTURE_FIRST_MEMBER,
    onBack: () => {
      const destination = popPreviousFtuePhase(state.phaseHistory);
      if (!destination) {
        return;
      }
      // Before the write, not after: this is the navigation the paced invite
      // advance would otherwise overrule a beat later.
      cancelInviteAdvance();
      setState((current) => ({
        ...current,
        phase: destination.phase,
        phaseHistory: destination.history,
        resumingInvite:
          destination.phase === OnboardingPhase.DashboardAvailable
            ? false
            : current.resumingInvite,
      }));
    },
    onComplete: () => {
      setState((current) => ({
        ...current,
        accountCreated: true,
        accountSkipped: false,
      }));
      navigateToPhase(nextPhaseAfterAccount);
    },
    onConnectGitHub: () => {
      setState((current) => ({ ...current, githubConnected: true }));
      navigateToPhase(OnboardingPhase.DashboardAvailable);
    },
    onContinue: () =>
      navigateToPhase(
        state.accountCreated ? nextPhaseAfterAccount : OnboardingPhase.Account
      ),
    onContinueFromDownload: () => navigateToPhase(nextPhaseAfterDownload()),
    onContinueFromInvites: () =>
      navigateToPhase(
        getPostInvitePhase(
          state.accountMethod,
          state.githubConnected,
          isDesktop,
          state.resumingInvite
        )
      ),
    onContinueFromOrganization: () => {
      setState((current) => ({ ...current, organizationChosen: true }));
      navigateToPhase(
        isDesktop ? OnboardingPhase.SyncPolicy : OnboardingPhase.InviteTeam
      );
    },
    onContinueFromSync: (level: SyncConsentLevel) => {
      commitSyncChoice(level);
      if (isDesktop) {
        navigateToPhase(OnboardingPhase.InviteTeam);
        return;
      }
      navigateToPhase(nextPhaseAfterSyncChoice());
    },
    onContinueWithEmail: () =>
      completeAccount(
        "email",
        false,
        setState,
        navigateToPhase,
        nextPhaseAfterAccount
      ),
    onContinueWithGitHub: () =>
      completeAccount(
        "github",
        true,
        setState,
        navigateToPhase,
        nextPhaseAfterAccount
      ),
    onContinueWithGoogle: () =>
      completeAccount(
        "google",
        false,
        setState,
        navigateToPhase,
        nextPhaseAfterAccount
      ),
    onCreateOrganization: (organization: typeof state.organizationDetails) => {
      setState((current) => ({
        ...current,
        organizationChosen: true,
        organizationDetails: organization,
      }));
      navigateToPhase(
        isDesktop ? OnboardingPhase.SyncPolicy : OnboardingPhase.InviteTeam
      );
    },
    onDownloadApp: () => {
      setState((current) => ({
        ...current,
        desktopAppDownloaded: true,
      }));
      navigateToPhase(nextPhaseAfterDownload());
    },
    onInviteTeam: (emails: readonly string[]) => {
      setState((current) => ({
        ...current,
        invitedEmails: [...new Set([...current.invitedEmails, ...emails])],
        resumingInvite: false,
        teamInvited: true,
      }));
      // The step emits the invite synchronously; only the phase advance is
      // paced, so the confirmation stays on screen for a beat. The record of
      // the invite is already committed above and survives an early unmount.
      inviteAdvanceTimerRef.current = globalThis.window.setTimeout(() => {
        inviteAdvanceTimerRef.current = null;
        navigateToPhase(
          getPostInvitePhase(
            state.accountMethod,
            state.githubConnected,
            isDesktop,
            state.resumingInvite
          )
        );
      }, INVITE_CONFIRMATION_DURATION_MS);
    },
    onSkipAccount: () => {
      setState((current) => ({
        ...current,
        accountCreated: false,
        accountSkipped: true,
        githubConnected: false,
      }));
      navigateToPhase(OnboardingPhase.DashboardAvailable);
    },
    onSkipDownload: () => {
      setState((current) => ({
        ...current,
        desktopAppDownloaded: false,
      }));
      navigateToPhase(nextPhaseAfterDownload());
    },
    onSkipInvites: () => {
      setState((current) => ({
        ...current,
        resumingInvite: false,
        teamInvited: false,
      }));
      navigateToPhase(
        getPostInvitePhase(
          state.accountMethod,
          state.githubConnected,
          isDesktop,
          state.resumingInvite
        )
      );
    },
    onStartCreateOrganization: () =>
      navigateToPhase(OnboardingPhase.CreateOrganization),
    onStart: () =>
      navigateToPhase(
        getPostWelcomePhase(
          state.accountCreated,
          isDesktop,
          nextPhaseAfterAccount
        )
      ),
    onSyncPolicyChange: setSyncDraft,
    open: !ready || state.phase !== OnboardingPhase.DashboardAvailable,
    organizationChosen: state.organizationChosen,
    organizationName: state.organizationDetails.name,
    organizationSlug: state.organizationDetails.slug,
    phase: wizardPhase,
    // The prototype SIMULATES a real percentage, so it states one. A host with
    // no measurement passes the unknown variant instead (ISS-8346).
    progress: {
      percent: state.progress,
      status: OnboardingAnalysisProgressStatus.Measured,
    },
    restoring: !ready,
    // Only the sync step carries the gate's notice: on the download step the
    // heading already names the step, and anything above the installer pushes
    // it out of view.
    stepNotices: (showGateNotices
      ? {
          [OnboardingPhase.SyncPolicy]: createElement(SyncPolicyGateNotice, {
            copy: SETUP_GATE_PROPOSED_COPY,
            gate: setupGate,
          }),
        }
      : undefined) satisfies GuidedOnboardingStepNotices | undefined,
    // Desktop keeps pre-selecting the recommended level as it always has; the
    // Web gate starts unset so the reader makes the choice themselves.
    syncPolicy:
      syncDraft ?? state.syncLevel ?? (isDesktop ? SyncPolicy.Full : null),
    teamInvited: state.teamInvited,
  };

  const prototypeContextValue = {
    accountMethod: state.accountMethod,
    accountSkipped: state.accountSkipped,
    connectGitHub: () =>
      setState((current) => ({ ...current, githubConnected: true })),
    desktopAppDownloaded: state.desktopAppDownloaded,
    disconnectGitHub: () =>
      setState((current) => ({ ...current, githubConnected: false })),
    downloadDesktopApp: () =>
      setState((current) => ({
        ...current,
        desktopAppDownloaded: true,
      })),
    githubConnected: state.githubConnected,
    organizationHasSessionData,
    invitedEmails: state.invitedEmails,
    inviteTeam: (emails) =>
      setState((current) => ({
        ...current,
        invitedEmails: [...new Set([...current.invitedEmails, ...emails])],
        teamInvited: true,
      })),
    mode,
    openAccountSetup: () => {
      cancelInviteAdvance();
      const initial = createInitialGuidedFtueState();
      setState((current) => ({
        ...current,
        accountCreated: false,
        accountMethod: null,
        accountSkipped: false,
        organizationChosen: false,
        organizationDetails: initial.organizationDetails,
        phase: OnboardingPhase.Account,
        phaseHistory: [OnboardingPhase.DashboardAvailable],
      }));
    },
    openGitHubSetup: () => openFtuePhase(OnboardingPhase.ConnectGitHub),
    organizationDetails: state.organizationDetails,
    setOrganizationDetails: (organization) =>
      setState((current) => ({
        ...current,
        organizationDetails: organization,
      })),
    setSyncPolicy: (policy) =>
      setState((current) => ({ ...current, syncLevel: policy })),
    // Stands in for the reader choosing a policy in Desktop while the web gate
    // is open: the same record lands, and the web run moves on without them
    // touching the picker here (ISS-12363).
    simulateDesktopSyncChoice: () => {
      commitSyncChoice(SyncPolicy.Insights);
      if (!isDesktop && state.phase === OnboardingPhase.SyncPolicy) {
        navigateToPhase(nextPhaseAfterSyncChoice());
      }
    },
    syncPolicy: state.syncLevel,
    teamInvited: state.teamInvited,
  } satisfies WebMasterPrototypeContextValue;

  return {
    completionProgress: getCompletionProgress({
      accountCreated: state.accountCreated,
      desktopAppDownloaded: state.desktopAppDownloaded,
      githubConnected: state.githubConnected,
      isDesktop,
      syncChosen: state.syncLevel !== null,
      teamInvited: state.teamInvited,
    }),
    setupGate,
    isDesktop,
    markDashboardTourCompleted: () =>
      setState((current) => ({
        ...current,
        dashboardTourCompleted: true,
      })),
    modalProps,
    pendingOnboardingStep,
    /** False until the persisted snapshot has been read back from storage. */
    ready,
    prototypeContextValue,
    reset: () => {
      // A reset that leaves the advance armed re-enters the walkthrough and is
      // then dragged off its first phase a beat later.
      cancelInviteAdvance();
      setSyncDraft(null);
      reset();
    },
    resumePendingStep: (nextStep: PendingOnboardingStep) =>
      resumePendingStep(nextStep, setState, openFtuePhase),
    showAnalysisStatus:
      isDesktop && isAnalysisStatusPhase(state.phase) && state.progress < 100,
    state,
  };
}

function getPostWelcomePhase(
  accountCreated: boolean,
  isDesktop: boolean,
  nextPhaseAfterAccount: FtuePhase
): FtuePhase {
  if (isDesktop) {
    return OnboardingPhase.SessionDiscovery;
  }
  return accountCreated ? nextPhaseAfterAccount : OnboardingPhase.Account;
}

function getPostInvitePhase(
  accountMethod: AuthMethod | null,
  githubConnected: boolean,
  isDesktop: boolean,
  resumingInvite: boolean
): FtuePhase {
  if (resumingInvite) {
    return OnboardingPhase.DashboardAvailable;
  }
  if (!isDesktop) {
    return OnboardingPhase.DownloadDesktop;
  }
  return getPostDownloadPhase(accountMethod, githubConnected);
}

function getPostDownloadPhase(
  accountMethod: AuthMethod | null,
  githubConnected: boolean
): FtuePhase {
  return accountMethod !== "github" && !githubConnected
    ? OnboardingPhase.ConnectGitHub
    : OnboardingPhase.DashboardAvailable;
}

function getPendingOnboardingStep({
  accountMethod,
  accountSkipped,
  desktopAppDownloaded,
  githubConnected,
  isDesktop,
  phase,
  syncLevel,
  teamInvited,
}: {
  accountMethod: AuthMethod | null;
  accountSkipped: boolean;
  desktopAppDownloaded: boolean;
  githubConnected: boolean;
  isDesktop: boolean;
  phase: FtuePhase;
  syncLevel: SyncConsentLevel | null;
  teamInvited: boolean;
}): PendingOnboardingStep | null {
  if (phase !== OnboardingPhase.DashboardAvailable) {
    return null;
  }
  if (isDesktop && accountSkipped) {
    return "create-account";
  }
  if (!(isDesktop || desktopAppDownloaded)) {
    return "download-app";
  }
  // Directly after the download, as ISS-12363 orders it: the two are the Web
  // setup gate, and Off counts as chosen.
  if (!isDesktop && syncLevel === null) {
    return "choose-sync";
  }
  if (accountMethod !== "github" && !githubConnected) {
    return "connect-github";
  }
  if (!teamInvited) {
    return "invite-team";
  }
  return null;
}

function getCompletionProgress({
  accountCreated,
  desktopAppDownloaded,
  githubConnected,
  isDesktop,
  syncChosen,
  teamInvited,
}: {
  accountCreated: boolean;
  desktopAppDownloaded: boolean;
  githubConnected: boolean;
  isDesktop: boolean;
  syncChosen: boolean;
  teamInvited: boolean;
}): string {
  const completed =
    Number(accountCreated) +
    Number(githubConnected) +
    Number(teamInvited) +
    (isDesktop ? 0 : Number(desktopAppDownloaded) + Number(syncChosen));
  return `${completed}/${isDesktop ? 3 : 5}`;
}

function resumePendingStep(
  nextStep: PendingOnboardingStep,
  setState: ReturnType<typeof useGuidedFtueState>["setState"],
  openFtuePhase: (phase: FtuePhase) => void
) {
  if (nextStep === "create-account") {
    const initial = createInitialGuidedFtueState();
    setState((current) => ({
      ...current,
      accountCreated: false,
      accountMethod: null,
      accountSkipped: false,
      organizationChosen: false,
      organizationDetails: initial.organizationDetails,
    }));
    openFtuePhase(OnboardingPhase.Account);
    return;
  }
  if (nextStep === "download-app") {
    openFtuePhase(OnboardingPhase.DownloadDesktop);
    return;
  }
  if (nextStep === "choose-sync") {
    openFtuePhase(OnboardingPhase.SyncPolicy);
    return;
  }
  if (nextStep === "invite-team") {
    setState((current) => ({ ...current, resumingInvite: true }));
    openFtuePhase(OnboardingPhase.InviteTeam);
    return;
  }
  openFtuePhase(OnboardingPhase.ConnectGitHub);
}

function completeAccount(
  method: AuthMethod,
  githubConnected: boolean,
  setState: ReturnType<typeof useGuidedFtueState>["setState"],
  navigateToPhase: (phase: FtuePhase) => void,
  nextPhaseAfterAccount: FtuePhase
) {
  setState((current) => ({
    ...current,
    accountCreated: true,
    accountMethod: method,
    accountSkipped: false,
    githubConnected,
  }));
  navigateToPhase(nextPhaseAfterAccount);
}

const INVITE_CONFIRMATION_DURATION_MS = 1200;

/**
 * The fixture stand-in for the snapshot's `membership`.
 *
 * The probe is resolved FIRST and short-circuits, because "nobody read it" is
 * not a value the member count can express — a count always answers yes or no,
 * which is exactly how the unmeasured arm became unreachable from the developer
 * menu before this existed.
 */
function fixtureOrganizationMembership({
  hasOtherMembers,
  probe,
}: {
  hasOtherMembers: boolean;
  probe: PrototypeOrganizationDataProbeValue;
}): OrganizationMembership | undefined {
  if (probe === PrototypeOrganizationDataProbe.Unmeasured) {
    return;
  }
  return hasOtherMembers
    ? OrganizationMembership.ExistingMember
    : OrganizationMembership.FirstUser;
}

/** A screened wizard phase, and the persisted snapshot it was screened under. */
type ScreenedWizardPhase = {
  phase: WizardPhase;
  storageKey: string;
};
