// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingSyncPolicyChoice,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import {
  SettingsLocalDeviceReason,
  settingsLocalSyncPolicyError,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import {
  createStaticAuthAdapter,
  type StaticAuthOptions,
} from "../../../shared/auth/static-auth-adapter";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import {
  readOnboardingFlowSession,
  resetOnboardingFlowSessionForTests,
  startOnboardingFlowSession,
} from "../../lib/onboarding-flow-session";
import {
  IDLE_INVITE_OUTCOME,
  OnboardingAnalysisEstimateStatus,
  OnboardingJoinAuthority,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { DESKTOP_WELCOME_CTA_LABEL } from "../guided-onboarding-welcome-copy";

import { localSyncPolicy } from "./guided-onboarding-sync-policy-fixture";

const mockHostDeps = vi.hoisted(() => ({
  inviteTeam: vi.fn(),
  localSyncPolicy: null as unknown,
  mutate: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

// Behind `useDesktopAppRunning`: these suites mount the host with no provider.
vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockHostDeps.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: mockHostDeps.useGuidedOnboardingTransition,
}));

vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: mockHostDeps.inviteTeam,
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
}));

vi.mock("../../../shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => mockHostDeps.localSyncPolicy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockHostDeps.localSyncPolicy = localSyncPolicy({
    projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
  });
  mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
    data: blockingSnapshot(OnboardingPhase.DownloadDesktop),
    isLoading: false,
  });
  mockHostDeps.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mockHostDeps.mutate,
  });
});

describe("GuidedOnboardingDialogHost", () => {
  it("opens from a supplied run without waiting for a server snapshot", () => {
    const runSnapshot = blockingSnapshot(OnboardingPhase.Welcome);
    const postTransition = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
      run: {
        isLoading: false,
        postTransition,
        snapshot: runSnapshot,
      },
    });

    expect(
      screen.getByRole("heading", {
        name: "Discover how you (and your team) build with AI.",
      })
    ).not.toBeNull();
    expect(mockHostDeps.useGuidedOnboardingSnapshot).toHaveBeenCalledWith(
      OnboardingHost.Desktop,
      { enabled: false }
    );

    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(postTransition).toHaveBeenCalledWith(runSnapshot, {
      type: OnboardingEvent.Start,
    });
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });

  it("passes a real Back transition to the production dialog mount", () => {
    const snapshot = blockingSnapshot(OnboardingPhase.DownloadDesktop, {
      desktopAppDownloaded: false,
      organizationHasSyncedSessionData: KnownFlag.No,
    });
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderHost();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      {
        event: { type: OnboardingEvent.Back },
        snapshot,
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      })
    );
  });

  it("persists a staged organization before posting the ready transition", async () => {
    const logoFile = new File(["logo"], "logo.png", { type: "image/png" });
    const onCreateOrganization = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    );
    const snapshot = createOrganizationSnapshot();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderHostWithNoOrganization({
      allowStagedOrganizationLogo: true,
      onCreateOrganization,
    });
    fireEvent.change(screen.getByLabelText("Organization logo file"), {
      target: { files: [logoFile] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(onCreateOrganization).toHaveBeenCalledWith({
      logoFile,
      name: "Example Organization",
      slug: "example-organization",
    });
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockHostDeps.mutate).toHaveBeenCalledWith(
        {
          event: { type: OnboardingEvent.OrganizationReady },
          snapshot,
        },
        expect.objectContaining({
          onSuccess: expect.any(Function),
        })
      )
    );
  });

  it("does not post the ready transition when organization creation fails", async () => {
    const onCreateOrganization = vi
      .fn()
      .mockRejectedValue(new Error("provider refused organization"));
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: createOrganizationSnapshot(),
      isLoading: false,
    });

    renderHostWithNoOrganization({ onCreateOrganization });
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(onCreateOrganization).toHaveBeenCalledWith({
      name: "Example Organization",
      slug: "example-organization",
    });
    await screen.findByText(
      "We couldn't create your organization. Please try again."
    );
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });

  // ISS-11090 review: a null orgId while auth loads, when signed out, or with no
  // provider is not "no organization", so a parked create run is not offered
  // the create step on it.
  // ISS-11145. The Join button must not be a control that reports work it did not
  // do: a rejected join states itself and the run STAYS on ChooseOrganization.
  it("does not post the ready transition when the organization join fails", async () => {
    const onJoinOrganization = vi
      .fn()
      .mockRejectedValue(new Error("provider refused join"));
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: createChooseOrganizationSnapshot(),
      isLoading: false,
    });

    renderHostWithNoOrganization({
      joinableOrganization: {
        join: { authority: OnboardingJoinAuthority.Invitation, id: "inv_1" },
        name: "Acme Research",
        status: "available",
      },
      onJoinOrganization,
      organizationChosen: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(onJoinOrganization).toHaveBeenCalledWith({
      authority: OnboardingJoinAuthority.Invitation,
      id: "inv_1",
    });
    await screen.findByText(
      "We couldn't accept that invitation. It may have been revoked or expired — ask an admin to send a new one, or create an organization below."
    );
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });

  it("posts the ready transition only after the organization join resolves", async () => {
    const onJoinOrganization = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    );
    const snapshot = createChooseOrganizationSnapshot();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderHostWithNoOrganization({
      joinableOrganization: {
        join: { authority: OnboardingJoinAuthority.Membership, id: "org_1" },
        name: "Acme Research",
        status: "available",
      },
      onJoinOrganization,
      organizationChosen: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockHostDeps.mutate).toHaveBeenCalledWith(
        {
          event: { type: OnboardingEvent.OrganizationReady },
          snapshot,
        },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      )
    );
  });

  it("shows a parked create run the choose step when no session states it has no organization", () => {
    const onCreateOrganization = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: createOrganizationSnapshot(),
      isLoading: false,
    });

    renderHost({ onCreateOrganization });

    expect(
      screen.getByRole("heading", { name: "Choose an organization" })
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create organization" })
    ).toBeNull();
  });

  it("keeps the sync step open until the Settings save records consent", async () => {
    const write = vi.fn();
    const snapshot = blockingSnapshot(OnboardingPhase.SyncPolicy);
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      write,
    });
    const view = renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
    });

    fireEvent.click(screen.getByRole("radio", { name: "Full transcripts" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(write).toHaveBeenCalledWith(DataSyncLevel.Full);
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();

    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, true),
      write,
      writeOutcome: settingsLocalSyncPolicyReady(DataSyncLevel.Full, true),
    });
    view.rerender(
      <HostHarness desktopMode={true} host={OnboardingHost.Desktop} />
    );

    await waitFor(() =>
      expect(mockHostDeps.mutate).toHaveBeenCalledWith(
        {
          // ISS-10502: the completion carries the consent level actually
          // written, mapped to the wire sync_policy_choice vocabulary.
          analytics: {
            syncPolicyChoice: OnboardingSyncPolicyChoice.FullTranscripts,
          },
          event: { type: OnboardingEvent.ContinueFromSyncPolicy },
          snapshot,
        },
        expect.objectContaining({
          onSettled: expect.any(Function),
        })
      )
    );
  });

  it("carries the measured discovery outcome on the Session Discovery continue (ISS-10502)", () => {
    const runSnapshot = blockingSnapshot(OnboardingPhase.SessionDiscovery);
    const postTransition = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    renderHost({
      desktopMode: true,
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        logBytes: null,
        sessionsAnalyzed: null,
        sessionsFound: 41,
        sources: [
          {
            detection: { analyzed: null, found: 41, status: "detected" },
            harness: "claude",
            label: "Claude Code",
          },
          {
            detection: { status: "not-detected" },
            harness: "cursor",
            label: "Cursor",
          },
        ],
        status: "measured",
      },
      host: OnboardingHost.Desktop,
      run: {
        isLoading: false,
        postTransition,
        snapshot: runSnapshot,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(postTransition).toHaveBeenCalledWith(
      runSnapshot,
      { type: OnboardingEvent.ContinueFromDiscovery },
      {
        analytics: {
          harnessesDetected: ["claude"],
          harnessesDetectedCount: 1,
          sessionsFoundCount: 41,
        },
      }
    );
  });

  it("omits the harness pair when the measured arm carries no enumeration (tamsinb on #7748)", () => {
    // The measured arm is reachable with only bytes or an estimate reported:
    // `sources` empty means nobody enumerated, and a `harnesses_detected_count`
    // of 0 there is a fabricated zero over a machine nobody counted.
    const runSnapshot = blockingSnapshot(OnboardingPhase.SessionDiscovery);
    const postTransition = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    renderHost({
      desktopMode: true,
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        logBytes: 2048,
        sessionsAnalyzed: null,
        sessionsFound: 12,
        sources: [],
        status: "measured",
      },
      host: OnboardingHost.Desktop,
      run: { isLoading: false, postTransition, snapshot: runSnapshot },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(postTransition).toHaveBeenCalledWith(
      runSnapshot,
      { type: OnboardingEvent.ContinueFromDiscovery },
      { analytics: { sessionsFoundCount: 12 } }
    );
  });

  it("reports a measured zero when every enumerated source settled not-detected", () => {
    // Evidence of absence is the only producer of `not-detected`, so an
    // all-not-detected list is a genuine zero, not a fabricated one.
    const runSnapshot = blockingSnapshot(OnboardingPhase.SessionDiscovery);
    const postTransition = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    renderHost({
      desktopMode: true,
      discovery: {
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        logBytes: null,
        sessionsAnalyzed: null,
        sessionsFound: null,
        sources: [
          {
            detection: { status: "not-detected" },
            harness: "cursor",
            label: "Cursor",
          },
        ],
        status: "measured",
      },
      host: OnboardingHost.Desktop,
      run: { isLoading: false, postTransition, snapshot: runSnapshot },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(postTransition).toHaveBeenCalledWith(
      runSnapshot,
      { type: OnboardingEvent.ContinueFromDiscovery },
      { analytics: { harnessesDetected: [], harnessesDetectedCount: 0 } }
    );
  });

  it("reports no discovery counts when the scan is unmeasured", () => {
    const runSnapshot = blockingSnapshot(OnboardingPhase.SessionDiscovery);
    const postTransition = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
      run: {
        isLoading: false,
        postTransition,
        snapshot: runSnapshot,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(postTransition).toHaveBeenCalledWith(
      runSnapshot,
      { type: OnboardingEvent.ContinueFromDiscovery },
      { analytics: {} }
    );
  });

  it("keeps an unset sync projection unselected until the user chooses", () => {
    const write = vi.fn();
    const snapshot = blockingSnapshot(OnboardingPhase.SyncPolicy);
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Metadata, false),
      write,
    });

    renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(write).toHaveBeenCalledWith(DataSyncLevel.Off);
  });

  it("clears a retired sync save without pinning the step as saving", async () => {
    const write = vi.fn();
    const snapshot = blockingSnapshot(OnboardingPhase.SyncPolicy);
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      write,
    });
    const view = renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
    });

    fireEvent.click(screen.getByRole("radio", { name: "Full transcripts" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      isWriting: true,
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      write,
    });
    view.rerender(
      <HostHarness desktopMode={true} host={OnboardingHost.Desktop} />
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
    );

    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      write,
      writeOutcome: null,
    });
    mockHostDeps.useGuidedOnboardingTransition.mockReturnValue({
      isPending: true,
      mutate: mockHostDeps.mutate,
    });
    view.rerender(
      <HostHarness desktopMode={true} host={OnboardingHost.Desktop} />
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue" })
      ).not.toBeDisabled()
    );
  });

  it("reports a failed sync save without advancing the guided state", async () => {
    const snapshot = blockingSnapshot(OnboardingPhase.SyncPolicy);
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      writeOutcome: null,
    });
    const view = renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
      syncSaveFailedMessage: "Save failed from test",
    });

    fireEvent.click(screen.getByRole("radio", { name: "Full transcripts" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    mockHostDeps.localSyncPolicy = localSyncPolicy({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      writeOutcome: settingsLocalSyncPolicyError(
        SettingsLocalDeviceReason.ReadFailed
      ),
    });
    view.rerender(
      <HostHarness
        desktopMode={true}
        host={OnboardingHost.Desktop}
        syncSaveFailedMessage="Save failed from test"
      />
    );

    await screen.findByText("Save failed from test");
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });

  // The host is the ONLY production path that emits `onboarding_flow_started`
  // and the initial Welcome `step_viewed` (a fresh Welcome is the one view no
  // transition produces). Driven through the real analytics port and the real
  // flow-session store, so a regression in the host's effect goes red here.
  it("emits exactly one fresh-flow start and initial Welcome view through the real analytics port", () => {
    resetOnboardingFlowSessionForTests();
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    const freshWelcome = {
      ...blockingSnapshot(OnboardingPhase.Welcome),
      state: serializeOnboardingState({
        accountProvider: null,
        history: [],
        organizationEstablished: false,
        phase: OnboardingPhase.Welcome,
        resuming: false,
      }),
    };
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: freshWelcome,
      isLoading: false,
    });

    const view = render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <HostHarness />
      </SurfaceAnalyticsProvider>
    );
    view.rerender(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <HostHarness />
      </SurfaceAnalyticsProvider>
    );

    const started = capture.mock.calls.filter(
      ([event]) => event === OnboardingAnalyticsEvent.FlowStarted
    );
    const viewed = capture.mock.calls.filter(
      ([event]) => event === OnboardingAnalyticsEvent.StepViewed
    );
    expect(started).toHaveLength(1);
    expect(viewed).toHaveLength(1);
    const session = readOnboardingFlowSession();
    expect(session?.startedAtMs).not.toBeNull();
    expect(started[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.FlowId]: session?.flowId,
    });
    expect(viewed[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Welcome,
    });
    resetOnboardingFlowSessionForTests();
  });

  // Codex review on ISS-10500: a signed-out account's flow session must not
  // leak into the next account signing in on the same tab. Cleared only after
  // the surface's sign-out RESOLVES — a failed sign-out keeps the live flow.
  it("clears the flow session after a successful sign-out, and keeps it on failure", async () => {
    resetOnboardingFlowSessionForTests();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: blockingSnapshot(OnboardingPhase.ChooseOrganization),
      isLoading: false,
    });

    startOnboardingFlowSession(Date.now());
    let rejectSignOut: (reason: Error) => void = () => undefined;
    const failingSignOut = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectSignOut = reject;
        })
    );
    const view = render(
      <HostHarness
        account={{ email: "user@example.com", status: "signed-in" }}
        onSignOut={failingSignOut}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    rejectSignOut(new Error("network"));
    await waitFor(() => {
      expect(failingSignOut).toHaveBeenCalledTimes(1);
    });
    expect(readOnboardingFlowSession()).not.toBeNull();
    view.unmount();

    const signOut = vi.fn(() => Promise.resolve());
    render(
      <HostHarness
        account={{ email: "user@example.com", status: "signed-in" }}
        onSignOut={signOut}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(readOnboardingFlowSession()).toBeNull();
    });
    resetOnboardingFlowSessionForTests();
  });

  // ISS-11279 — the ambient bar, and the window in which it must stay shut.
  //
  // Drives the SNAPSHOT QUERY rather than the resolver, because the defect was
  // the host answering "no phase" with the wizard-exited branch: the desktop
  // startup pass reports `active` 350ms after boot, and with the run still being
  // read the bar drew itself in from the top over a dashboard whose takeover had
  // not painted its first screen. `onAnalysisBannerHeightChange` is what mounts
  // the bar at all (desktop is its only host), so it is supplied here.
  describe("the ambient analysis bar", () => {
    const STARTUP_PASS = {
      active: true,
      analyzed: 545,
      found: 7974,
      label: "Processing agent history",
      percent: 6,
    };

    function renderWithBar(
      snapshotQuery: Record<string, unknown>,
      props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>> = {},
      auth: StaticAuthOptions | null = null
    ) {
      mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue(snapshotQuery);
      const hostProps = {
        analysisBannerOverride: STARTUP_PASS,
        // Desktop, because the bar has no other host and because
        // `restoreOnboardingState` folds the desktop-only phases to Welcome for
        // a Web run — which would leave every case below on the same screen.
        desktopMode: true,
        host: OnboardingHost.Desktop,
        onAnalysisBannerHeightChange: reportBannerHeight,
        ...props,
      };
      if (auth === null) {
        renderHost(hostProps);
      } else {
        render(
          <AuthAdapterProvider adapter={createStaticAuthAdapter(auth)}>
            <HostHarness {...hostProps} />
          </AuthAdapterProvider>
        );
      }
      // `hidden: true` is load-bearing, not laxity: an open Radix dialog marks
      // every sibling `aria-hidden`, and the bar IS a sibling — so the default
      // query answers `null` for a bar that is on screen, and every
      // "stays shut" case below would pass with the defect still in place.
      return screen.queryByRole("status", { hidden: true });
    }

    it("stays shut while the run is still being read", () => {
      expect(
        renderWithBar({ data: undefined, isLoading: true, isPending: true })
      ).toBeNull();
    });

    // ISS-11279 follow-up. A query gated off until the identity resolves WILL
    // fire, so its run is unread even though nothing is in flight yet — this is
    // the desktop first launch the ticket was reported from, where the startup
    // pass goes active 350ms in while the auth bridge is still settling.
    it("stays shut while the identity has not resolved", () => {
      expect(
        renderWithBar(
          { data: undefined, isLoading: false, isPending: true },
          {},
          { isLoaded: false, orgId: null, userId: null }
        )
      ).toBeNull();
    });

    // The OTHER disabled query, and the opposite answer. A settled signed-out
    // guest never fires the snapshot, so `isPending` is true for the life of the
    // mount — reading that as unread shut the bar forever for exactly the reader
    // ISS-10492 built it for, which is what `guest-single-progress-surface`
    // caught. No server run is coming: that is `Absent`, and it shows.
    it("shows the host pass for a signed-out reader whose read can never fire", () => {
      const bar = renderWithBar(
        { data: undefined, isLoading: false, isPending: true },
        {},
        { isLoaded: true, orgId: null, userId: null }
      );
      expect(bar).not.toBeNull();
      expect(bar?.textContent).toContain(STARTUP_PASS.label);
    });

    // A SUPPLIED run reads too. The guest handoff reports `isLoading` with no
    // snapshot while its command is in flight, and a run being handed over is
    // not a run that does not exist.
    it("stays shut while a supplied run is still being read", () => {
      expect(
        renderWithBar(
          { data: undefined, isLoading: false, isPending: false },
          { run: { isLoading: true, postTransition: vi.fn(), snapshot: null } }
        )
      ).toBeNull();
    });

    it("shows the host pass once the run read has settled with no run", () => {
      // Read FAILED, or no run exists for this reader. ISS-10492 made this bar
      // the desktop's only startup-progress surface, so suppressing here would
      // leave an offline reader with no progress surface at all.
      const bar = renderWithBar({
        data: undefined,
        isLoading: false,
        isPending: false,
      });
      expect(bar).not.toBeNull();
      expect(bar?.textContent).toContain(STARTUP_PASS.label);
    });

    it("stays shut on the screen that asks for the analysis", () => {
      expect(
        renderWithBar({
          data: blockingSnapshot(OnboardingPhase.Welcome),
          isLoading: false,
          isPending: false,
        })
      ).toBeNull();
    });

    // The positive control for the two shut cases above: a run whose history
    // carries Discovery is past the screen that owns its own progress, so the
    // ambient bar is the reader's surface from here on.
    it("shows the host pass once the reader has stepped past discovery", () => {
      const bar = renderWithBar({
        data: blockingSnapshot(OnboardingPhase.SyncPolicy),
        isLoading: false,
        isPending: false,
      });
      expect(bar).not.toBeNull();
      expect(bar?.textContent).toContain(STARTUP_PASS.label);
    });
  });
});

/**
 * A stable reporter, which the bar's layout effect requires of every host — an
 * identity that changes every render re-arms it every render.
 */
const reportBannerHeight = () => undefined;

function renderHost(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>> = {}
) {
  return render(<HostHarness {...props} />);
}

/**
 * A loaded, signed-in session with no active organization: the only session the
 * create step is for (ISS-11090). Without an auth provider the answer is
 * unknown, and a run parked on create is shown the choose step instead.
 */
function renderHostWithNoOrganization(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>> = {}
) {
  return render(
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({
        isLoaded: true,
        orgId: null,
        userId: "user-a",
      })}
    >
      <HostHarness {...props} />
    </AuthAdapterProvider>
  );
}

function HostHarness(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>>
) {
  return (
    <GuidedOnboardingDialogHost
      analysisStarted={true}
      brand={<span>Closedloop.ai</span>}
      dashboardActive={false}
      desktopMode={false}
      host={OnboardingHost.Web}
      onBackFallback={vi.fn()}
      onDashboardAvailable={vi.fn()}
      organizationChosen
      organizationName="Example Organization"
      organizationSlug="example-organization"
      {...props}
    />
  );
}

function blockingSnapshot(
  phase: OnboardingPhase,
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: false,
      ...context,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: historyForPhase(phase),
      organizationEstablished: true,
      phase,
      resuming: false,
    }),
  };
}

function createChooseOrganizationSnapshot(): GuidedOnboardingSnapshot {
  return {
    ...blockingSnapshot(OnboardingPhase.ChooseOrganization, {
      membership: OrganizationMembership.ExistingMember,
    }),
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
      organizationEstablished: false,
      phase: OnboardingPhase.ChooseOrganization,
      resuming: false,
    }),
  };
}

function createOrganizationSnapshot(): GuidedOnboardingSnapshot {
  return {
    ...blockingSnapshot(OnboardingPhase.CreateOrganization, {
      membership: OrganizationMembership.FirstUser,
    }),
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
      organizationEstablished: false,
      phase: OnboardingPhase.CreateOrganization,
      resuming: false,
    }),
  };
}

function historyForPhase(phase: OnboardingPhase): OnboardingPhase[] {
  switch (phase) {
    case OnboardingPhase.SyncPolicy:
      return [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.CreateOrganization,
      ];
    case OnboardingPhase.DownloadDesktop:
      return [
        OnboardingPhase.Welcome,
        OnboardingPhase.Account,
        OnboardingPhase.CreateOrganization,
        OnboardingPhase.InviteTeam,
      ];
    default:
      return [OnboardingPhase.Welcome];
  }
}
