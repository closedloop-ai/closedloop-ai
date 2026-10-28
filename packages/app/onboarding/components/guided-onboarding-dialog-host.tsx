"use client";

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import {
  type OnboardingAccountModes,
  syncPolicyChoiceForDataSyncLevel,
} from "@repo/api/src/types/onboarding-analytics";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  KnownFlag,
  type OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import {
  SettingsLocalDeviceStatus,
  type SettingsLocalSyncPolicyProjection,
} from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { useLocalSyncPolicy } from "../../shared/settings-host/use-local-sync-policy";
import { useDesktopAppRunning } from "../hooks/use-desktop-presence";
import {
  useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition,
} from "../hooks/use-guided-onboarding";
import { useOnboardingFunnelAnalytics } from "../hooks/use-onboarding-analytics";
import { useOnboardingInviteStepOutcome } from "../hooks/use-onboarding-invite-step-outcome";
import { useOnboardingInviteTeam } from "../hooks/use-onboarding-invite-team";
import { useOnboardingModalOpen } from "../hooks/use-onboarding-modal-open";
import { useOnboardingOrganizationJoin } from "../hooks/use-onboarding-organization-join";
import { useOnboardingOrganizationMembers } from "../hooks/use-onboarding-organization-members";
import { DEFAULT_DESKTOP_DOWNLOAD_HREFS } from "../lib/desktop-platform-availability";
import {
  createAccountEstablishedEventForProvider,
  createOrganizationReadyEvent,
} from "../lib/guided-onboarding-events";
import type { GuidedOnboardingRun } from "../lib/guided-onboarding-run";
import {
  OnboardingRunStanding,
  resolveAnalysisBannerInputs,
} from "../lib/onboarding-analysis-banner-inputs";
import { deriveOnboardingDesktopSkipEligibility } from "../lib/onboarding-desktop-skip";
import { endOnboardingFlowSession } from "../lib/onboarding-flow-session";
import type { OnboardingTransitionAnalyticsOutcome } from "../lib/onboarding-funnel-analytics";
import { deriveGuidedOnboardingGitHubConnection } from "../lib/onboarding-github-connection";
import { inviteEvidenceIdentity } from "../lib/onboarding-invite-identity";
import {
  countInvitesSent,
  discoveryAnalyticsOutcome,
} from "../lib/onboarding-step-analytics-outcomes";
import {
  chooseActiveOrganization,
  hasLeftWelcomeThroughStart,
  organizationActiveFlag,
} from "../lib/onboarding-transitions";
import type { AuthMethod } from "./auth-methods";
import {
  type AccountSelectHandler,
  buildAccountMethodHandlers,
  readerHasAccount,
} from "./guided-onboarding-account-wiring";
import {
  type OnboardingAccount,
  type OnboardingJoinableOrganization,
  type OnboardingOrganizationJoin,
  UNKNOWN_ACCOUNT,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_JOINABLE_ORGANIZATION,
  UNKNOWN_SESSION_DISCOVERY,
} from "./guided-onboarding-data";
import { GuidedOnboardingDialog } from "./guided-onboarding-dialog";
import type {
  GuidedOnboardingDialogProps,
  OrganizationCreationHandler,
  OrganizationDetails,
  OrganizationRenameHandler,
} from "./guided-onboarding-types";
import { isWizardPhase } from "./guided-onboarding-types";
import { OnboardingAnalysisBanner } from "./onboarding-analysis-banner";
import type { SyncConsentLevel } from "./sync-consent";

export type GuidedOnboardingDialogHostProps = {
  account?: OnboardingAccount;
  /**
   * PRD-736 `account_mode` (ISS-10913): the auth facts this host observed for
   * the return that established the account, already folded to a non-empty
   * set. Only a host that drives an EXTERNAL auth flow has one — the desktop
   * shell, from its main-process auth state — so it is absent on web and the
   * property is then omitted rather than reported as an invented `unknown`.
   */
  accountMode?: OnboardingAccountModes;
  /** The Account step's in-flight method; see the dialog prop. */
  accountPendingMethod?: AuthMethod | null;
  /** Why the Account step's last sign-in failed; see the dialog prop. */
  accountSignInError?: string | null;
  /**
   * Whether the host's local analysis reached one of its own terminals.
   *
   * Defaults to settled, which is the closed answer: the ambient analysis bar
   * asserts that analysis is RUNNING, so a host that has not said otherwise
   * must not have that claim made on its behalf.
   */
  analysisSettled?: boolean;
  analysisStarted: boolean;
  allowStagedOrganizationLogo?: boolean;
  brand: ReactNode;
  dashboardActive: boolean;
  desktopMode: boolean;
  discovery?: GuidedOnboardingDialogProps["discovery"];
  downloadHrefs?: GuidedOnboardingDialogProps["downloadHrefs"];
  githubConnectError?: string | null;
  githubConnecting?: boolean;
  githubStatus?: GitHubIntegrationStatus | null;
  host: OnboardingHost;
  joinableOrganization?: OnboardingJoinableOrganization;
  /** Host-owned organization persistence; success gates OrganizationReady. */
  onCreateOrganization?: OrganizationCreationHandler;
  /**
   * Host-owned rename of the already-active organization; success gates
   * OrganizationReady from the CHOOSE step (ISS-11253). Supplying it is what
   * gives a first user the naming capability the unreachable create step
   * carried. Never a create — see {@link OrganizationRenameHandler}.
   */
  onRenameOrganization?: OrganizationRenameHandler;
  /**
   * Host-owned JOIN of an organization the account has not activated; success
   * gates OrganizationReady exactly as creation does.
   *
   * The surface below offers a Join affordance only where this is supplied AND
   * the joinable organization carries a target, so the button can never report a
   * join no host performed. A rejected promise keeps the run on this phase and
   * states the failure; it never advances and never falls back to the empty or
   * pending arm.
   */
  onJoinOrganization?: (
    join: OnboardingOrganizationJoin
  ) => Promise<void> | void;
  /**
   * Host-owned re-read of the membership/invitation lookup, for the step's
   * `unavailable` arm (ISS-11158). Passed straight through: the host both holds
   * the read and reports the `joinableOrganization` it resolves to, so nothing
   * here can know when the retry finished and nothing here pretends to.
   */
  onRetryJoinableOrganizationLookup?: () => void;
  onAccountSelect?: AccountSelectHandler;
  onBackFallback: () => void;
  onConnectGitHub?: () => void;
  /**
   * Where the ambient analysis bar reports its rendered height, and the switch
   * that mounts it at all.
   *
   * The bar is `position: fixed`, so it is out of flow and this offset is the
   * ONLY thing keeping the shell's content clear of it. A host that cannot
   * reserve that space therefore must not mount the bar, which is why one prop
   * carries both facts rather than a separate `showAnalysisBanner` that could
   * be set without an offset to go with it.
   *
   * MUST be referentially stable — see the contract on the banner's layout
   * effect; an identity that changes every render re-arms it every render.
   */
  onAnalysisBannerHeightChange?: (height: number) => void;
  /**
   * ISS-10890: Welcome's Start is the reader's agreement to local session
   * analysis (operator decision, 2026-09-24). Called whenever the live run has
   * left Welcome through an accepted Start, for a host that holds local reading
   * until the agreement exists — the desktop shell. Must be idempotent. Absent
   * on web.
   */
  onAnalysisAgreed?: () => void;
  /**
   * A host-measured pass that takes over the ambient bar while it runs.
   *
   * ISS-10492: the desktop shell's startup pass drives this same bar, and its
   * data is a STAGE model, not the onboarding analyzed/found ratio. When the
   * host reports one as `active` it wins, because a startup stage is what the
   * reader is actually waiting on; otherwise the bar states the onboarding
   * analysis as before. Absent on every host that has no such pass.
   */
  analysisBannerOverride?: Omit<
    ComponentProps<typeof OnboardingAnalysisBanner>,
    "onHeightChange"
  >;
  onDashboardAvailable: () => void;
  onDownloadDesktop?: () => void;
  /**
   * ISS-10570: reports whether this host's blocking modal is up.
   *
   * The dashboard mounts BEHIND this modal on both shells (it is a shell
   * sibling), and on desktop the first-launch tour's arm is deliberately
   * phase-blind — `dashboardTourStandingHere` reads `Owed` through the whole
   * blocking flow — so nothing there could tell that the run it was about to
   * spend was covered. Published from the one `open` the dialog itself is given,
   * so a consumer cannot grow a second answer to "is the takeover up?".
   *
   * MUST be referentially stable, for the same reason
   * {@link GuidedOnboardingDialogHostProps.onAnalysisBannerHeightChange} must:
   * it is an effect dependency.
   */
  onOpenChange?: (open: boolean) => void;
  /** Surface-owned sign-in for an EXISTING account; see the dialog prop. */
  onSignIn?: () => void;
  /**
   * Surface-owned sign-out. May return the sign-out promise: the host clears
   * the onboarding flow session only after it RESOLVES, so the next account on
   * this tab cannot inherit the prior attempt's flow_id (PRD-736 identity
   * invariant 2: the attempt rotates at sign-out).
   */
  onSignOut?: () => void | Promise<void>;
  organizationChosen?: boolean;
  organizationCreateFailedMessage?: string;
  organizationName?: string;
  organizationRenameFailedMessage?: string;
  organizationSlug?: string;
  progress?: GuidedOnboardingDialogProps["progress"];
  /**
   * Where this run comes from. Omitted, the run is the server's — the path
   * every signed-in reader on both shells takes, unchanged.
   *
   * Supplied, it REPLACES the server read and the server poster for this mount.
   * The one supplier today is a signed-out desktop guest, whose run the server
   * cannot answer for at all: `useGuidedOnboardingSnapshot` never fires without
   * a `userId`, so the host has no snapshot and `open` stays false regardless of
   * phase. See {@link GuidedOnboardingRun}.
   */
  run?: GuidedOnboardingRun;
  syncConsentRecorded?: KnownFlag;
  syncSaveFailedMessage?: string;
};

/**
 * Production host for the server-owned guided onboarding run.
 *
 * Surface wrappers adapt Web/Desktop facts into this component; state-machine
 * transitions and Settings-host sync writes stay shared so both mounts advance
 * only after their owning producer has succeeded.
 */
export function GuidedOnboardingDialogHost({
  account = UNKNOWN_ACCOUNT,
  accountMode,
  accountPendingMethod = null,
  accountSignInError = null,
  analysisSettled = true,
  analysisStarted,
  allowStagedOrganizationLogo = false,
  brand,
  dashboardActive,
  desktopMode,
  discovery = UNKNOWN_SESSION_DISCOVERY,
  downloadHrefs = DEFAULT_DESKTOP_DOWNLOAD_HREFS,
  githubConnectError = null,
  githubConnecting = false,
  githubStatus,
  host,
  joinableOrganization = UNKNOWN_JOINABLE_ORGANIZATION,
  onAccountSelect,
  onAnalysisAgreed,
  onAnalysisBannerHeightChange,
  analysisBannerOverride,
  onBackFallback,
  onConnectGitHub,
  onDashboardAvailable,
  onDownloadDesktop,
  onOpenChange,
  onSignIn,
  onSignOut,
  organizationChosen = false,
  organizationCreateFailedMessage = DEFAULT_ORGANIZATION_CREATE_FAILED_MESSAGE,
  organizationName = "",
  organizationRenameFailedMessage = DEFAULT_ORGANIZATION_RENAME_FAILED_MESSAGE,
  organizationSlug = "",
  progress = UNKNOWN_ANALYSIS_PROGRESS,
  run,
  syncConsentRecorded = KnownFlag.Unknown,
  syncSaveFailedMessage = DEFAULT_SYNC_SAVE_FAILED_MESSAGE,
  onCreateOrganization,
  onRenameOrganization,
  onJoinOrganization,
  onRetryJoinableOrganizationLookup,
}: GuidedOnboardingDialogHostProps) {
  // Narrowed, never widened: the hook's own gate already refuses to fire
  // without a `userId`, and this states the intent rather than leaning on that
  // coincidence — a supplied run owns this mount, so the server read is not
  // merely unanswerable, it is not wanted.
  const snapshotQuery = useGuidedOnboardingSnapshot(host, {
    enabled: run === undefined,
  });
  const transition = useGuidedOnboardingTransition({
    analysisStarted,
    experienceVariant: WorkspaceExperience.V2,
    host,
    syncConsentRecorded,
  });
  const snapshot = run ? run.snapshot : (snapshotQuery.data ?? null);
  const authSnapshot = useOptionalAuthSnapshot();
  const organizationActive = runOrganizationActive(run, authSnapshot);
  const runReadPending = resolveRunReadPending({
    authLoaded: authSnapshot.isLoaded,
    run,
    serverReadLoading: snapshotQuery.isLoading,
  });
  const currentState = useMemo(
    () =>
      snapshot
        ? chooseActiveOrganization(
            restoreOnboardingState(snapshot.state, host).state,
            organizationActive
          )
        : null,
    [host, organizationActive, snapshot]
  );
  const [recoveredRevision, setRecoveredRevision] = useState<number | null>(
    null
  );
  const open = useOnboardingModalOpen(
    snapshot,
    currentState,
    recoveredRevision,
    onOpenChange
  );

  const serverPostTransition = useTransitionPoster(
    host,
    onDashboardAvailable,
    transition.mutate
  );
  const postTransition = run ? run.postTransition : serverPostTransition;
  const postCurrentTransition = useCallback(
    (event: OnboardingEventInput, callbacks?: TransitionCallbacks) => {
      if (!snapshot) {
        return;
      }
      // Arity preserved: a supplied run's poster is an external contract, and
      // handing it a third `undefined` is not the same call as handing it two.
      if (callbacks === undefined) {
        postTransition(snapshot, event);
      } else {
        postTransition(snapshot, event, callbacks);
      }
      setRecoveredRevision(null);
    },
    [postTransition, snapshot]
  );
  const { captureFlowView } = useOnboardingFunnelAnalytics(host);

  // Cleared only after the surface's sign-out RESOLVES: a failed sign-out
  // leaves the account and its live flow in place, while a successful one must
  // not let the next account signing in on this tab inherit the prior
  // attempt's flow_id, skip history, or resolved first_org_user (PRD-736
  // identity invariant 2: the attempt rotates at sign-out).
  const handleSignOut = useCallback(() => {
    Promise.resolve(onSignOut?.()).then(
      () => {
        endOnboardingFlowSession();
      },
      () => undefined
    );
  }, [onSignOut]);

  // PRD-736 (ISS-10500): a fresh run's first Welcome render is the one funnel
  // moment no transition produces, so the host reports it. The hook itself
  // refuses everything but that case.
  useEffect(() => {
    if (open && currentState) {
      captureFlowView(currentState);
    }
  }, [captureFlowView, currentState, open]);

  // Recorded once Start has been ACCEPTED, not on the press: a Start the run
  // never took leaves the reader on Welcome, which promises nothing has been
  // read. Keyed on the run's own position, so a failed record is retried on the
  // next mount, and a run restored past Welcome releases the gate too.
  const analysisAgreed =
    currentState !== null && hasLeftWelcomeThroughStart(currentState);
  useEffect(() => {
    if (analysisAgreed) {
      onAnalysisAgreed?.();
    }
  }, [analysisAgreed, onAnalysisAgreed]);

  const currentPhase = currentState?.phase;
  // WEB ONLY, on both shells that mount this host: `DownloadDesktop` is reached
  // only from `OnboardingHost.Web` (`resolvePostInvitePhase`), so the Electron
  // renderer never paints the step this unlocks. Read the hook for why a `true`
  // may only ever ADD an option.
  const desktopAppRunning = useDesktopAppRunning(
    open && currentPhase === OnboardingPhase.DownloadDesktop && !desktopMode
  );
  // ISS-11279: WHY there is no phase, which the phase alone cannot say. An
  // unread run and an exited wizard both leave `currentPhase` undefined and want
  // opposite answers from the analysis bar, and on a first launch it is always
  // the former — so the bar drew itself in over a dashboard whose takeover had
  // not painted yet.
  //
  // `isPending` cannot answer this and `isLoading` alone cannot either, because
  // the server read is disabled for two opposite reasons. A query the identity
  // has not resolved for yet WILL fire, so its run is unread; a query gated off
  // because this reader has no account NEVER will, so their run is absent and
  // the bar is theirs to see. `isPending` is true for both and would have shut
  // the bar forever for a returning signed-out guest — the reader ISS-10492
  // built it for. A read that FAILED is `Absent` too, and deliberately still
  // shows it — see `onboarding-analysis-banner-inputs.ts`.
  const runStanding = resolveRunStanding({
    phase: currentPhase,
    readPending: runReadPending,
  });
  // Reported on the edge rather than every render, and unmount reports `false`:
  // a consumer holding "the takeover is up" has no other way to learn that this
  // host went away, and a stuck `true` is the one direction that is unsafe — it
  // would hold a first-launch tour unspendable forever.
  //
  // LAYOUT-timed, not passive (ISS-10570 review). The consumer that needs this
  // is a shell SIBLING whose own arming runs in a passive effect, and passive
  // effects flush in tree order — so a passive publish here would be correct
  // only because this host happens to be rendered before the shell in
  // `Sidebar.tsx`, and moving it would silently hand that sibling a stale
  // `false` on the commit the takeover opens in. Every layout effect in a commit
  // runs before any passive effect in it, so this ordering is a property of the
  // phase rather than of the tree.
  useLayoutEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);
  const invite = useOnboardingInviteTeam(inviteEvidenceIdentity(authSnapshot));
  const inviteStep = useOnboardingInviteStepOutcome({
    active: open && currentPhase === OnboardingPhase.InviteTeam,
    onAdvance: (onSettled) =>
      postCurrentTransition(
        { type: OnboardingEvent.SendInvitations },
        {
          analytics: { invitesSentCount: countInvitesSent(invite.outcome) },
          onSettled,
        }
      ),
    outcome: invite.outcome,
  });
  const members = useOnboardingOrganizationMembers({
    enabled: open && currentPhase === OnboardingPhase.InviteTeam,
  });
  const syncPolicy = useLocalSyncPolicy();
  const syncProjection = getReadySyncPolicyProjection(syncPolicy.state);
  const syncReadError = getSyncReadError(
    syncPolicy.supported,
    syncPolicy.state
  );
  const [selectedSyncLevel, setSelectedSyncLevel] =
    useState<SyncConsentLevel | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [organizationCreationError, setOrganizationCreationError] = useState<
    string | null
  >(null);
  const [organizationCreating, setOrganizationCreating] = useState(false);
  const [organizationRenameError, setOrganizationRenameError] = useState<
    string | null
  >(null);
  const [organizationRenaming, setOrganizationRenaming] = useState(false);
  const organizationJoin = useOnboardingOrganizationJoin({
    canPost: snapshot !== null,
    onJoinOrganization,
    onJoined: () => postCurrentTransition(createOrganizationReadyEvent()),
  });
  const [pendingSync, setPendingSync] = useState<PendingSyncTransition | null>(
    null
  );
  const syncPolicyLevel = toSyncConsentLevel(syncProjection);
  const syncLevel = syncProjection
    ? (selectedSyncLevel ?? syncPolicyLevel)
    : null;

  useEffect(() => {
    setSelectedSyncLevel(
      syncPolicy.state.status === "pending" ? null : syncPolicyLevel
    );
  }, [syncPolicyLevel, syncPolicy.state.status]);

  useEffect(() => {
    if (!pendingSync) {
      return;
    }
    if (syncPolicy.isWriting) {
      if (!pendingSync.writeObserved) {
        setPendingSync({ ...pendingSync, writeObserved: true });
      }
      return;
    }
    if (pendingSync.writeObserved && syncPolicy.writeOutcome === null) {
      setPendingSync(null);
    }
  }, [pendingSync, syncPolicy.isWriting, syncPolicy.writeOutcome]);

  useEffect(() => {
    if (currentPhase !== OnboardingPhase.SyncPolicy) {
      setPendingSync(null);
      setSyncError(null);
    }
  }, [currentPhase]);

  useEffect(() => {
    if (currentPhase !== OnboardingPhase.CreateOrganization) {
      setOrganizationCreationError(null);
      setOrganizationCreating(false);
    }
  }, [currentPhase]);

  // Same discipline as the create error above. Without it a save failure
  // survives a Back/Start round trip and the next Choose visit opens on an old
  // failure for something the reader has not yet attempted (whitlockk, ISS-11253
  // review) — the step reporting a state that is not true.
  useEffect(() => {
    if (currentPhase !== OnboardingPhase.ChooseOrganization) {
      setOrganizationRenameError(null);
      setOrganizationRenaming(false);
    }
  }, [currentPhase]);

  useEffect(() => {
    if (
      !pendingSync ||
      syncPolicy.isWriting ||
      syncPolicy.writeOutcome === null
    ) {
      return;
    }
    const outcome = syncPolicy.writeOutcome;
    if (
      outcome.status === SettingsLocalDeviceStatus.Ready &&
      outcome.recorded
    ) {
      postTransition(
        pendingSync.snapshot,
        { type: OnboardingEvent.ContinueFromSyncPolicy },
        {
          analytics: {
            syncPolicyChoice: syncPolicyChoiceForDataSyncLevel(
              pendingSync.level
            ),
          },
          onSettled: () => setPendingSync(null),
        }
      );
      return;
    }
    setPendingSync(null);
    setSyncError(syncSaveFailedMessage);
  }, [
    pendingSync,
    postTransition,
    syncPolicy.isWriting,
    syncPolicy.writeOutcome,
    syncSaveFailedMessage,
  ]);

  const dashboardEnteredRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !(dashboardActive && snapshot && currentState) ||
      currentState.phase !== OnboardingPhase.DashboardAvailable ||
      transition.isPending
    ) {
      return;
    }
    if (dashboardEnteredRevisionRef.current === snapshot.revision) {
      return;
    }
    dashboardEnteredRevisionRef.current = snapshot.revision;
    postTransition(snapshot, { type: OnboardingEvent.DashboardEntered });
  }, [
    currentState,
    dashboardActive,
    postTransition,
    snapshot,
    transition.isPending,
  ]);

  const githubConnection = deriveGuidedOnboardingGitHubConnection({
    context: snapshot?.context,
    host,
    status: githubStatus,
  });
  const desktopSkipEligibility = deriveOnboardingDesktopSkipEligibility(
    snapshot?.context.membership
  );
  const accountEstablished = readerHasAccount(snapshot, account);
  const accountMethodHandlers = buildAccountMethodHandlers(onAccountSelect);
  const phase =
    currentState && isWizardPhaseForHost(currentState)
      ? currentState.phase
      : undefined;

  return (
    <>
      {/* ISS-10492: the ambient analysis bar, ADDITIVE to and orthogonal to the
          wizard beneath it. It is not one of the dialog's screens — it persists
          across phases and past the wizard's exit, which is the whole point of
          a bar rather than a step — so it is rendered here, by the component
          that already owns the run for BOTH the server and the guest path. A
          second reader of the guest run would get its own `useState` copy and
          lag one transition behind this one. */}
      {onAnalysisBannerHeightChange ? (
        <OnboardingAnalysisBanner
          {...resolveAnalysisBannerInputs({
            discovery,
            history: currentState?.history,
            override: analysisBannerOverride,
            phase: currentPhase,
            progress,
            runStanding,
            settled: analysisSettled,
          })}
          onHeightChange={onAnalysisBannerHeightChange}
        />
      ) : null}
      <GuidedOnboardingDialog
        account={account}
        accountCreated={accountEstablished}
        accountMethod={accountMethodForProvider(
          snapshot?.context.accountProvider
        )}
        accountPendingMethod={accountPendingMethod}
        accountSignInError={accountSignInError}
        allowStagedOrganizationLogo={
          allowStagedOrganizationLogo && Boolean(onCreateOrganization)
        }
        analysisStarted={analysisStarted}
        brand={brand}
        desktopAppDownloaded={snapshot?.context.desktopAppDownloaded ?? false}
        desktopAppRunning={desktopAppRunning}
        desktopMode={desktopMode}
        desktopSkipEligibility={desktopSkipEligibility}
        discovery={discovery}
        downloadHrefs={downloadHrefs}
        githubConnectError={githubConnectError}
        githubConnecting={githubConnecting}
        githubConnection={githubConnection}
        invitedEmails={invite.invitedEmails}
        inviteOutcome={inviteStep.stepOutcome}
        joinableOrganization={joinableOrganization}
        members={members}
        onBack={handleBack}
        onComplete={handleComplete}
        onConnectGitHub={onConnectGitHub}
        // Session Discovery's Continue. Without it `selectAnalysisStepProps`
        // falls back to `onComplete`, which at any phase other than Account just
        // calls `onDashboardAvailable()` — so the button navigated underneath the
        // dialog while the run stayed on SessionDiscovery, a blocking phase, and
        // the modal never closed. Nothing else in the repo produced
        // `ContinueFromDiscovery`, which is why the machine's own edge out of this
        // phase had no producer at all.
        onContinue={() =>
          postCurrentTransition(
            { type: OnboardingEvent.ContinueFromDiscovery },
            { analytics: discoveryAnalyticsOutcome(discovery) }
          )
        }
        onContinueFromDownload={handleDownloadContinue}
        onContinueFromGitHub={() =>
          postCurrentTransition({ type: OnboardingEvent.ConnectGitHub })
        }
        onContinueFromInvites={inviteStep.advance}
        onContinueFromOrganization={(event) => postCurrentTransition(event)}
        onContinueFromSync={handleSyncContinue}
        onContinueWithEmail={accountMethodHandlers.onContinueWithEmail}
        onContinueWithGitHub={accountMethodHandlers.onContinueWithGitHub}
        onContinueWithGoogle={accountMethodHandlers.onContinueWithGoogle}
        onContinueWithoutInstalling={handleContinueWithoutInstalling}
        onCreateOrganization={handleOrganizationReady}
        onDownloadApp={handleDownloadContinue}
        onInviteTeam={(emails) => {
          invite.invite(emails).catch(() => undefined);
        }}
        onJoinOrganization={organizationJoin.join}
        // FIRST USER only, and that is a permission gate as much as a scope one.
        // `organizationChosen` is true for ANY session with an active
        // organization — `chooseActiveOrganization` routes a member invited into
        // someone else's organization to this same step — and such a member is
        // usually not allowed to rename it. A first user's organization is the
        // one Clerk's signup task made FOR them, so they are its admin, and they
        // are the cohort ISS-11253 is about.
        onRenameOrganization={
          offersOrganizationRename(snapshot, onRenameOrganization)
            ? handleOrganizationRenamed
            : undefined
        }
        onRetryJoinableOrganizationLookup={onRetryJoinableOrganizationLookup}
        onSignIn={onSignIn}
        onSignOut={onSignOut ? handleSignOut : undefined}
        onSkipAccount={() =>
          postCurrentTransition({ type: OnboardingEvent.SkipAccount })
        }
        onSkipDownload={() =>
          postCurrentTransition({ type: OnboardingEvent.SkipDownload })
        }
        onSkipGitHub={buildGitHubSkipHandler(
          currentState,
          postCurrentTransition
        )}
        onSkipInvites={() =>
          inviteStep.leave((onSettled) =>
            postCurrentTransition(
              { type: OnboardingEvent.SkipInvitations },
              { onSettled }
            )
          )
        }
        onStart={() => postCurrentTransition({ type: OnboardingEvent.Start })}
        onSyncLevelChange={(level) => {
          setSelectedSyncLevel(level);
          setSyncError(null);
        }}
        open={open}
        organizationChosen={organizationChosen}
        organizationCreating={organizationCreating}
        organizationCreationError={organizationCreationError}
        organizationJoinError={organizationJoin.error}
        organizationJoining={organizationJoin.joining}
        organizationName={organizationName}
        organizationRenameError={organizationRenameError}
        organizationRenaming={organizationRenaming}
        organizationSlug={organizationSlug}
        phase={phase}
        progress={progress}
        restoring={run ? run.isLoading : snapshotQuery.isLoading}
        syncError={syncError ?? syncReadError}
        syncLevel={syncLevel}
        syncSaving={
          syncPolicy.isWriting || (pendingSync !== null && transition.isPending)
        }
      />
    </>
  );

  function handleBack() {
    // A way off the invite step is already in flight (ISS-11670).
    if (inviteStep.isLeaving()) {
      return;
    }
    if (!(snapshot && currentState)) {
      onBackFallback();
      return;
    }
    if (currentState.history.length > 0) {
      if (currentPhase === OnboardingPhase.InviteTeam) {
        inviteStep.leave((onSettled) =>
          postCurrentTransition({ type: OnboardingEvent.Back }, { onSettled })
        );
      } else {
        postCurrentTransition({ type: OnboardingEvent.Back });
      }
      return;
    }
    setRecoveredRevision(snapshot.revision);
    onBackFallback();
  }

  function handleComplete() {
    if (
      snapshot &&
      currentState?.phase === OnboardingPhase.Account &&
      accountEstablished
    ) {
      postCurrentTransition(
        createAccountEstablishedEventForProvider(
          snapshot.context.accountProvider
        ),
        // Arity preserved for a run poster that counts arguments (see
        // `postCurrentTransition`): a host with no observed auth return —
        // web — posts exactly the two-argument call it always did.
        accountMode === undefined ? undefined : { analytics: { accountMode } }
      );
      return;
    }
    onDashboardAvailable();
  }

  function handleContinueWithoutInstalling() {
    onDownloadDesktop?.();
    postCurrentTransition(
      { type: OnboardingEvent.DownloadDesktopApp },
      { analytics: { downloadClicked: false } }
    );
  }

  function handleDownloadContinue() {
    onDownloadDesktop?.();
    postCurrentTransition({ type: OnboardingEvent.DownloadDesktopApp });
  }

  function handleOrganizationReady(
    organization: OrganizationDetails,
    event: OnboardingEventInput
  ) {
    if (!(snapshot && onCreateOrganization)) {
      setOrganizationCreationError(ORGANIZATION_CREATE_UNAVAILABLE_MESSAGE);
      return;
    }
    const submittedSnapshot = snapshot;
    setOrganizationCreationError(null);
    setOrganizationCreating(true);
    Promise.resolve(onCreateOrganization(organization))
      .then(() => {
        postTransition(submittedSnapshot, event, {
          onSettled: () => setOrganizationCreating(false),
        });
      })
      .catch(() => {
        setOrganizationCreating(false);
        setOrganizationCreationError(organizationCreateFailedMessage);
      });
  }

  /**
   * The choose step's Continue when the host can rename: persist the name and
   * slug on the organization the session is ALREADY in, then post the same
   * OrganizationReady the confirmation-only path posts (ISS-11253).
   *
   * The rename gates the transition exactly as the create does, so a failed
   * write cannot advance the run with the old name silently kept. It is an
   * update of the active organization, never a create: creating one here is the
   * duplicate-organization defect ISS-11090 fixed.
   */
  function handleOrganizationRenamed(
    organization: { name: string; slug: string },
    event: OnboardingEventInput
  ) {
    if (!(snapshot && onRenameOrganization)) {
      setOrganizationRenameError(organizationRenameFailedMessage);
      return;
    }
    const submittedSnapshot = snapshot;
    setOrganizationRenameError(null);
    setOrganizationRenaming(true);
    Promise.resolve(onRenameOrganization(organization))
      .then(() => {
        postTransition(submittedSnapshot, event, {
          onSettled: () => setOrganizationRenaming(false),
        });
      })
      .catch(() => {
        setOrganizationRenaming(false);
        setOrganizationRenameError(organizationRenameFailedMessage);
      });
  }

  function handleSyncContinue(level: SyncConsentLevel) {
    if (!(snapshot && syncProjection)) {
      setSyncError(syncSaveFailedMessage);
      return;
    }
    setSyncError(null);
    setPendingSync({ level, snapshot, writeObserved: false });
    syncPolicy.write(level);
  }
}

/**
 * Whether this run may rename its organization: the host can persist one, and
 * the reader is the FIRST USER. That second half is a permission gate as much as
 * a scope one — `organizationChosen` is true for ANY session with an active
 * organization, and `chooseActiveOrganization` routes a member invited into
 * someone else's organization to the same step, where they are usually not
 * allowed to rename it. A first user's organization is the one Clerk's signup
 * task made FOR them, so they are its admin (ISS-11253).
 */
function offersOrganizationRename(
  snapshot: GuidedOnboardingSnapshot | null,
  onRenameOrganization: OrganizationRenameHandler | undefined
): boolean {
  return (
    onRenameOrganization !== undefined &&
    snapshot?.context.membership === OrganizationMembership.FirstUser
  );
}

const DEFAULT_SYNC_SAVE_FAILED_MESSAGE =
  "We couldn't save your choice. Please try again.";
const DEFAULT_ORGANIZATION_CREATE_FAILED_MESSAGE =
  "We couldn't create your organization. Please try again.";
const DEFAULT_ORGANIZATION_RENAME_FAILED_MESSAGE =
  "We couldn't save your organization. Please try again.";
const ORGANIZATION_CREATE_UNAVAILABLE_MESSAGE =
  "Organization creation isn't available here yet. Create one from the web app, then return to onboarding.";

type PendingSyncTransition = {
  /** The consent level being written, for `sync_policy_choice` (ISS-10502). */
  level: SyncConsentLevel;
  snapshot: GuidedOnboardingSnapshot;
  writeObserved: boolean;
};

type TransitionPoster = ReturnType<
  typeof useGuidedOnboardingTransition
>["mutate"];

type TransitionCallbacks = {
  onSettled?: () => void;
  /** PRD-736 step-outcome facts the machine cannot see (invite counts). */
  analytics?: OnboardingTransitionAnalyticsOutcome;
};

function useTransitionPoster(
  host: OnboardingHost,
  onDashboardAvailable: () => void,
  mutate: TransitionPoster
) {
  return useCallback(
    (
      snapshot: GuidedOnboardingSnapshot,
      event: OnboardingEventInput,
      callbacks?: TransitionCallbacks
    ) => {
      mutate(
        { analytics: callbacks?.analytics, event, snapshot },
        {
          onSettled: callbacks?.onSettled,
          onSuccess: (nextSnapshot) => {
            if (nextSnapshot === null) {
              return;
            }
            const nextState = restoreOnboardingState(
              nextSnapshot.state,
              host
            ).state;
            if (nextState.phase === OnboardingPhase.DashboardAvailable) {
              onDashboardAvailable();
            }
          },
        }
      );
    },
    [host, mutate, onDashboardAvailable]
  );
}

function getReadySyncPolicyProjection(
  state: ReturnType<typeof useLocalSyncPolicy>["state"]
): Extract<
  SettingsLocalSyncPolicyProjection,
  { status: typeof SettingsLocalDeviceStatus.Ready }
> | null {
  if (
    state.status === "settled" &&
    state.projection.status === SettingsLocalDeviceStatus.Ready
  ) {
    return state.projection;
  }
  return null;
}

function getSyncReadError(
  supported: boolean,
  state: ReturnType<typeof useLocalSyncPolicy>["state"]
): string | null {
  if (!supported) {
    return "This device can't save sync choices here.";
  }
  if (
    state.status === "settled" &&
    state.projection.status !== SettingsLocalDeviceStatus.Ready
  ) {
    return "We couldn't read this device's sync settings. Try again from Settings.";
  }
  return null;
}

function toSyncConsentLevel(
  projection: ReturnType<typeof getReadySyncPolicyProjection>
): SyncConsentLevel | null {
  const level = projection?.recorded ? projection.level : undefined;
  if (
    level === DataSyncLevel.Full ||
    level === DataSyncLevel.Metadata ||
    level === DataSyncLevel.Off
  ) {
    return level;
  }
  return null;
}

function accountMethodForProvider(
  provider: AccountProvider | null | undefined
): AuthMethod | null {
  if (provider === AccountProvider.Email) {
    return "email";
  }
  if (provider === AccountProvider.GitHub) {
    return "github";
  }
  if (provider === AccountProvider.Google) {
    return "google";
  }
  return null;
}

function isWizardPhaseForHost(
  state: OnboardingMachineState
): state is OnboardingMachineState & {
  phase: GuidedOnboardingDialogProps["phase"];
} {
  return isWizardPhase(state.phase);
}

/**
 * Which of the three standings the run is at for {@link
 * resolveAnalysisBannerInputs}.
 *
 * A phase settles it outright — a run with a phase has been read. Without one,
 * the read being in flight is the only thing separating "not yet" from "there is
 * no run", and only the first suppresses the bar.
 */
function resolveRunStanding({
  phase,
  readPending,
}: {
  phase: OnboardingPhase | undefined;
  readPending: boolean;
}): OnboardingRunStanding {
  if (phase !== undefined) {
    return OnboardingRunStanding.Read;
  }
  return readPending
    ? OnboardingRunStanding.Unread
    : OnboardingRunStanding.Absent;
}

/**
 * Whether the read that would produce this mount's run is still outstanding.
 *
 * One expression over two sources. A SUPPLIED run answers for itself — the
 * guest handoff reports `isLoading` with `snapshot: null` while its command is
 * in flight, which is a run being read, not an absent one.
 *
 * For the server read, being DISABLED is not one answer. Until the identity
 * resolves the query is gated off and will still fire, so the run is unread;
 * once it resolves signed-out the query is gated off for good, so no server run
 * is coming and the reader is owed the bar. `isLoading` separates them
 * (`isPending && isFetching`) where `isPending` alone reports both as unread.
 */
function resolveRunReadPending({
  authLoaded,
  run,
  serverReadLoading,
}: {
  authLoaded: boolean;
  run: GuidedOnboardingRun | undefined;
  serverReadLoading: boolean;
}): boolean {
  if (run) {
    return run.isLoading;
  }
  return !authLoaded || serverReadLoading;
}

/** GitHub authorization is optional during the initial onboarding run. */
function buildGitHubSkipHandler(
  state: OnboardingMachineState | null,
  post: (event: OnboardingEventInput) => void
): (() => void) | undefined {
  if (state?.resuming !== false) {
    return undefined;
  }
  return () => post({ type: OnboardingEvent.SkipGitHub });
}

function runOrganizationActive(
  run: GuidedOnboardingRun | undefined,
  authSnapshot: Parameters<typeof organizationActiveFlag>[0]
): KnownFlag {
  if (run?.awaitingOrganization === true && authSnapshot.orgId === null) {
    return KnownFlag.No;
  }
  return organizationActiveFlag(authSnapshot);
}
