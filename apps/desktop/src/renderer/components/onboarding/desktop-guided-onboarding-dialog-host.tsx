import { onboardingAccountModesForOutcome } from "@repo/api/src/types/onboarding-analytics";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { resolveGitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { ClosedloopBrandLockup } from "@repo/app/onboarding/components/closedloop-brand-lockup";
import { GuidedOnboardingDialogHost } from "@repo/app/onboarding/components/guided-onboarding-dialog-host";
import type { OrganizationDetails } from "@repo/app/onboarding/components/guided-onboarding-types";
import { createAccountEstablishedEvent } from "@repo/app/onboarding/lib/guided-onboarding-events";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useOnboardingSessionDiscovery } from "../../hooks/use-onboarding-session-discovery";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectFailureMessage,
} from "../../shared-branches/desktop-github-connect-copy";
import { useDesktopGitHubIntegrationStatus } from "../../shared-branches/desktop-github-integration-status";
import { useStartupReadiness } from "../../startup-readiness/use-startup-readiness";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";
import { useAnalysisBannerHeightReporter } from "./analysis-banner-offset";
import { setBlockingOnboardingModalOpen } from "./blocking-onboarding-modal-store";
import { DesktopAuthFraming } from "./desktop-auth-copy";
import {
  clearGuidedOnboardingRunOverride,
  setGuidedOnboardingRunOverride,
} from "./guided-onboarding-run-override-store";
import { serializeBootstrapLogo } from "./serialize-bootstrap-logo";
import { SAVE_FAILED_MESSAGE } from "./sync-consent-committed-level";
import {
  deviceSyncConsentRecordedFlag,
  electedCloudSync,
  syncConsentRecordedFlag,
} from "./sync-consent-recorded-flag";
import { useDesktopSignIn } from "./use-desktop-sign-in";
import { useGuestGuidedOnboardingHandoff } from "./use-guest-guided-onboarding-handoff";
import { useGuestGuidedOnboardingRun } from "./use-guest-guided-onboarding-run";
import { canOfferAccount, useGuestOnboarding } from "./use-guest-onboarding";
import { useDeviceSyncConsentRecord } from "./use-sync-consent-record";

export function DesktopGuidedOnboardingDialogHost() {
  const { navigate } = useNavigation();
  const pathname = usePath();
  const auth = useDesktopAuth();
  const guest = useGuestOnboarding();
  const identity = useDesktopIdentity(auth.state.status, auth.state.userId);
  const githubStatus = useDesktopGitHubIntegrationStatus();
  const connectAction = resolveGitHubConnectAction({
    authenticated: auth.state.status === DesktopAuthStatus.Authenticated,
    status: githubStatus,
  });
  const githubConnect = useDesktopGitHubConnect({
    connectAction,
    returnTo: pathname,
    returnToDesktop: true,
  });
  const discovery = useOnboardingSessionDiscovery(true);
  const syncConsent = useDeviceSyncConsentRecord();
  const syncConsentRecorded = canOfferAccount(guest)
    ? deviceSyncConsentRecordedFlag(syncConsent.record)
    : syncConsentRecordedFlag(syncConsent.record, auth.state.organizationId);
  // ISS-10492: the desktop startup pass drives the one ambient bar. That diff
  // deleted the `StartupReadinessPanel` that used to render it; its data and its
  // visibility gate moved to `useStartupReadiness`, so the bar appears where that
  // panel did and states the same stages.
  const startupReadiness = useStartupReadiness({
    analysis: { discovery: discovery.discovery, progress: discovery.progress },
    syncElected:
      auth.state.status === DesktopAuthStatus.Authenticated &&
      electedCloudSync(syncConsent.record, auth.state.organizationId),
  });
  // Undefined where no shell is reserving space for the bar, which is what keeps
  // a fixed-position bar from being mounted over the content it describes.
  const reportAnalysisBannerHeight = useAnalysisBannerHeightReporter();
  // The Account step serves every guest "Create account" entry point (ISS-11480),
  // so a pick shows busy and a failed sign-in is reported, as Settings does.
  const signIn = useDesktopSignIn(DesktopAuthFraming.SignUp);
  // PRD-736 `account_mode` (ISS-10913). Folded here, at the one renderer
  // boundary that reads the main-process auth state, so both desktop paths
  // that complete the Account step report the same set — and so an auth state
  // from a gateway that predates the field folds to `["unknown"]` instead of
  // the property going missing.
  const accountMode = onboardingAccountModesForOutcome(
    auth.state.accountOutcome
  );
  const dashboardHref = hrefForNavId(NavId.Dashboard);
  const accountEmail =
    identity.identity?.userId === auth.state.userId
      ? identity.identity.email
      : null;
  const organizationIdentity =
    identity.identity?.organizationId === auth.state.organizationId
      ? identity.identity
      : null;
  const organizationName = organizationIdentity?.organizationName ?? "";
  const navigateToDashboard = useCallback(() => {
    navigate(dashboardHref);
  }, [dashboardHref, navigate]);
  const createBootstrapOrganization = useCallback(
    async ({ name, slug, logoFile }: OrganizationDetails) => {
      const createOrganization = window.desktopApi?.createBootstrapOrganization;
      if (!createOrganization) {
        throw new Error("Desktop bootstrap organization bridge unavailable");
      }
      const result = await createOrganization({
        name,
        slug,
        ...(logoFile ? { logo: await serializeBootstrapLogo(logoFile) } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    },
    []
  );
  // ISS-10195 follow-up: a settled signed-out guest has no server run to read,
  // so the run is local.
  const guestRun = useGuestGuidedOnboardingRun({
    accountMethod: signIn.pendingMethod,
    active: canOfferAccount(guest) || auth.state.awaitingOrganization === true,
    analysisStarted: discovery.started,
    onDashboardAvailable: navigateToDashboard,
    pendingUserId: auth.state.pendingUserId,
    organizationAwaiting: auth.state.awaitingOrganization === true,
    syncConsentRecorded,
  });
  // ...and the instant that guest signs in, the local run is handed to a server
  // attempt before the server becomes the source. Without this the mount falls
  // back to a server that has no attempt for a brand-new account, which answers
  // a first run and replays Welcome and Session Discovery over a guest who just
  // finished them.
  const handoffRun = useGuestGuidedOnboardingHandoff({
    accountMode,
    active: auth.state.status === DesktopAuthStatus.Authenticated,
    analysisStarted: discovery.started,
    onDashboardAvailable: navigateToDashboard,
    // This host is not keyed by account, so it survives a sign-out and back in
    // and an organization switch. The handoff needs the identity to know whose
    // position a held run describes.
    organizationId: auth.state.organizationId,
    syncConsentRecorded,
    userId: auth.state.userId,
  });

  const run = guestRun ?? handoffRun;
  // This host lives as long as the shell, so a failure reported on the Account
  // step would otherwise greet the guest the next time they open it. Cleared
  // whenever the run is anywhere but Account; a sign-in in flight unmounts the
  // guest run, but its failure lands before the step returns, so it still shows.
  const runPhase = run?.snapshot
    ? restoreOnboardingState(run.snapshot.state, OnboardingHost.Desktop).state
        .phase
    : undefined;
  useEffect(() => {
    if (
      auth.state.awaitingOrganization !== true ||
      signIn.pendingMethod === null ||
      runPhase !== OnboardingPhase.Account ||
      !guestRun?.snapshot
    ) {
      return;
    }
    guestRun.postTransition(
      guestRun.snapshot,
      createAccountEstablishedEvent(signIn.pendingMethod),
      { analytics: { accountMode } }
    );
  }, [
    accountMode,
    auth.state.awaitingOrganization,
    guestRun,
    runPhase,
    signIn.pendingMethod,
  ]);
  const { clearError: clearSignInError } = signIn;
  useEffect(() => {
    if (runPhase !== OnboardingPhase.Account) {
      clearSignInError();
    }
  }, [clearSignInError, runPhase]);
  // ISS-11251: published for the sidebar's server-owned checklist card, which is
  // in another tree and would otherwise offer a resume this mount cannot show.
  //
  // LAYOUT-timed, for the reason `blocking-onboarding-modal-store.ts` states for
  // the same crossing: the card is a shell SIBLING that renders in this same
  // commit, and a passive publish lands after it, so the card would spend its
  // first render believing the run is the server's and fire the very snapshot
  // request the override exists to suppress.
  //
  // The store compares runs BY FIELD, so this republishing on every render is a
  // no-op rather than churn; neither source memoizes its return.
  useLayoutEffect(() => {
    setGuidedOnboardingRunOverride(run);
  }, [run]);
  // Cleared on UNMOUNT only — an empty dependency list, and the ref is what lets
  // the teardown name the run it actually published rather than the one captured
  // at mount. A clear on every effect re-run would reintroduce the transient
  // `undefined` the card's `run === undefined` gate reads.
  const publishedRun = useRef(run);
  publishedRun.current = run;
  useLayoutEffect(
    () => () => clearGuidedOnboardingRunOverride(publishedRun.current),
    []
  );

  return (
    <GuidedOnboardingDialogHost
      account={
        accountEmail ? { email: accountEmail, status: "signed-in" } : undefined
      }
      accountMode={accountMode}
      accountPendingMethod={signIn.pendingMethod}
      accountSignInError={signIn.error}
      allowStagedOrganizationLogo={auth.state.awaitingOrganization === true}
      analysisBannerOverride={startupReadiness}
      analysisSettled={discovery.settled}
      analysisStarted={discovery.started}
      brand={<ClosedloopBrandLockup />}
      dashboardActive={pathname === dashboardHref}
      desktopMode={true}
      discovery={discovery.discovery}
      // ISS-10990: the terminal outcome, not just the in-flight one. Reading
      // `connectState` for `Pending` alone discarded `Failed` and
      // `SignInRequired`, so a handoff the main process refused ran the spinner
      // and then restored the screen unchanged — the silent dead click this
      // step is the ONLY connect surface that still had. Settings already
      // renders this exact message beside the same prompt.
      githubConnectError={desktopGitHubConnectFailureMessage(
        githubConnect.connectState,
        DesktopGitHubConnectSurface.Panel
      )}
      githubConnecting={
        githubConnect.connectState === DesktopGitHubConnectState.Pending
      }
      githubStatus={githubStatus ?? null}
      host={OnboardingHost.Desktop}
      // An awaiting-organization bootstrap has no org-bound identity to read
      // yet. `organizationChosen` below is the authoritative empty fact for
      // that path; this optional projection stays reserved for a normal session
      // whose organization identity read is still settling.
      joinableOrganization={
        organizationName
          ? { name: organizationName, status: "available" }
          : undefined
      }
      onAccountSelect={({ email, method }) => signIn.onSelect(method, email)}
      onAnalysisAgreed={recordSessionAnalysisAgreement}
      onAnalysisBannerHeightChange={reportAnalysisBannerHeight}
      onBackFallback={() => navigate(dashboardHref)}
      onConnectGitHub={() => {
        githubConnect.connectGitHub().catch(() => undefined);
      }}
      onCreateOrganization={createBootstrapOrganization}
      onDashboardAvailable={navigateToDashboard}
      // ISS-10570: the dashboard mounts behind this modal, and its first-launch
      // tour would otherwise spend its one shot on a run nobody can see.
      onOpenChange={setBlockingOnboardingModalOpen}
      // "Already have an account? Sign in" on the Account step. Without this it
      // falls back to the dialog's `onComplete`, which only posts a transition
      // for an ESTABLISHED account — so a guest pressing it navigated beneath a
      // dialog that never closed and never reached `beginSignIn`. SignIn
      // framing, not SignUp: this door is for an account that already exists.
      onSignIn={() => {
        auth
          .beginSignIn(undefined, undefined, DesktopAuthFraming.SignIn)
          .catch(() => undefined);
      }}
      // The raw promise, not a swallowed one: the shared host clears the
      // onboarding flow session only when the sign-out actually resolves.
      onSignOut={() => auth.signOut()}
      organizationChosen={Boolean(auth.state.organizationId)}
      organizationName={organizationName}
      organizationSlug={organizationIdentity?.organizationSlug ?? ""}
      progress={discovery.progress}
      run={run}
      syncConsentRecorded={syncConsentRecorded}
      syncSaveFailedMessage={SAVE_FAILED_MESSAGE}
    />
  );
}

/**
 * ISS-10890: an accepted Welcome Start, for guests and signed-in readers alike,
 * records this device's agreement to local analysis, which releases the
 * main-process boot gate (ISS-10950). Idempotent in main; a failed call is
 * retried the next time the host mounts on a run past Welcome. Optional on the
 * bridge because the browser mirror does not carry it.
 */
function recordSessionAnalysisAgreement(): void {
  window.desktopApi?.recordSessionAnalysisAgreement?.().catch(() => undefined);
}
